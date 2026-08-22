'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrepareHandler } = require('../src/prepare-route.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');

function makeResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

function makeBody(overrides = {}) {
    return {
        protocolVersion: 1,
        chat_completion_source: 'vertexai',
        model: 'gemini-2.5-pro',
        stream: true,
        tier: 'flex',
        paygoOnly: true,
        vertexai_auth_mode: 'full',
        vertexai_region: 'global',
        ...overrides,
    };
}

test('prepare synthesizes ST auth request and issues an opaque loopback ticket', async () => {
    const calls = [];
    const ticketStore = new TicketStore();
    const stRuntime = {
        async getGoogleApiConfig(request, model, endpoint) {
            calls.push({ request, model, endpoint });
            return {
                url: `https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/${model}:${endpoint}`,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private-google-token' },
            };
        },
    };
    try {
        const handler = createPrepareHandler({
            stRuntime,
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:54321' },
        });
        const response = makeResponse();
        await handler({ body: makeBody(), user: { directories: { root: 'private' } } }, response);

        assert.equal(response.statusCode, 200);
        assert.equal(response.body.ok, true);
        assert.match(response.body.proxyUrl, /^http:\/\/127\.0\.0\.1:54321\/proxy\//u);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].request.body, {
            api: 'vertexai',
            vertexai_auth_mode: 'full',
            vertexai_region: 'global',
        });
        assert.equal(Object.hasOwn(calls[0].request.body, 'reverse_proxy'), false);
        assert.equal(calls[0].endpoint, 'streamGenerateContent');

        const ticketData = ticketStore.consume(response.body.ticket, response.body.proxySecret);
        assert.equal(ticketData.targetUrl.endsWith('?alt=sse'), true);
        assert.equal(ticketData.headers['X-Vertex-AI-LLM-Request-Type'], 'shared');
        assert.equal(ticketData.headers['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
        assert.equal(ticketData.headers['X-Server-Timeout'], '1800');
        assert.equal(response.body.targetUrl, undefined);
    } finally {
        ticketStore.close();
    }
});

test('prepare converts authentication failures to a stable non-sensitive error', async () => {
    const ticketStore = new TicketStore();
    try {
        const handler = createPrepareHandler({
            stRuntime: { async getGoogleApiConfig() { throw new Error('private key contents'); } },
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
        });
        const response = makeResponse();
        await handler({ body: makeBody(), user: { directories: {} } }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.code, 'VERTEX_AUTH_CONFIGURATION_FAILED');
        assert.doesNotMatch(response.body.message, /private key/u);
    } finally {
        ticketStore.close();
    }
});

test('prepare does not issue a ticket after its authenticated client disconnects', async () => {
    const ticketStore = new TicketStore();
    try {
        const handler = createPrepareHandler({
            stRuntime: {
                async getGoogleApiConfig(_request, model, endpoint) {
                    return {
                        url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:${endpoint}`,
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'private' },
                    };
                },
            },
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
        });
        const response = makeResponse();
        response.destroyed = true;
        await handler({ body: makeBody(), user: { directories: {} }, aborted: false }, response);
        assert.equal(ticketStore.size, 0);
        assert.equal(response.body, undefined);
    } finally {
        ticketStore.close();
    }
});
