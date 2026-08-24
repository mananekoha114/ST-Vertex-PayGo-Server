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
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');

function createFakeUpstream(calls, { statusCode = 202, headers = { 'content-type': 'text/event-stream', 'x-request-id': 'safe-id' }, body = 'data: ok\n\n' } = {}) {
    return (target, options, callback) => {
        const request = new PassThrough();
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('finish', () => {
            calls.push({ target: target.toString(), options, body: Buffer.concat(chunks).toString('utf8') });
            const upstreamResponse = new PassThrough();
            upstreamResponse.statusCode = statusCode;
            upstreamResponse.statusMessage = 'Upstream';
            upstreamResponse.headers = headers;
            callback(upstreamResponse);
            upstreamResponse.end(body);
        });
        return request;
    };
}

function ticketPayload(overrides = {}) {
    return {
        targetUrl: 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer google-token',
            'X-Vertex-AI-LLM-Shared-Request-Type': 'flex',
            'X-Server-Timeout': '1800',
        },
        model: 'gemini-2.5-pro',
        stream: true,
        endpoint: 'streamGenerateContent',
        tier: 'flex',
        region: 'global',
        ...overrides,
    };
}

test('loopback proxy validates, consumes, forwards, and streams the raw response', async () => {
    const calls = [];
    const store = new TicketStore();
    const transport = createLoopbackTransport({ ticketStore: store, upstreamRequest: createFakeUpstream(calls) });
    await transport.start();
    try {
        const issued = store.create(ticketPayload());
        const response = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${issued.proxySecret}`,
            },
            body: '{"contents":[]}',
        });
        assert.equal(response.status, 202);
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.equal(response.headers.get('x-request-id'), 'safe-id');
        assert.equal(await response.text(), 'data: ok\n\n');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body, '{"contents":[]}');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer google-token');

        const replay = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` },
            body: '{}',
        });
        assert.equal(replay.status, 404);
        assert.equal((await replay.json()).code, 'INVALID_PROXY_TICKET');
        assert.equal(calls.length, 1);
    } finally {
        store.close();
        await transport.close();
    }
});

test('loopback proxy rejects mismatched suffix and invalid secret without forwarding', async () => {
    const calls = [];
    const store = new TicketStore();
    const transport = createLoopbackTransport({ ticketStore: store, upstreamRequest: createFakeUpstream(calls) });
    await transport.start();
    try {
        const issued = store.create(ticketPayload());
        const badSecret = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
            body: '{}',
        });
        assert.equal(badSecret.status, 401);

        const mismatch = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` },
            body: '{}',
        });
        assert.equal(mismatch.status, 409);
        assert.equal(store.size, 1);

        const validAfterMismatch = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` },
            body: '{}',
        });
        assert.equal(validAfterMismatch.status, 202);
        assert.equal(calls.length, 1);
    } finally {
        store.close();
        await transport.close();
    }
});

test('loopback proxy rejects redirects without exposing a followable Location', async () => {
    const calls = [];
    const store = new TicketStore();
    const transport = createLoopbackTransport({
        ticketStore: store,
        upstreamRequest: createFakeUpstream(calls, {
            statusCode: 302,
            headers: { location: 'https://not-followed.invalid/' },
            body: '',
        }),
    });
    await transport.start();
    try {
        const issued = store.create(ticketPayload());
        const response = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` },
            body: '{}',
        });
        assert.equal(response.status, 502);
        assert.equal(response.headers.get('location'), null);
        assert.equal((await response.json()).code, 'VERTEX_REDIRECT_REJECTED');
        assert.equal(calls.length, 1);
    } finally {
        store.close();
        await transport.close();
    }
});

test('loopback proxy enforces its independent request-body limit', async () => {
    const calls = [];
    const store = new TicketStore();
    const transport = createLoopbackTransport({
        ticketStore: store,
        upstreamRequest: createFakeUpstream(calls),
        maxBodyBytes: 4,
    });
    await transport.start();
    try {
        const issued = store.create(ticketPayload());
        const response = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` },
            body: '{"large":true}',
        });
        assert.equal(response.status, 413);
        assert.equal(calls.length, 0);
    } finally {
        store.close();
        await transport.close();
    }
});

test('loopback proxy applies a bounded upstream timeout longer than Flex server timeout', async () => {
    let configuredTimeout;
    const store = new TicketStore();
    const transport = createLoopbackTransport({
        ticketStore: store,
        upstreamTimeoutMs: 31 * 60_000,
        upstreamRequest() {
            const request = new PassThrough();
            request.setTimeout = (milliseconds, callback) => {
                configuredTimeout = milliseconds;
                setTimeout(callback, 5);
                return request;
            };
            return request;
        },
    });
    await transport.start();
    try {
        const issued = store.create(ticketPayload());
        const response = await fetch(`${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` },
            body: '{}',
        });
        assert.equal(configuredTimeout, 31 * 60_000);
        assert.equal(response.status, 504);
        assert.equal((await response.json()).code, 'VERTEX_UPSTREAM_TIMEOUT');
    } finally {
        store.close();
        await transport.close();
    }
});
