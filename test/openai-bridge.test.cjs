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
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');

function managerResponse() {
    return { code: 200, status(value) { this.code = value; return this; }, set() { return this; }, json(value) { this.body = value; return this; } };
}
function user(root) { return { user: { directories: { root } } }; }
async function until(predicate) {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Timed out waiting for the expected bridge state');
}
function fakeGoogle(calls, reply = {}) {
    return (target, options, callback) => {
        const request = new PassThrough();
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('finish', () => {
            if (options.method === 'GET') {
                const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'application/json' };
                callback(response); response.end('{"object":"list","data":[{"id":"gemini-2.5-flash"}]}'); return;
            }
            calls.push({ target: String(target), options, body: JSON.parse(Buffer.concat(chunks).toString()) });
            const response = new PassThrough();
            response.statusCode = reply.status || 200;
            response.headers = reply.headers || { 'content-type': 'application/json', 'set-cookie': 'bad=1' };
            callback(response);
            response.end(reply.body || '{"choices":[],"usage":{"total_tokens":1}}');
        });
        request.setTimeout = () => request;
        return request;
    };
}

test('timed-out authentication retains global and user capacity across key rotation', async () => {
    for (const limits of [{ maxGlobal: 1, maxPerUser: 4 }, { maxGlobal: 4, maxPerUser: 1 }]) {
        let pending = 0; let release; let blocked = true;
        const gate = new Promise(resolve => { release = resolve; });
        const calls = [];
        const bridge = createOpenAIBridge({ ...limits, timeoutMs: 30, upstreamRequest: fakeGoogle(calls), stRuntime: {
            resolveOpenAIConnection: (_request, connection) => ({ connection }),
            async getOpenAIConfig(_request, _connection, authenticate) {
                if (authenticate && blocked) { pending++; try { await gate; } finally { pending--; } }
                return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer fake-google' } };
            },
        } });
        const transport = createLoopbackTransport({ openaiBridge: bridge });
        await transport.start(); bridge.setBaseUrl(transport.baseUrl);
        try {
            const enabled = managerResponse();
            await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
            const get = key => fetch(`${transport.baseUrl}/openai/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
            const timed = await get(enabled.body.apiKey); assert.equal(timed.status, 504); await timed.text();
            assert.equal(pending, 1);
            for (let index = 0; index < 3; index++) {
                const busy = await get(enabled.body.apiKey); assert.equal(busy.status, 429); await busy.text();
            }
            const rotated = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, rotateKey: true } }, rotated);
            const busy = await get(rotated.body.apiKey); assert.equal(busy.status, 429); await busy.text();
            assert.equal(pending, 1);
            blocked = false; release(); await until(() => pending === 0);
            const next = await get(rotated.body.apiKey); assert.equal(next.status, 200); await next.text();
            assert.equal(calls.length, 0);
        } finally { release(); bridge.close(); await transport.close(); }
    }
});

test('real truncated HTTP upstream fails discovery and aborts streamed completions', async () => {
    const source = http.createServer((request, response) => {
        request.resume();
        response.writeHead(200, { 'Content-Type': request.method === 'GET' ? 'application/json' : 'text/event-stream', 'Content-Length': '1000' });
        response.write(request.method === 'GET' ? '{"data":[' : 'data: {"partial":true}\n\n');
        setTimeout(() => response.destroy(), 30);
    });
    await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
    const bridge = createOpenAIBridge({ timeoutMs: 1000, stRuntime: {
        resolveOpenAIConnection: (_request, connection) => ({ connection }),
        async getOpenAIConfig() { return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer fake-google' } }; },
    }, upstreamRequest(_target, options, callback) { return http.request(`http://127.0.0.1:${source.address().port}`, options, callback); } });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        const headers = { Authorization: `Bearer ${enabled.body.apiKey}` };
        const models = await fetch(`${transport.baseUrl}/openai/v1/models`, { headers });
        assert.equal(models.status, 502); assert.equal((await models.json()).error.code, 'GOOGLE_UPSTREAM_FAILED');
        const completion = await new Promise((resolve, reject) => {
            const request = http.request(`${transport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } }, response => {
                let aborted = false; let ended = false;
                response.resume();
                response.once('aborted', () => { aborted = true; });
                response.once('end', () => { ended = true; });
                response.on('error', () => {});
                response.once('close', () => resolve({ status: response.statusCode, aborted, ended }));
            });
            request.once('error', reject);
            request.end('{"messages":[{"role":"user","content":"hello"}],"stream":true}');
        });
        assert.deepEqual(completion, { status: 200, aborted: true, ended: false });
    } finally { bridge.close(); await transport.close(); source.closeAllConnections(); await new Promise(resolve => source.close(resolve)); }
});

test('authentication lease survives client disconnect and disable/re-enable, then releases on rejection', async () => {
    for (const interruption of ['disconnect', 'disable']) {
        let authCalls = 0; let pending = 0; let rejectAuth; let blocked = true;
        const gate = new Promise((_resolve, reject) => { rejectAuth = reject; });
        let upstreamCalls = 0;
        const google = fakeGoogle([]);
        const bridge = createOpenAIBridge({ maxGlobal: 4, maxPerUser: 1, timeoutMs: 1000,
            upstreamRequest(...args) { upstreamCalls++; return google(...args); },
            stRuntime: {
                resolveOpenAIConnection: (_request, connection) => ({ connection }),
                async getOpenAIConfig(_request, _connection, authenticate) {
                    if (authenticate) {
                        authCalls++;
                        if (blocked) { pending++; try { await gate; } finally { pending--; } }
                    }
                    return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer fake-google' } };
                },
            },
        });
        const transport = createLoopbackTransport({ openaiBridge: bridge });
        await transport.start(); bridge.setBaseUrl(transport.baseUrl);
        try {
            const configure = async body => {
                const result = managerResponse(); await bridge.update({ ...user('alice'), body }, result);
                assert.equal(result.code, 200); return result.body;
            };
            const connection = { source: 'makersuite', model: 'gemini-2.5-flash' };
            let state = await configure({ enabled: true, connection });
            const url = `${transport.baseUrl}/openai/v1/models`;
            const get = key => fetch(url, { headers: { Authorization: `Bearer ${key}` } });
            let request;
            const clientClosed = new Promise(resolve => {
                request = http.get(url, { headers: { Authorization: `Bearer ${state.apiKey}` } });
                request.on('error', () => {});
                request.once('close', resolve);
            });
            await until(() => pending === 1);
            if (interruption === 'disconnect') request.destroy();
            else {
                await configure({ enabled: false });
                state = await configure({ enabled: true, connection });
            }
            await clientClosed;
            const busy = await get(state.apiKey); assert.equal(busy.status, 429); await busy.text();
            assert.equal(authCalls, 1); assert.equal(pending, 1); assert.equal(upstreamCalls, 0);
            blocked = false; rejectAuth(new Error('Simulated OAuth rejection'));
            await until(() => pending === 0);
            const recovered = await get(state.apiKey); assert.equal(recovered.status, 200); await recovered.text();
            assert.equal(authCalls, 2); assert.equal(upstreamCalls, 1);
        } finally { blocked = false; rejectAuth(new Error('Test cleanup')); bridge.close(); await transport.close(); }
    }
});
async function setup(reply) {
    const calls = [];
    const stRuntime = {
        resolveOpenAIConnection(_request, connection) { return { connection: { ...connection, secretId: connection.secretId || 'pinned' } }; },
        async getOpenAIConfig(_request, connection) {
            return connection.source === 'vertexai' ? { target: 'https://aiplatform.googleapis.com/v1/projects/demo-project/locations/global/endpoints/openapi/chat/completions', headers: { Authorization: 'Bearer google-token' } }
                : { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google-key' } };
        },
    };
    const bridge = createOpenAIBridge({ stRuntime, upstreamRequest: fakeGoogle(calls, reply), maxBodyBytes: 1024, maxGlobal: 1 });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    return { bridge, transport, calls };
}

test('local debug CORS requires an enabled per-user setting and bridge bearer key', async () => {
    const { bridge, transport, calls } = await setup();
    const url = `${transport.baseUrl}/openai/v1`;
    const origin = 'http://localhost:8000';
    const preflight = (value = origin, method = 'POST', headers = 'authorization, content-type, x-stainless-lang') => fetch(`${url}/chat/completions`, { method: 'OPTIONS', headers: { Origin: value, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers, 'Access-Control-Request-Private-Network': 'true' } });
    const configure = async (name, body) => { const result = managerResponse(); await bridge.update({ ...user(name), body }, result); assert.equal(result.code, 200); return result.body; };
    const connection = { source: 'makersuite', model: 'gemini-2.5-flash' };
    const get = (key, value = origin) => fetch(`${url}/models`, { headers: { Authorization: `Bearer ${key}`, Origin: value } });
    try {
        assert.equal((await preflight()).status, 403);
        let alice = await configure('alice', { enabled: true, connection });
        assert.equal(alice.debugLocalAccess, false);
        assert.equal((await get(alice.apiKey)).status, 403);
        alice = await configure('alice', { enabled: true, debugLocalAccess: true });
        const bob = await configure('bob', { enabled: true, connection });
        const allowed = await preflight();
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
        assert.equal(allowed.headers.get('access-control-max-age'), '0');
        assert.equal(allowed.headers.get('access-control-allow-private-network'), 'true');
        assert.match(allowed.headers.get('access-control-allow-headers'), /x-stainless-lang/u);
        assert.match(allowed.headers.get('vary'), /Access-Control-Request-Headers/u);
        assert.equal((await preflight(origin, 'DELETE')).status, 403);
        assert.equal((await preflight(origin, 'POST', 'authorization, bad header')).status, 403);
        for (const value of ['null', 'file://localhost', 'https://example.com', 'http://localhost.evil', 'http://evil@localhost', 'http://localhost/', 'http://localhost:99999']) {
            assert.equal((await preflight(value)).status, 403, value);
            const rejected = await get(alice.apiKey, value);
            assert.equal(rejected.status, 403, value);
            assert.equal(rejected.headers.get('access-control-allow-origin'), null);
        }
        for (const value of [origin, 'https://127.0.0.1:443', 'http://[::1]:1234']) {
            const result = await get(alice.apiKey, value);
            assert.equal(result.status, 200);
            assert.equal(result.headers.get('access-control-allow-origin'), value);
        }
        assert.equal((await get(bob.apiKey)).status, 403);
        assert.equal((await fetch(`${url}/models`, { headers: { Origin: origin } })).status, 401);
        const completion = await fetch(`${url}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${alice.apiKey}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
        assert.equal(completion.status, 200);
        assert.equal(completion.headers.get('access-control-allow-origin'), origin);
        assert.equal(calls.length, 1);
        const retained = await configure('alice', { enabled: true });
        assert.equal(retained.debugLocalAccess, true);
        alice = await configure('alice', { enabled: true, debugLocalAccess: false });
        assert.equal((await preflight()).status, 403);
        assert.equal((await get(alice.apiKey)).status, 403);
        assert.equal((await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${alice.apiKey}` } })).status, 200);
        alice = await configure('alice', { enabled: true, debugLocalAccess: true });
        const rotated = await configure('alice', { enabled: true, rotateKey: true });
        assert.equal((await get(alice.apiKey)).status, 401);
        assert.equal((await get(rotated.apiKey)).status, 200);
        const disabled = await configure('alice', { enabled: false });
        assert.equal(disabled.debugLocalAccess, false);
        assert.equal((await preflight()).status, 403);
        assert.equal((await get(rotated.apiKey)).status, 401);
        const invalid = managerResponse(); await bridge.update({ ...user('bob'), body: { enabled: true, debugLocalAccess: 'true' } }, invalid);
        assert.equal(invalid.code, 400);
    } finally { bridge.close(); await transport.close(); }
});

test('bridge starts disabled, isolates users, forwards OpenAI JSON and revokes rotated keys', async () => {
    const { bridge, transport, calls } = await setup();
    try {
        const initial = managerResponse(); bridge.get(user('alice'), initial);
        assert.deepEqual(initial.body, { ok: true, enabled: false, debugLocalAccess: false, baseUrl: null, apiKey: null, model: 'st-current', connection: null });
        const enabled = managerResponse();
        await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        assert.equal(enabled.body.enabled, true);
        assert.equal(enabled.body.apiKey.length >= 43, true);
        assert.equal(enabled.body.connection.secretId, 'pinned');
        const other = managerResponse(); bridge.get(user('bob'), other);
        assert.equal(other.body.enabled, false);
        const url = `${transport.baseUrl}/openai/v1`;
        const unauth = await fetch(`${url}/models`);
        assert.equal(unauth.status, 401);
        const models = await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${enabled.body.apiKey}` } });
        assert.deepEqual((await models.json()).data.map(model => model.id), ['st-current', 'gemini-2.5-flash']);
        const completion = await fetch(`${url}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json', Cookie: 'local=secret' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], temperature: 0.5, stream: true }) });
        assert.equal(completion.status, 200);
        assert.equal(completion.headers.get('set-cookie'), null);
        assert.equal((await completion.json()).usage.total_tokens, 1);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].target, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer google-key');
        assert.equal(calls[0].options.headers.Cookie, undefined);
        assert.deepEqual(calls[0].body, { messages: [{ role: 'user', content: 'hello' }], temperature: 0.5, stream: true, model: 'gemini-2.5-flash' });
        const same = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true } }, same);
        assert.equal(same.body.apiKey, enabled.body.apiKey);
        const rotated = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, rotateKey: true } }, rotated);
        assert.notEqual(rotated.body.apiKey, enabled.body.apiKey);
        assert.equal((await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${enabled.body.apiKey}` } })).status, 401);
        const disabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: false } }, disabled);
        assert.equal(disabled.body.enabled, false);
        assert.equal((await fetch(`${url}/models`, { headers: { Authorization: `Bearer ${rotated.body.apiKey}` } })).status, 401);
    } finally { bridge.close(); await transport.close(); }
});

test('bridge rejects routing fields and invalid models before Google, and handles redirect', async () => {
    const { bridge, transport, calls } = await setup({ status: 302, headers: { location: 'https://elsewhere.invalid' } });
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'vertexai', model: 'gemini-2.5-pro', authMode: 'full', region: 'global' } } }, enabled);
        const url = `${transport.baseUrl}/openai/v1/chat/completions`;
        const send = body => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
        const forbidden = await send({ messages: [{ role: 'user', content: 'hi' }], reverse_proxy: 'https://evil.invalid' });
        assert.equal(forbidden.status, 400);
        const invalid = await send({ messages: [{ role: 'user', content: 'hi' }], model: 'gemini/../secret' });
        assert.equal(invalid.status, 400);
        assert.equal(calls.length, 0);
        const redirect = await send({ messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(redirect.status, 502);
        assert.equal(redirect.headers.get('location'), null);
        assert.equal(calls[0].body.model, 'google/gemini-2.5-pro');
    } finally { bridge.close(); await transport.close(); }
});

test('bridge preserves SSE/error bytes and rejects oversized chunked bodies', async () => {
    const { bridge, transport, calls } = await setup({ status: 429, headers: { 'content-type': 'text/event-stream', 'retry-after': '7', 'set-cookie': 'bad=1' }, body: 'data: {"error":"busy"}\n\n' });
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        const url = `${transport.baseUrl}/openai/v1/chat/completions`;
        const headers = { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json' };
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }], stream: true }) });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get('retry-after'), '7');
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(await response.text(), 'data: {"error":"busy"}\n\n');
        assert.equal(calls.length, 1);
        const oversized = await fetch(url, { method: 'POST', headers, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1500)); controller.close(); } }), duplex: 'half' });
        assert.equal(oversized.status, 413);
        assert.equal(calls.length, 1);
    } finally { bridge.close(); await transport.close(); }
});

test('slow request body reaches total deadline and releases bridge capacity', async () => {
    const calls = [];
    const stRuntime = { resolveOpenAIConnection: (_request, connection) => ({ connection }), async getOpenAIConfig() { return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } }; } };
    const bridge = createOpenAIBridge({ stRuntime, upstreamRequest: fakeGoogle(calls), timeoutMs: 40, maxGlobal: 1 });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        const slow = await new Promise((resolve, reject) => {
            const request = http.request(`${transport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => {
                let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({ status: response.statusCode, body }));
            });
            request.on('error', reject);
            request.write('{"messages":[');
        });
        assert.equal(slow.status, 504);
        assert.equal(JSON.parse(slow.body).error.code, 'GOOGLE_TIMEOUT');
        const next = await fetch(`${transport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"ok"}]}' });
        assert.equal(next.status, 200);
        assert.equal(calls.length, 1);
    } finally { bridge.close(); await transport.close(); }
});

test('deferred authentication cannot generate after timeout and late upstream callback cannot write response', async () => {
    let releaseAuth;
    const authGate = new Promise(resolve => { releaseAuth = resolve; });
    let authCalls = 0;
    let generated = 0;
    const stRuntime = {
        resolveOpenAIConnection: (_request, connection) => ({ connection }),
        async getOpenAIConfig(_request, _connection, authenticate) {
            if (authenticate) { authCalls++; await authGate; }
            return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } };
        },
    };
    const bridge = createOpenAIBridge({ stRuntime, upstreamRequest() { generated++; throw new Error('must not generate'); }, timeoutMs: 30 });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        const url = `${transport.baseUrl}/openai/v1/chat/completions`;
        const headers = { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json' };
        const timed = await fetch(url, { method: 'POST', headers, body: '{"messages":[{"role":"user","content":"ok"}]}' });
        assert.equal(timed.status, 504);
        await timed.text();
        releaseAuth();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(authCalls, 1);
        assert.equal(generated, 0);
    } finally { bridge.close(); await transport.close(); }

    let lateCallback;
    const direct = createOpenAIBridge({ stRuntime: { resolveOpenAIConnection: (_request, connection) => ({ connection }), async getOpenAIConfig() { return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } }; } }, upstreamRequest(_target, _options, callback) {
        lateCallback = callback;
        const request = new PassThrough(); request.on('data', () => {}); return request;
    }, timeoutMs: 30 });
    const lateTransport = createLoopbackTransport({ openaiBridge: direct });
    await lateTransport.start(); direct.setBaseUrl(lateTransport.baseUrl);
    try {
        const enabled = managerResponse(); await direct.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        const response = await fetch(`${lateTransport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"ok"}]}' });
        assert.equal(response.status, 504);
        await response.text();
        assert.equal(typeof lateCallback, 'function');
        const late = new PassThrough(); late.statusCode = 200; late.headers = { 'content-type': 'application/json' };
        lateCallback(late);
        assert.equal(late.destroyed, true);
    } finally { direct.close(); await lateTransport.close(); }
});

test('disable and rotation revoke active requests before deferred auth can generate', async () => {
    let releaseAuth;
    let authCalls = 0;
    let generated = 0;
    const authGate = new Promise(resolve => { releaseAuth = resolve; });
    const stRuntime = {
        resolveOpenAIConnection: (_request, connection) => ({ connection }),
        async getOpenAIConfig(_request, _connection, authenticate) {
            if (authenticate) { authCalls++; await authGate; }
            return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } };
        },
    };
    const bridge = createOpenAIBridge({ stRuntime, upstreamRequest() { generated++; throw new Error('revoked request generated'); } });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        const url = `${transport.baseUrl}/openai/v1/chat/completions`;
        const send = key => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"ok"}]}' }).catch(() => null);
        const first = send(enabled.body.apiKey);
        await until(() => authCalls === 1);
        const rotated = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, rotateKey: true } }, rotated);
        assert.equal((await fetch(`${transport.baseUrl}/openai/v1/models`, { headers: { Authorization: `Bearer ${enabled.body.apiKey}` } })).status, 401);
        const second = send(rotated.body.apiKey);
        await until(() => authCalls === 2);
        const disabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: false } }, disabled);
        assert.equal((await fetch(`${transport.baseUrl}/openai/v1/models`, { headers: { Authorization: `Bearer ${rotated.body.apiKey}` } })).status, 401);
        releaseAuth();
        await Promise.all([first, second]);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(generated, 0);
    } finally { bridge.close(); await transport.close(); }
});

test('a pending enable cannot resurrect a connection after a newer disable', async () => {
    let releaseValidation;
    const validationGate = new Promise(resolve => { releaseValidation = resolve; });
    const stRuntime = {
        resolveOpenAIConnection: (_request, connection) => ({ connection }),
        async getOpenAIConfig(_request, _connection, authenticate) {
            if (!authenticate) await validationGate;
            return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } };
        },
    };
    const bridge = createOpenAIBridge({ stRuntime });
    bridge.setBaseUrl('http://127.0.0.1:9999');
    try {
        const pending = managerResponse();
        const enabling = bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, pending);
        const disabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: false } }, disabled);
        releaseValidation(); await enabling;
        assert.equal(pending.code, 409);
        const current = managerResponse(); bridge.get(user('alice'), current);
        assert.equal(current.body.enabled, false);
    } finally { bridge.close(); }
});

test('global and per-user concurrency limits reject excess work and release slots', async () => {
    const callbacks = [];
    const stRuntime = {
        resolveOpenAIConnection: (_request, connection) => ({ connection }),
        async getOpenAIConfig() { return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } }; },
    };
    const bridge = createOpenAIBridge({ stRuntime, maxGlobal: 2, maxPerUser: 1, upstreamRequest(_target, _options, callback) {
        callbacks.push(callback);
        const request = new PassThrough(); request.on('data', () => {}); return request;
    } });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    try {
        const firstUser = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, firstUser);
        const secondUser = managerResponse(); await bridge.update({ ...user('bob'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, secondUser);
        const url = `${transport.baseUrl}/openai/v1/chat/completions`;
        const send = key => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{"messages":[{"role":"user","content":"ok"}]}' });
        const one = send(firstUser.body.apiKey); await until(() => callbacks.length === 1);
        const sameUser = await send(firstUser.body.apiKey); assert.equal(sameUser.status, 429);
        const two = send(secondUser.body.apiKey); await until(() => callbacks.length === 2);
        const global = await send(firstUser.body.apiKey); assert.equal(global.status, 429);
        const upstreamResponse = new PassThrough(); upstreamResponse.statusCode = 200; upstreamResponse.headers = { 'content-type': 'application/json' };
        callbacks[0](upstreamResponse); upstreamResponse.end('{"choices":[]}');
        const firstResponse = await one; assert.equal(firstResponse.status, 200); await firstResponse.text();
        const again = send(firstUser.body.apiKey); await until(() => callbacks.length === 3);
        const thirdResponse = new PassThrough(); thirdResponse.statusCode = 200; thirdResponse.headers = { 'content-type': 'application/json' };
        callbacks[2](thirdResponse); thirdResponse.end('{"choices":[]}');
        const againResponse = await again; assert.equal(againResponse.status, 200); await againResponse.text();
        const secondResponse = new PassThrough(); secondResponse.statusCode = 200; secondResponse.headers = { 'content-type': 'application/json' };
        callbacks[1](secondResponse); secondResponse.end('{"choices":[]}');
        const secondResponseClient = await two; assert.equal(secondResponseClient.status, 200); await secondResponseClient.text();
    } finally { bridge.close(); await transport.close(); }
});

test('disabling a bridge closes an unfinished chunked upload', async () => {
    let generated = 0;
    const stRuntime = { resolveOpenAIConnection: (_request, connection) => ({ connection }), async getOpenAIConfig() { return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer google' } }; } };
    const bridge = createOpenAIBridge({ stRuntime, upstreamRequest() { generated++; throw new Error('unfinished upload generated'); } });
    const transport = createLoopbackTransport({ openaiBridge: bridge });
    await transport.start(); bridge.setBaseUrl(transport.baseUrl);
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        let request;
        const closed = new Promise(resolve => {
            request = http.request(`${transport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
            request.on('error', () => {});
            request.once('close', resolve);
            request.write('{"messages":[');
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        const disabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: false } }, disabled);
        await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upload socket remained open')), 500))]);
        assert.equal(generated, 0);
    } finally { bridge.close(); await transport.close(); }
});

test('header-only oversized upload receives 413 and its socket closes', async () => {
    const { bridge, transport, calls } = await setup();
    try {
        const enabled = managerResponse(); await bridge.update({ ...user('alice'), body: { enabled: true, connection: { source: 'makersuite', model: 'gemini-2.5-flash' } } }, enabled);
        let socketClosed;
        const closed = new Promise(resolve => { socketClosed = resolve; });
        const result = await new Promise((resolve, reject) => {
            const request = http.request(`${transport.baseUrl}/openai/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${enabled.body.apiKey}`, 'Content-Type': 'application/json', 'Content-Length': '5000' } }, response => {
                let body = '';
                response.on('data', chunk => body += chunk);
                response.on('end', () => resolve({ status: response.statusCode, body, connection: response.headers.connection }));
            });
            request.on('error', reject);
            request.once('socket', socket => socket.once('close', socketClosed));
            request.flushHeaders();
        });
        await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Rejected upload socket remained open')), 500))]);
        assert.equal(result.status, 413);
        assert.equal(JSON.parse(result.body).error.code, 'REQUEST_BODY_TOO_LARGE');
        assert.equal(result.connection, 'close');
        assert.equal(calls.length, 0);
    } finally { bridge.close(); await transport.close(); }
});
