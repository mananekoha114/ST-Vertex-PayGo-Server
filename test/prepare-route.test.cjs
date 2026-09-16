/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrepareHandler, resolveUserKey } = require('../src/prepare-route.cjs');
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

function captureLog(records) {
    return {
        server(level, event, context) { records.push({ level, event, context }); },
    };
}

test('explicit credential errors reach the caller and long directory identities remain isolated', async () => {
    const root = 'x'.repeat(1000);
    const owner = resolveUserKey({ directories: { root } });
    assert.ok(owner.length <= 512);
    assert.notEqual(owner, resolveUserKey({ directories: { root: `${root}y` } }));
    const ticketStore = new TicketStore();
    try {
        const handler = createPrepareHandler({ ticketStore, stRuntime: { getGoogleApiConfig: async () => {
            throw Object.assign(new Error('Explicit selection unsupported.'), { code: 'EXPLICIT_SECRET_UNSUPPORTED' });
        } } });
        const response = makeResponse();
        await handler({ body: makeBody({ secret_id: 'selected' }), user: { directories: { root } } }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.code, 'EXPLICIT_SECRET_UNSUPPORTED');
        assert.equal(ticketStore.pendingSize, 0);
    } finally { ticketStore.close(); }
});

test('prepare synthesizes ST auth request and issues an opaque loopback ticket', async () => {
    const calls = [];
    const logs = [];
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
            logStore: captureLog(logs),
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
        assert.deepEqual(logs.map(record => record.event), ['prepare_started', 'prepare_succeeded']);
        assert.equal(logs.at(-1).context.model, 'gemini-2.5-pro');
        assert.doesNotMatch(JSON.stringify(logs), /private-google-token|proxySecret|ticket/u);
    } finally {
        ticketStore.close();
    }
});

test('prepare converts authentication failures to a stable non-sensitive error', async () => {
    const ticketStore = new TicketStore();
    const logs = [];
    try {
        const handler = createPrepareHandler({
            stRuntime: { async getGoogleApiConfig() { throw new Error('private key contents'); } },
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
            logStore: captureLog(logs),
        });
        const response = makeResponse();
        await handler({ body: makeBody(), user: { directories: {} } }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.code, 'VERTEX_AUTH_CONFIGURATION_FAILED');
        assert.doesNotMatch(response.body.message, /private key/u);
        assert.equal(logs.at(-1).event, 'prepare_failed');
        assert.equal(logs.at(-1).context.errorCode, 'VERTEX_AUTH_CONFIGURATION_FAILED');
        assert.doesNotMatch(JSON.stringify(logs), /private key/u);
    } finally {
        ticketStore.close();
    }
});

test('prepare preserves safe explicit-secret configuration errors', async () => {
    const ticketStore = new TicketStore();
    try {
        const error = new Error('The requested Google AI Studio secret was not found.');
        error.code = 'EXPLICIT_SECRET_NOT_FOUND';
        const handler = createPrepareHandler({
            stRuntime: { async getGoogleApiConfig() { throw error; } },
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
        });
        const response = makeResponse();
        await handler({ body: makeBody({ chat_completion_source: 'makersuite', tier: 'flex', paygoOnly: false, secret_id: 'selected' }), user: { directories: {} } }, response);
        assert.equal(response.statusCode, 400);
        assert.equal(response.body.code, 'EXPLICIT_SECRET_NOT_FOUND');
        assert.match(response.body.message, /secret was not found/u);
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

test('prepare reserves per-user capacity before an async authentication lookup', async () => {
    const ticketStore = new TicketStore({ maxEntries: 8, maxEntriesPerUser: 1 });
    let releaseAuthentication;
    let authenticationCalls = 0;
    const authenticationReady = new Promise(resolve => { releaseAuthentication = resolve; });
    const handler = createPrepareHandler({
        stRuntime: {
            async getGoogleApiConfig() {
                authenticationCalls += 1;
                await authenticationReady;
                return {
                    url: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'private' },
                };
            },
        },
        ticketStore,
        loopbackTransport: { baseUrl: 'http://127.0.0.1:54321' },
    });
    const firstResponse = makeResponse();
    const firstRequest = { body: makeBody(), user: { directories: { root: 'user-a' } } };
    const first = handler(firstRequest, firstResponse);
    await new Promise(resolve => setImmediate(resolve));

    try {
        const secondResponse = makeResponse();
        await handler({ body: makeBody(), user: { directories: { root: 'user-a' } } }, secondResponse);
        assert.equal(secondResponse.statusCode, 429);
        assert.equal(secondResponse.body.code, 'USER_TICKET_CAPACITY_EXCEEDED');
        assert.equal(authenticationCalls, 1);

        releaseAuthentication();
        await first;
        assert.equal(firstResponse.statusCode, 200);
        assert.equal(ticketStore.size, 1);
    } finally {
        releaseAuthentication();
        ticketStore.close();
    }
});
