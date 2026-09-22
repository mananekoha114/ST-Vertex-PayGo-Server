/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const { createPrepareHandler } = require('../src/prepare-route.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');
const { validatePreparePayload } = require('../src/protocol.cjs');
const { prepareGoogleTarget } = require('../src/target-policy.cjs');

const model = 'gemini-2.5-pro';
const prepareBody = overrides => ({ protocolVersion: 2, chat_completion_source: 'makersuite', model, stream: true, tier: 'flex', paygoOnly: false, ...overrides });

test('AI Studio protocol accepts only Flex, independently of Vertex configuration', () => {
    const config = validatePreparePayload(prepareBody());
    assert.equal(config.source, 'makersuite');
    assert.equal(config.region, undefined);
    assert.equal(config.authMode, undefined);
    assert.equal(validatePreparePayload(prepareBody({ tier: 'standard' })).tier, 'standard');
    for (const overrides of [{ tier: 'priority' }, { paygoOnly: true }, { model: 'gemma-3' }, { chat_completion_source: 'custom' }, { reverse_proxy: 'https://bad.invalid' }]) {
        assert.throws(() => validatePreparePayload(prepareBody(overrides)));
    }
    for (const url of [
        `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:streamGenerateContent`,
        `https://generativelanguage.googleapis.com.evil.test/v1beta/models/${model}:streamGenerateContent`,
        `https://generativelanguage.googleapis.com/v1beta/models/wrong:streamGenerateContent`,
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=unexpected`,
    ]) {
        assert.throws(() => prepareGoogleTarget(url, config), { code: 'UNSAFE_GOOGLE_TARGET' });
    }
});

async function harness({ stream = true, statusCode = 200, maxBodyBytes } = {}) {
    const calls = [];
    const logs = [];
    const ticketStore = new TicketStore();
    const transport = createLoopbackTransport({
        ticketStore, maxBodyBytes,
        logStore: { server: (...entry) => logs.push(entry) },
        upstreamRequest(target, options, callback) {
            const request = new PassThrough();
            const chunks = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('finish', () => {
                calls.push({ target: String(target), options, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                const response = new PassThrough();
                response.statusCode = statusCode;
                response.headers = { 'content-type': stream ? 'text/event-stream' : 'application/json' };
                callback(response);
                response.end(stream ? 'data: {"text":"ok"}\n\n' : '{"text":"ok"}');
            });
            return request;
        },
    });
    await transport.start();
    const prepare = createPrepareHandler({
        ticketStore, loopbackTransport: transport,
        stRuntime: { async getGoogleApiConfig(request, requestedModel, endpoint) {
            assert.deepEqual(request.body, { api: 'makersuite' });
            assert.equal(requestedModel, model);
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}`,
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'real-google-key' },
            };
        } },
    });
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    return {
        calls, logs, ticketStore,
        async issue() {
            const response = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
            await prepare({ body: prepareBody({ stream }), user: { directories: { root: 'test-user' } } }, response);
            assert.equal(response.statusCode, 200);
            assert.doesNotMatch(JSON.stringify(response.body), /real-google-key|generativelanguage/u);
            const { proxyUrl, proxySecret } = response.body;
            // This is the actual native SillyTavern AI Studio URL shape.
            return `${proxyUrl}/v1beta/models/${model}:${endpoint}?key=${proxySecret}${stream ? '&alt=sse' : ''}`;
        },
        async close() { ticketStore.close(); await transport.close(); },
    };
}

for (const stream of [true, false]) {
    test(`AI Studio preparation and proxy preserve content and response with Flex (stream=${stream})`, async () => {
        const app = await harness({ stream });
        try {
            const url = await app.issue();
            const body = { contents: [{ parts: [{ text: '你好🌸' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }], generationConfig: { temperature: 0.7 }, cachedContent: 'cachedContents/example', service_tier: 'standard', serviceTier: 'priority' };
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal(response.status, 200);
            assert.equal(await response.text(), stream ? 'data: {"text":"ok"}\n\n' : '{"text":"ok"}');
            assert.equal(app.calls.length, 1);
            const call = app.calls[0];
            const { serviceTier, ...expected } = body;
            assert.deepEqual(call.body, { ...expected, service_tier: 'flex' });
            assert.equal(call.options.headers['x-goog-api-key'], 'real-google-key');
            assert.equal(call.options.headers['X-Server-Timeout'], '1800');
            assert.equal(Object.keys(call.options.headers).some(key => key.startsWith('X-Vertex')), false);
            assert.equal(new URL(call.target).search, stream ? '?alt=sse' : '');
            assert.doesNotMatch(JSON.stringify(app.logs), /real-google-key|你好|cachedContents|key=/u);
            const replay = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(replay.status, 404);
        } finally { await app.close(); }
    });
}

test('AI Studio proxy rejects wrong credentials, duplicate keys, provider/version and stream mismatches', async () => {
    const app = await harness();
    try {
        const url = await app.issue();
        for (const badUrl of [
            url.replace(/key=[^&]+/u, 'key=wrong'), url + '&key=duplicate', url + '&other=1',
            url.replace('/v1beta/models/', '/v1alpha/models/'), url.replace('&alt=sse', ''),
            url.replace('/v1beta/models/', '/v1/publishers/google/models/'),
        ]) {
            const response = await fetch(badUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.ok(response.status >= 400, badUrl);
        }
        assert.equal(app.calls.length, 0);
        assert.equal(app.ticketStore.size, 1);
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 200);
    } finally { await app.close(); }
});

test('AI Studio proxy rejects invalid and oversized streamed JSON without completing an upstream request', async () => {
    const app = await harness({ maxBodyBytes: 64 });
    try {
        for (const body of ['{broken', '[]', 'null', '"string"', '{"text":"' + 'a'.repeat(100) + '"}']) {
            const response = await fetch(await app.issue(), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: Readable.from([body.slice(0, 5), body.slice(5)].filter(Boolean)), duplex: 'half',
                signal: AbortSignal.timeout(2000),
            });
            assert.ok([400, 413].includes(response.status));
            await response.text();
        }
        assert.equal(app.calls.length, 0);
    } finally { await app.close(); }
});

test('AI Studio capacity errors are returned without retrying at Standard prices', async () => {
    const app = await harness({ statusCode: 503 });
    try {
        const response = await fetch(await app.issue(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 503);
        await response.text();
        assert.equal(app.calls.length, 1);
        assert.equal(app.calls[0].body.service_tier, 'flex');
    } finally { await app.close(); }
});
