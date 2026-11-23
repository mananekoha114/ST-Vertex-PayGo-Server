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
const { PassThrough } = require('node:stream');
const { PluginError } = require('../src/errors.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
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
        protocolVersion: 3,
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
        server(level, event, context, options) { records.push({ level, event, context, options }); },
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
        // Frontends check this list before retargeting a Gemini 4 request.
        assert.deepEqual(response.body.nativeGemini4Models, ['gemini-4-neon', 'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-argon-cyber-permissive']);
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
        await handler({ body: makeBody(), user: { directories: { root: 'test-user' } } }, response);
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
        await handler({ body: makeBody({ chat_completion_source: 'makersuite', tier: 'flex', paygoOnly: false, secret_id: 'selected' }), user: { directories: { root: 'test-user' } } }, response);
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
        await handler({ body: makeBody(), user: { directories: { root: 'test-user' } }, aborted: false }, response);
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

test('prepare without usageChatId proxies without creating an unreachable usage record', async () => {
    const ticketStore = new TicketStore();
    let createCalls = 0;
    try {
        const handler = createPrepareHandler({
            ticketStore,
            usageStore: { create() { createCalls += 1; throw new Error('must not be called'); } },
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
            stRuntime: { async getGoogleApiConfig(_request, model, endpoint) {
                return {
                    url: `https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/${model}:${endpoint}`,
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private' },
                };
            } },
        });
        const response = makeResponse();
        await handler({ body: makeBody(), user: { directories: { root: 'test-user' } } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.usageId, null);
        assert.equal(createCalls, 0);
        const ticket = ticketStore.consume(response.body.ticket, response.body.proxySecret);
        assert.equal(ticket.usageReference, null);
    } finally { ticketStore.close(); }
});

test('usage ledger creation failure does not block proxy preparation', async () => {
    const ticketStore = new TicketStore();
    try {
        const handler = createPrepareHandler({
            ticketStore,
            usageStore: { create() { const error = new Error('disk unavailable'); error.code = 'EIO'; throw error; } },
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
            stRuntime: { async getGoogleApiConfig(_request, model, endpoint) {
                return {
                    url: `https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/${model}:${endpoint}`,
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private' },
                };
            } },
        });
        const response = makeResponse();
        await handler({ body: makeBody({ usageChatId: 'chat-write-failure' }), user: { directories: { root: 'test-user' } } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.usageId, null);
    } finally { ticketStore.close(); }
});

test('prepare preserves granular OAuth PluginErrors (5xx, 429, 400) and logs 5xx at normal priority', async () => {
    const cases = [
        new PluginError(500, 'VERTEX_OAUTH_UPSTREAM_ERROR', 'Google OAuth or the network proxy returned HTTP 500.', {
            details: { upstreamStatus: 500 },
        }),
        new PluginError(504, 'VERTEX_OAUTH_TIMEOUT', 'Timed out while requesting a Google OAuth access token.', {
            details: { networkCode: 'ETIMEDOUT' },
        }),
        new PluginError(429, 'VERTEX_OAUTH_RATE_LIMITED', 'Google OAuth rate-limited the access token request.', {
            details: { upstreamStatus: 429 },
        }),
        new PluginError(400, 'VERTEX_OAUTH_REJECTED', 'Google OAuth rejected the service account credentials (invalid_grant).', {
            details: { upstreamStatus: 401, oauthError: 'invalid_grant' },
        }),
    ];

    for (const expected of cases) {
        const ticketStore = new TicketStore();
        const logs = [];
        try {
            const handler = createPrepareHandler({
                stRuntime: { async getGoogleApiConfig() { throw expected; } },
                ticketStore,
                loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
                logStore: captureLog(logs),
            });
            const response = makeResponse();
            await handler({ body: makeBody(), user: { directories: { root: 'test-user' } } }, response);
            assert.equal(response.statusCode, expected.status);
            assert.equal(response.body.code, expected.code);
            assert.deepEqual(response.body.details, expected.details);
            const failureLog = logs.at(-1);
            assert.equal(failureLog.event, 'prepare_failed');
            assert.equal(failureLog.options?.priority, expected.status >= 500 ? 'normal' : 'low');
            assert.equal(failureLog.context.errorCode, expected.code);
            assert.equal(failureLog.context.statusCode, expected.status);
        } finally {
            ticketStore.close();
        }
    }
});

test('downstream Vertex HTTP 401 evicts the ticket OAuth cache key without exposing oauthCacheKey to the client', async () => {
    const ticketStore = new TicketStore();
    const invalidatedKeys = [];
    const upstreamRequest = (_target, _options, onResponse) => {
        const outgoing = new PassThrough();
        outgoing.setTimeout = () => outgoing;
        outgoing.once('finish', () => {
            const incoming = new PassThrough();
            incoming.statusCode = 401;
            incoming.headers = { 'content-type': 'application/json' };
            onResponse(incoming);
            incoming.end(JSON.stringify({ error: { code: 401, message: 'Token revoked' } }));
        });
        return outgoing;
    };
    const loopbackTransport = createLoopbackTransport({
        ticketStore,
        upstreamRequest,
        onUpstreamUnauthorized: key => invalidatedKeys.push(key),
    });
    await loopbackTransport.start();

    try {
        const handler = createPrepareHandler({
            stRuntime: {
                async getGoogleApiConfig(_request, model, endpoint) {
                    return {
                        url: `https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/${model}:${endpoint}`,
                        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer cached-access-token' },
                        oauthCacheKey: 'cache-key-sha256-demo',
                    };
                },
            },
            ticketStore,
            loopbackTransport,
        });
        const prepared = makeResponse();
        await handler({ body: makeBody({ stream: false }), user: { directories: { root: 'test-user' } } }, prepared);
        assert.equal(prepared.statusCode, 200);
        assert.equal(Object.hasOwn(prepared.body, 'oauthCacheKey'), false);

        const proxyResponse = await fetch(
            `${prepared.body.proxyUrl}/v1/publishers/google/models/gemini-2.5-pro:generateContent`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${prepared.body.proxySecret}`,
                },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] }),
            },
        );
        assert.equal(proxyResponse.status, 401);
        assert.deepEqual(invalidatedKeys, ['cache-key-sha256-demo']);
    } finally {
        await loopbackTransport.close();
        ticketStore.close();
    }
});

test('prepare forwards makersuite base_url while requiring authenticated credentials and extracting proxyKey', async () => {
    const ticketStore = new TicketStore();
    const calls = [];
    try {
        const handler = createPrepareHandler({
            stRuntime: {
                async getGoogleApiConfig(request, model, endpoint) {
                    calls.push(request.body);
                    return {
                        url: `${request.body.base_url}/v1beta/models/${model}:${endpoint}`,
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'makersuite-secret-key' },
                    };
                },
            },
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:54321' },
        });
        const response = makeResponse();
        await handler({
            body: makeBody({
                chat_completion_source: 'makersuite',
                model: 'Gemini-2.5-Pro',
                tier: 'standard',
                paygoOnly: false,
                stream: false,
                base_url: 'https://custom.example/api///',
            }),
            user: { directories: { root: 'test-user' } },
        }, response);

        assert.equal(response.statusCode, 200);
        assert.deepEqual(calls, [{ api: 'makersuite', base_url: 'https://custom.example/api' }]);
        const ticket = ticketStore.consume(response.body.ticket, response.body.proxySecret);
        assert.equal(ticket.targetUrl, 'https://custom.example/api/v1beta/models/Gemini-2.5-Pro:generateContent');
        assert.equal(ticket.reverseProxy, 'https://custom.example/api');
        assert.equal(ticket.proxyKey, 'makersuite-secret-key');
        assert.equal(ticket.headers['x-goog-api-key'], undefined);

        // base_url must NOT allow unauthenticated upstream headers.
        const unauthHandler = createPrepareHandler({
            stRuntime: {
                async getGoogleApiConfig(request, model, endpoint) {
                    return {
                        url: `${request.body.base_url}/v1beta/models/${model}:${endpoint}`,
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '' },
                    };
                },
            },
            ticketStore,
            loopbackTransport: { baseUrl: 'http://127.0.0.1:54321' },
        });
        const unauthRes = makeResponse();
        await unauthHandler({
            body: makeBody({
                chat_completion_source: 'makersuite',
                tier: 'standard',
                paygoOnly: false,
                stream: false,
                base_url: 'https://custom.example/api',
            }),
            user: { directories: { root: 'test-user' } },
        }, unauthRes);
        assert.equal(unauthRes.statusCode, 500);
        assert.equal(unauthRes.body.code, 'UNSAFE_GOOGLE_HEADERS');
    } finally {
        ticketStore.close();
    }
});

test('prepare abort releases reservation and does not create an orphan usage record', async () => {
    const ticketStore = new TicketStore();
    let usageCreates = 0;
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
            usageStore: { create() { usageCreates += 1; return { file: 'x', id: 'orphan' }; } },
            loopbackTransport: { baseUrl: 'http://127.0.0.1:1' },
        });
        const response = makeResponse();
        await handler({
            body: makeBody({ usageChatId: 'chat-aborted' }),
            user: { directories: { root: 'test-user' } },
            aborted: true,
        }, response);
        assert.equal(ticketStore.size, 0);
        assert.equal(ticketStore.pendingSize, 0);
        assert.equal(usageCreates, 0);
        assert.equal(response.body, undefined);
    } finally {
        ticketStore.close();
    }
});
