/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { MAX_SETTINGS_BYTES, effectiveBridgeTier } = require('../src/bridge-tier.cjs');
const vertex = { source: 'vertexai', model: 'gemini-future-pro', region: 'global', authMode: 'full', secretId: 'bound-key' };
const studio = { source: 'makersuite', model: 'gemini-future-pro' };
function manager() { return { code: 200, set() {}, status(code) { this.code = code; return this; }, json(value) { this.body = value; } }; }
async function fixture(t, { reply, timeoutMs, logs, readSavedSettings, ownerHandle = 'authenticated-alice' } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-tier-'));
    const calls = []; const records = []; let authCalls = 0;
    const bridge = createOpenAIBridge({ timeoutMs, bridgeLogStore: logs ? { append(_d, entry) { records.push(entry); } } : undefined,
        stRuntime: { ...(readSavedSettings ? { readSavedSettings } : {}), resolveOpenAIConnection(_r, connection) { return { connection }; }, async getOpenAIConfig(_r, connection, authenticate) {
            if (authenticate) authCalls++;
            return { target: connection.source === 'makersuite' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' : `https://aiplatform.googleapis.com/v1/projects/demo-project/locations/${connection.region}/endpoints/openapi/chat/completions`, headers: { Authorization: 'Bearer bound-credential' } };
        } }, upstreamRequest(target, options, callback) {
            const request = new PassThrough(); const chunks = [];
            request.on('data', chunk => chunks.push(chunk));
            request.on('finish', () => {
                const call = { target: new URL(target), options, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null }; calls.push(call);
                const result = reply?.(call) ?? { status: 200, body: { candidates: [{ content: { parts: [{ text: 'hello' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } } };
                if (result.pending) return;
                const response = new PassThrough(); response.statusCode = result.status; response.headers = result.headers ?? { 'content-type': 'application/json' };
                callback(response);
                if (result.parts) { response.write(result.parts[0]); setTimeout(() => response.end(result.parts[1]), 30); }
                else response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
            }); return request;
        },
    });
    const transport = createLoopbackTransport({ openaiBridge: bridge }); await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    t.after(async () => { bridge.close(); await transport.close(); await fs.rm(root, { recursive: true, force: true }); });
    const user = { user: { directories: { root }, profile: { handle: ownerHandle } } };
    return { bridge, calls, records, root, baseUrl: transport.baseUrl, authCalls: () => authCalls,
        async update(body) { const response = manager(); await bridge.update({ ...user, body }, response); return response; },
        async state() { const response = manager(); await bridge.get(user, response); return response.body; },
        send(key, payload = {}) { return fetch(`${transport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'question' }], ...payload }) }); },
        save(settings) { return fs.writeFile(path.join(root, 'settings.json'), JSON.stringify(settings)); },
    };
}
test('Vertex policy defaults, validation, legacy updates, and switching back to AI Studio', async t => {
    const f = await fixture(t);
    let response = await f.update({ enabled: true, connection: vertex }); assert.equal(response.code, 200);
    assert.equal(response.body.mode, 'openai'); assert.equal(response.body.effectiveTier, 'standard');
    for (const [body, code] of [[{ tier: 'flex' }, 'BRIDGE_OPENAI_FLEX_UNSUPPORTED'], [{ mode: null }, 'INVALID_BRIDGE_POLICY'], [{ mode: 'gemini', tier: 'priority', connection: { ...vertex, region: 'us-central1' } }, 'BRIDGE_TIER_REQUIRES_GLOBAL']]) {
        response = await f.update({ enabled: true, ...body }); assert.equal(response.body.code, code);
    }
    response = await f.update({ enabled: true, mode: 'gemini', tier: 'flex' }); assert.equal(response.code, 200);
    const key = response.body.apiKey;
    response = await f.update({ enabled: true, rotateKey: true }); assert.equal(response.body.mode, 'gemini'); assert.equal(response.body.tier, 'flex'); assert.notEqual(response.body.apiKey, key);
    response = await f.update({ enabled: true, connection: studio }); assert.equal(response.code, 200); assert.equal(Object.hasOwn(response.body, 'mode'), false);
    const completion = await f.send(response.body.apiKey, { service_tier: 'flex' }); assert.equal(completion.status, 200); await completion.text();
    assert.equal(f.calls[0].body.service_tier, 'flex'); assert.equal(f.calls[0].options.headers['X-Server-Timeout'], undefined);
    response = await f.update({ enabled: true, mode: 'gemini' }); assert.equal(response.body.code, 'VERTEX_BRIDGE_POLICY_REQUIRED');
});
test('independent Vertex native priority uses policy headers and rejects client tier overrides', async t => {
    const f = await fixture(t, { reply: () => ({ status: 200, body: { choices: [] } }) });
    const state = (await f.update({ enabled: true, connection: vertex, tier: 'priority' })).body;
    for (const key of ['service_tier', 'serviceTier']) { const response = await f.send(state.apiKey, { [key]: 'standard' }); assert.equal(response.status, 400); await response.text(); }
    assert.equal(f.authCalls(), 0);
    const response = await f.send(state.apiKey); assert.equal(response.status, 200); await response.text();
    assert.equal(f.calls[0].target.pathname.endsWith('/endpoints/openapi/chat/completions'), true);
    assert.equal(f.calls[0].options.headers['X-Vertex-AI-LLM-Shared-Request-Type'], 'priority');
});
test('Gemini gateway derives fixed target, converts JSON, adds Flex headers and logs both protocols', async t => {
    const f = await fixture(t, { logs: true });
    const state = (await f.update({ enabled: true, connection: vertex, mode: 'gemini', tier: 'flex' })).body;
    const response = await f.send(state.apiKey, { model: 'gemini-next-preview' }); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.choices[0].message.content, 'hello');
    assert.equal(f.calls[0].target.pathname, '/v1/projects/demo-project/locations/global/publishers/google/models/gemini-next-preview:generateContent');
    assert.equal(f.calls[0].options.headers.Authorization, 'Bearer bound-credential');
    assert.equal(f.calls[0].options.headers['X-Server-Timeout'], '1800');
    assert.equal(f.calls[0].options.headers['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
    assert.equal(f.calls[0].body.contents[0].parts[0].text, 'question');
    for (let i = 0; i < 100 && !f.records.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.parse(f.records[0].forwardedBody).contents[0].role, 'user');
    assert.equal(JSON.parse(f.records[0].upstreamResponseBody).candidates[0].content.parts[0].text, 'hello');
    assert.equal(JSON.parse(f.records[0].responseBody).object, 'chat.completion');
});
test('follow resolves saved main settings per request and profile tier takes precedence without changing binding', async t => {
    const f = await fixture(t);
    const initial = await f.update({ enabled: true, connection: vertex, mode: 'gemini', tierSource: 'follow' });
    assert.equal(initial.body.effectiveTier, null); assert.equal(typeof initial.body.tierError, 'string');
    const saved = { main_api: 'openai', oai_settings: { chat_completion_source: 'vertexai', extensions: { 'vertex-paygo': { tier: 'flex' } } } };
    await f.save(saved); assert.equal((await f.state()).effectiveTier, 'flex');
    let response = await f.send(initial.body.apiKey); assert.equal(response.status, 200); await response.text();
    saved.extension_settings = { connectionManager: { selectedProfile: 'p', profiles: [{ id: 'p', mode: 'cc', api: 'vertexai', 'vertex-paygo': { tier: 'priority', paygoOnly: true } }] } };
    await f.save(saved); response = await f.send(initial.body.apiKey); assert.equal(response.status, 200); await response.text();
    assert.equal(f.calls[1].options.headers['X-Vertex-AI-LLM-Shared-Request-Type'], 'priority'); assert.equal(f.calls[1].options.headers['X-Vertex-AI-LLM-Request-Type'], 'shared');
    assert.deepEqual((await f.state()).connection, vertex);
    saved.oai_settings.chat_completion_source = 'makersuite'; await f.save(saved);
    response = await f.send(initial.body.apiKey); assert.equal(response.status, 409); await response.text(); assert.equal(f.calls.length, 2);
    assert.equal((await f.state()).effectiveTier, null);
});
test('Gemini streaming gateway converts SSE and sends include-usage with the fixed stream URL', async t => {
    const raw = `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'stream hello' }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } })}\n\n`;
    const f = await fixture(t, { reply: () => ({ status: 200, body: raw }), logs: true });
    const state = (await f.update({ enabled: true, connection: vertex, mode: 'gemini' })).body;
    const response = await f.send(state.apiKey, { stream: true, stream_options: { include_usage: true } });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text(); assert.match(text, /stream hello/u); assert.match(text, /"total_tokens":3/u); assert.match(text, /data: \[DONE\]/u);
    assert.equal(f.calls[0].target.pathname.endsWith(':streamGenerateContent'), true); assert.equal(f.calls[0].target.search, '?alt=sse');
});
test('follow cannot downgrade invalid/oversized saved state and native Flex remains blocked', async t => {
    const f = await fixture(t);
    const state = (await f.update({ enabled: true, connection: vertex, tierSource: 'follow' })).body;
    await f.save({ main_api: 'openai', oai_settings: { chat_completion_source: 'vertexai', extensions: { 'vertex-paygo': { tier: 'flex' } } } });
    let response = await f.send(state.apiKey); assert.equal((await response.json()).error.code, 'BRIDGE_OPENAI_FLEX_UNSUPPORTED');
    await fs.writeFile(path.join(f.root, 'settings.json'), ' '.repeat(MAX_SETTINGS_BYTES + 1));
    response = await f.send(state.apiKey); assert.equal((await response.json()).error.code, 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE');
    assert.equal(f.authCalls(), 0); assert.equal(f.calls.length, 0);
});
test('gateway keeps provider errors and redirects explicit and respects deadline override for Flex', async t => {
    for (const reply of [{ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'quota for bound-credential' } } }, { status: 302, body: {} }, { pending: true }]) {
        const f = await fixture(t, { reply: () => reply, timeoutMs: 25 });
        const state = (await f.update({ enabled: true, connection: vertex, mode: 'gemini', tier: 'flex' })).body;
        const response = await f.send(state.apiKey); assert.equal(response.status, reply.pending ? 504 : reply.status === 302 ? 502 : 429);
        const result = await response.json(); assert.ok(result.error);
        if (reply.status === 429) { assert.equal(result.error.message, 'quota for [redacted]'); assert.equal(response.headers.get('retry-after'), '7'); }
    }
});
test('gateway invalid JSON fails before headers; emitted SSE is interrupted without a success terminator', async t => {
    const invalid = await fixture(t, { reply: () => ({ status: 200, body: 'not json' }) });
    const state = (await invalid.update({ enabled: true, connection: vertex, mode: 'gemini' })).body;
    const response = await invalid.send(state.apiKey); assert.equal(response.status, 502);
    assert.equal(response.headers.get('content-type'), 'application/json'); assert.ok((await response.json()).error);
    const first = `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial answer' }] } }] })}\n\n`;
    const streaming = await fixture(t, { reply: () => ({ status: 200, parts: [first, 'data: malformed\n\n'] }) });
    const streamState = (await streaming.update({ enabled: true, connection: vertex, mode: 'gemini' })).body;
    const result = await new Promise((resolve, reject) => {
        const request = http.request(`${streaming.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${streamState.apiKey}`, 'Content-Type': 'application/json' } }, source => {
            let body = ''; let aborted = false; let ended = false;
            source.on('data', chunk => { body += chunk; }); source.on('error', () => {});
            source.once('aborted', () => { aborted = true; }); source.once('end', () => { ended = true; });
            source.once('close', () => resolve({ status: source.statusCode, body, aborted, ended }));
        });
        request.once('error', reject); request.end('{"messages":[{"role":"user","content":"hello"}],"stream":true}');
    });
    assert.equal(result.status, 200); assert.match(result.body, /partial answer/u);
    assert.equal(result.aborted, true); assert.equal(result.ended, false); assert.doesNotMatch(result.body, /\[DONE\]/u);
});
test('repository-backed follow uses its authenticated owner and never falls back to a stale file', async t => {
    const owners = []; let storedTier = 'priority'; let unavailable = false;
    const f = await fixture(t, { readSavedSettings: async handle => {
        owners.push(handle);
        if (unavailable) throw new Error('Database credentials must not escape');
        return { main_api: 'openai', oai_settings: { chat_completion_source: 'vertexai', extensions: { 'vertex-paygo': { tier: storedTier } } } };
    } });
    await f.save({ main_api: 'openai', oai_settings: { chat_completion_source: 'vertexai', extensions: { 'vertex-paygo': { tier: 'standard' } } } });
    const state = (await f.update({ enabled: true, connection: vertex, mode: 'gemini', tierSource: 'follow' })).body;
    assert.equal(state.effectiveTier, 'priority'); assert.equal(Object.hasOwn(state, 'ownerHandle'), false);
    let response = await f.send(state.apiKey); assert.equal(response.status, 200); await response.text();
    assert.equal(f.calls[0].options.headers['X-Vertex-AI-LLM-Shared-Request-Type'], 'priority');
    storedTier = 'flex'; response = await f.send(state.apiKey); assert.equal(response.status, 200); await response.text();
    assert.equal(f.calls[1].options.headers['X-Vertex-AI-LLM-Shared-Request-Type'], 'flex');
    assert.ok(owners.every(handle => handle === 'authenticated-alice'));
    unavailable = true; response = await f.send(state.apiKey); assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE'); assert.equal(f.calls.length, 2);
    const unreadable = await f.state(); assert.equal(unreadable.effectiveTier, null); assert.doesNotMatch(unreadable.tierError, /Database credentials/u);
});
test('repository follow enforces the same settings byte bound as file follow', async t => {
    const f = await fixture(t, { readSavedSettings: async () => ({ excessive: 'x'.repeat(MAX_SETTINGS_BYTES) }) });
    const state = (await f.update({ enabled: true, connection: vertex, mode: 'gemini', tierSource: 'follow' })).body;
    assert.equal(state.effectiveTier, null);
    const response = await f.send(state.apiKey); assert.equal(response.status, 409); await response.text(); assert.equal(f.calls.length, 0);
});
