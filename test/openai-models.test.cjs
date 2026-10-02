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
const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { normalizeModel } = require('../src/openai-models.cjs');

test('catalog model normalization rejects spoofed prefixes and only filters excluded name tokens', () => {
    assert.equal(normalizeModel('google/google/gemini-2.5-pro', 'makersuite'), null);
    assert.equal(normalizeModel('gemini-deliver-preview', 'makersuite'), 'gemini-deliver-preview');
    assert.equal(normalizeModel('gemini-2.5-flash-native-audio-preview', 'vertexai'), null);
    assert.equal(normalizeModel('publishers/google/models/gemini-2.5-pro@001', 'vertexai'), null);
});

async function fixture(source, handler, options = {}) {
    const calls = [];
    const connection = source === 'vertexai' ? { source, model: 'gemini-2.5-pro', authMode: 'full', region: 'us-central1' } : { source, model: 'gemini-2.5-flash' };
    const target = source === 'vertexai' ? 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/endpoints/openapi/chat/completions' : 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    const bridge = createOpenAIBridge({ ...options, stRuntime: { resolveOpenAIConnection: (_r, connection) => ({ connection }), async getOpenAIConfig() { return { target, headers: { Authorization: 'Bearer google-secret' } }; } }, upstreamRequest(target, requestOptions, callback) {
        const request = new PassThrough(); const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('finish', () => {
            const call = { target: new URL(target), options: requestOptions, body: Buffer.concat(chunks).toString() }; calls.push(call);
            const reply = handler(call, calls.length);
            if (!reply) return;
            const response = new PassThrough(); response.statusCode = reply.status || 200; response.headers = reply.headers || {};
            callback(response); response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        });
        return request;
    } });
    const transport = createLoopbackTransport({ openaiBridge: bridge }); await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    const manager = { status(code) { this.code = code; return this; }, set() {}, json(body) { this.body = body; } };
    const user = { user: { directories: { root: 'models-user' } } };
    await bridge.update({ ...user, body: { enabled: true, connection } }, manager);
    const headers = { Authorization: `Bearer ${manager.body.apiKey}` };
    return { bridge, transport, calls, user, manager, headers, url: `${transport.baseUrl}/openai/v1`, async close() { bridge.close(); await transport.close(); } };
}

test('AI Studio discovers fresh OAI catalogs and forwards discovered Gemini models unchanged', async () => {
    const f = await fixture('makersuite', call => ({ body: call.options.method === 'GET' ? { data: [{ id: 'gemini-3.1-pro-preview' }, { id: 'google/gemini-3.1-pro-preview' }, { id: 'gemini-embedding-001' }, { id: 'other-model' }] } : { choices: [] } }));
    try {
        for (let i = 0; i < 2; i++) {
            const response = await fetch(`${f.url}/models`, { headers: f.headers }); assert.equal(response.status, 200);
            assert.deepEqual((await response.json()).data.map(x => x.id), ['st-current', 'gemini-2.5-flash', 'gemini-3.1-pro-preview']);
        }
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[0].target.href, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
        assert.equal(f.calls[0].options.headers.Authorization, 'Bearer google-secret');
        assert.equal(f.calls[0].body, '');
        const completion = await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'high' }) });
        assert.equal(completion.status, 200);
        assert.equal(f.calls[2].target.pathname, '/v1beta/openai/chat/completions');
        assert.equal(JSON.parse(f.calls[2].body).model, 'gemini-3.1-pro-preview');
        assert.equal(JSON.parse(f.calls[2].body).reasoning_effort, 'high');
    } finally { await f.close(); }
});

test('Vertex publisher discovery uses fixed regional URL, pagination and normalized names only', async () => {
    const f = await fixture('vertexai', (_call, page) => ({ body: page === 1 ? { publisherModels: [{ name: 'publishers/google/models/gemini-3.1-pro-preview', versionId: '999' }, { name: 'publishers/google/models/gemini-2.5-pro' }], nextPageToken: 'opaque?&token' } : { publisherModels: [{ name: 'publishers/google/models/gemini-3.1-pro-preview', versionId: '888' }, { name: 'publishers/google/models/gemini-2.5-flash-live' }, { name: 'publishers/google/models/imagen-4' }] } }));
    try {
        const response = await fetch(`${f.url}/models`, { headers: f.headers }); assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).data.map(x => x.id), ['st-current', 'google/gemini-2.5-pro', 'google/gemini-3.1-pro-preview']);
        assert.equal(f.calls.length, 2);
        for (const call of f.calls) {
            assert.equal(call.target.origin, 'https://us-central1-aiplatform.googleapis.com');
            assert.equal(call.target.pathname, '/v1beta1/publishers/google/models');
            assert.equal(call.target.searchParams.get('view'), 'PUBLISHER_MODEL_VIEW_FULL');
            assert.equal(call.target.searchParams.get('listAllVersions'), 'true');
            assert.equal(call.target.searchParams.get('pageSize'), '100');
            assert.equal(call.options.headers['x-goog-user-project'], undefined);
        }
        assert.equal(f.calls[1].target.searchParams.get('pageToken'), 'opaque?&token');
    } finally { await f.close(); }
});

test('discovery errors never silently replace the provider catalog with aliases', async () => {
    for (const [source, reply, expected] of [
        ['makersuite', { status: 429, body: {} }, 429],
        ['makersuite', { status: 302, body: {} }, 502],
        ['makersuite', { body: 'not json' }, 502],
        ['makersuite', { body: {} }, 502],
        ['makersuite', { body: 'x'.repeat(8 * 1024 * 1024 + 1) }, 502],
        ['vertexai', { body: { publisherModels: [], nextPageToken: 'repeated' } }, 502],
        ['vertexai', { body: { publisherModels: [], nextPageToken: false } }, 502],
        ['vertexai', { body: { publisherModels: [], nextPageToken: 0 } }, 502],
    ]) {
        const f = await fixture(source, () => reply);
        try { const response = await fetch(`${f.url}/models`, { headers: f.headers }); assert.equal(response.status, expected); assert.ok((await response.json()).error); } finally { await f.close(); }
    }
});

test('model discovery preserves bounded provider error details without credentials', async () => {
    const f = await fixture('makersuite', () => ({ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Quota exhausted for google-secret' } } }));
    try {
        const response = await fetch(`${f.url}/models`, { headers: f.headers });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '7');
        assert.equal((await response.json()).error.message, 'Quota exhausted for [redacted]');
    } finally { await f.close(); }
});

test('model discovery shares concurrency, timeout and revocation controls with generation', async () => {
    const f = await fixture('makersuite', () => null, { maxGlobal: 1, timeoutMs: 60 });
    try {
        const pending = fetch(`${f.url}/models`, { headers: f.headers });
        while (!f.calls.length) await new Promise(resolve => setTimeout(resolve, 2));
        assert.equal((await fetch(`${f.url}/models`, { headers: f.headers })).status, 429);
        assert.equal((await fetch(`${f.url}/chat/completions`, { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 429);
        assert.equal((await pending).status, 504);
        const revoked = fetch(`${f.url}/models`, { headers: f.headers }).catch(cause => cause);
        while (f.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 2));
        await f.bridge.update({ ...f.user, body: { enabled: false } }, f.manager);
        assert.ok((await revoked) instanceof Error);
        assert.equal((await fetch(`${f.url}/models`, { headers: f.headers })).status, 401);
    } finally { await f.close(); }
});

test('publisher discovery fails at its pagination limit instead of truncating', async () => {
    const f = await fixture('vertexai', (_call, page) => ({ body: { publisherModels: [], nextPageToken: `page-${page}` } }));
    try {
        const response = await fetch(`${f.url}/models`, { headers: f.headers });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).error.code, 'GOOGLE_MODEL_PAGE_LIMIT');
        assert.equal(f.calls.length, 100);
    } finally { await f.close(); }
});
