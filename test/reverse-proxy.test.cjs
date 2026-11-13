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
const { createPrepareHandler } = require('../src/prepare-route.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');
const { loadStRuntime } = require('../src/st-runtime.cjs');
const { validatePreparePayload } = require('../src/protocol.cjs');
const { prepareGoogleTarget, validatePreparedGoogleTarget } = require('../src/target-policy.cjs');
const { encodedModelSegment, toVertexBetaTarget } = require('../src/upstream-proxy.cjs');

const SOURCES = ['makersuite', 'vertexai'];
const USER = { directories: { root: 'test-user' } };

function body(source, overrides = {}) {
    return {
        protocolVersion: 3, chat_completion_source: source, model: 'gemini-2.5-pro', stream: false, tier: 'flex', paygoOnly: false,
        ...(source === 'vertexai' ? { vertexai_auth_mode: 'full', vertexai_region: 'global' } : {}),
        ...overrides,
    };
}

function response() {
    return { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } };
}

// The endpoint SillyTavern's getGoogleApiConfig builds for a reverse proxy.
function hostProxyUrl(source, reverseProxy, model, endpoint) {
    const base = reverseProxy.replace(/\/$/u, '');
    return source === 'makersuite' ? `${base}/v1beta/models/${model}:${endpoint}` : `${base}/v1/publishers/google/models/${model}:${endpoint}`;
}

// The headers SillyTavern's getGoogleApiConfig returns for a reverse proxy.
function hostProxyHeaders(source, password) {
    return source === 'makersuite'
        ? { 'Content-Type': 'application/json', 'x-goog-api-key': password }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${password}` };
}

// The URL SillyTavern's chat backend calls once the plugin replaced its proxy.
function nativeLoopbackRequest(source, prepared, model, stream) {
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    return source === 'makersuite'
        ? { url: `${prepared.proxyUrl}/v1beta/models/${model}:${endpoint}?key=${prepared.proxySecret}${stream ? '&alt=sse' : ''}`, headers: {} }
        : { url: `${prepared.proxyUrl}/v1/publishers/google/models/${model}:${endpoint}${stream ? '?alt=sse' : ''}`,
            headers: { Authorization: `Bearer ${prepared.proxySecret}` } };
}

// node:http adds no default User-Agent or Accept, so each test controls exactly
// which host headers reach the loopback.
function post(url, { headers = {}, payload, chunked = false }) {
    return new Promise((resolve, reject) => {
        const request = http.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(chunked ? { 'Transfer-Encoding': 'chunked' } : {}), ...headers },
        }, incoming => {
            const chunks = [];
            incoming.on('data', chunk => chunks.push(chunk));
            incoming.on('end', () => resolve({ status: incoming.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
            incoming.on('error', reject);
        });
        request.on('error', reject);
        if (chunked) {
            const half = Math.floor(payload.length / 2);
            request.write(payload.slice(0, half));
            request.end(payload.slice(half));
        } else {
            request.end(payload);
        }
    });
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

function geminiReply(stream) {
    const value = { candidates: [{ content: { role: 'model', parts: [{ text: 'proxy reply' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } };
    return stream ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value);
}

async function withPlugin(source, base, password, run) {
    const logs = [];
    const logStore = { server: (...entry) => logs.push(entry) };
    const ticketStore = new TicketStore();
    const transport = createLoopbackTransport({ ticketStore, logStore });
    await transport.start();
    const prepare = createPrepareHandler({ ticketStore, loopbackTransport: transport, logStore,
        stRuntime: { async getGoogleApiConfig(request, model, endpoint) {
            assert.equal(request.body.api, source);
            assert.equal(request.body.reverse_proxy, base);
            assert.equal(request.body.proxy_password, password);
            return { url: hostProxyUrl(source, request.body.reverse_proxy, model, endpoint), headers: hostProxyHeaders(source, request.body.proxy_password) };
        } },
    });
    const prepareRequest = async overrides => {
        const prepared = response();
        await prepare({ body: body(source, { reverse_proxy: `${base}///`, proxy_password: password, secret_id: 'saved-key', ...overrides }), user: USER }, prepared);
        assert.equal(prepared.statusCode, 200, JSON.stringify(prepared.body));
        return prepared.body;
    };
    try {
        await run({ prepareRequest, logs });
    } finally {
        ticketStore.close();
        await transport.close();
    }
}

test('reverse proxy validation accepts HTTP(S) bases and binds the full origin and path for both sources', () => {
    for (const source of SOURCES) {
        for (const reverse_proxy of ['https://proxy.example', 'http://localhost:9000/a.b/prefix///']) {
            const config = validatePreparePayload(body(source, { reverse_proxy, proxy_password: 'proxy-key' }));
            const base = reverse_proxy.replace(/\/+$/u, '');
            assert.equal(config.reverseProxy, base);
            assert.equal(config.proxyPassword, 'proxy-key');
            const raw = hostProxyUrl(source, base, config.model, 'generateContent');
            const prepared = prepareGoogleTarget(raw, config);
            assert.equal(validatePreparedGoogleTarget(prepared, config).toString(), raw);
            const version = source === 'makersuite' ? '/v1beta/' : '/v1/';
            for (const invalid of [
                raw.replace(version, `${version}extra/`), raw.replace(config.model, 'gemini-wrong'),
                raw.replace(':generateContent', ':streamGenerateContent'), `${raw}?key=private`,
                raw.replace(new URL(raw).origin, 'https://other.example'), raw.replace('/a.b/', '/axb/'),
                raw.replace(version, '/v1beta1/'),
                raw.replace('/publishers/', '/projects/demo/locations/global/publishers/'),
            ].filter(url => url !== raw)) {
                assert.throws(() => prepareGoogleTarget(invalid, config), { code: 'UNSAFE_GOOGLE_TARGET' }, invalid);
            }
        }
        for (const reverse_proxy of ['', null, 123, 'file:///tmp', 'ftp://example.com', 'https://u:p@example.com',
            'https://example.com/?key=private', 'https://example.com/?', 'https://example.com/#fragment', 'https://example.com/#',
            ' https://example.com', 'https://example.com/with space', 'https:\\example.com']) {
            assert.throws(() => validatePreparePayload(body(source, { reverse_proxy })), { code: 'INVALID_REVERSE_PROXY' });
        }
        for (const proxy_password of [123, {}, 'key\r\nHost: evil', 'a'.repeat(8193)]) {
            assert.throws(() => validatePreparePayload(body(source, { reverse_proxy: 'https://example.com', proxy_password })),
                { code: 'INVALID_PROXY_PASSWORD' });
        }
        assert.throws(() => validatePreparePayload(body(source, { proxy_password: 'orphan' })), { code: 'INVALID_REVERSE_PROXY' });
        const official = validatePreparePayload(body(source));
        assert.equal(official.reverseProxy, undefined);
        assert.throws(() => prepareGoogleTarget(hostProxyUrl(source, 'https://proxy.example', official.model, 'generateContent'), official),
            { code: 'UNSAFE_GOOGLE_TARGET' });
    }
});

test('reverse proxy model names follow SillyTavern routing while official targets stay canonical', () => {
    for (const source of SOURCES) {
        for (const model of ['Gemini-2.5-Pro', 'gemini-2.5-pro-假流式', 'GEMINI-2.5-FLASH', 'gemini-2.5-pro:latest', `gemini-${'a'.repeat(249)}`]) {
            assert.equal(validatePreparePayload(body(source, { model, reverse_proxy: 'https://proxy.example' })).model, model);
            assert.throws(() => validatePreparePayload(body(source, { model })), { code: 'INVALID_PREPARE_REQUEST' }, model);
        }
        for (const model of ['', 123, 'claude-sonnet-4', 'gemini-a/b', 'gemini-a?b', 'gemini-a#b', 'gemini-%41', 'gemini-a\\b',
            'gemini-a b', 'gemini-a\tb', 'gemini-a\u0000', 'gemini-a\u200b', 'gemini-\ud800', ' gemini-a', `gemini-${'a'.repeat(250)}`]) {
            assert.throws(() => validatePreparePayload(body(source, { model, reverse_proxy: 'https://proxy.example' })),
                { code: 'INVALID_PREPARE_REQUEST' }, JSON.stringify(model));
        }
    }
});

test('host runtime gives a reverse proxy its own credentials for either source', async () => {
    for (const source of SOURCES) {
        const calls = [];
        const runtime = await loadStRuntime({
            rootDir: 'C:\\fake-host',
            readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
            importModule: async specifier => specifier.endsWith('/secrets.js')
                ? { SECRET_KEYS: { MAKERSUITE: 'makersuite', VERTEXAI: 'vertexai' }, readSecret() { throw new Error('Google secrets must not be read'); } }
                : { getGoogleApiConfig: async request => { calls.push(request.body); return { headers: hostProxyHeaders(source, request.body.proxy_password) }; } },
        });
        const requestBody = { api: source, secret_id: 'missing-google-secret', reverse_proxy: 'https://proxy.example', proxy_password: 'proxy-only-key',
            ...(source === 'vertexai' ? { vertexai_auth_mode: 'express', vertexai_region: 'global' } : {}) };
        const config = await runtime.getGoogleApiConfig({ body: requestBody, user: USER }, 'gemini-2.5-pro', 'generateContent');
        assert.deepEqual(config.headers, hostProxyHeaders(source, 'proxy-only-key'));
        assert.deepEqual(calls, [requestBody]);
    }
});

test('Gemini 4 rewrites only the Vertex version segment that follows the proxy base', () => {
    const proxied = 'https://proxy.example/v1/gateway/v1/publishers/google/models/gemini-4-hydrogen:generateContent';
    assert.equal(toVertexBetaTarget(proxied, { source: 'vertexai', reverseProxy: 'https://proxy.example/v1/gateway' }).pathname,
        '/v1/gateway/v1beta1/publishers/google/models/gemini-4-hydrogen:generateContent');
    assert.equal(toVertexBetaTarget(
        'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-4-hydrogen:generateContent',
        { source: 'vertexai' },
    ).pathname, '/v1beta1/projects/demo/locations/global/publishers/google/models/gemini-4-hydrogen:generateContent');
    const studio = 'https://proxy.example/v1/v1beta/models/gemini-4-hydrogen:generateContent';
    assert.equal(toVertexBetaTarget(studio, { source: 'makersuite', reverseProxy: 'https://proxy.example/v1' }).toString(), studio);
});

const MODELS = ['gemini-2.5-pro', 'gemini-4-hydrogen', 'gemini-2.5-pro-假流式', 'Gemini-2.5-Pro'];
const TIERS = {
    makersuite: [['standard', false], ['flex', false]],
    vertexai: [['standard', false], ['flex', false], ['priority', false], ['standard', true]],
};

for (const source of SOURCES) for (const [tier, paygoOnly] of TIERS[source]) for (const model of MODELS) for (const stream of [false, true]) {
    test(`reverse proxy receives SillyTavern's native request (${source}, ${tier}${paygoOnly ? ' PayGo-only' : ''}, ${model}, stream=${stream})`, async () => {
        const calls = [];
        const upstream = http.createServer(async (request, res) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const raw = Buffer.concat(chunks);
            calls.push({ method: request.method, url: request.url, headers: request.headers, raw, body: JSON.parse(raw) });
            res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
            res.end(geminiReply(stream));
        });
        await listen(upstream);
        const base = `http://127.0.0.1:${upstream.address().port}/gateway/a.b`;
        const password = tier === 'standard' && !paygoOnly ? '' : 'only-proxy-key';
        try {
            await withPlugin(source, base, password, async ({ prepareRequest, logs }) => {
                const prepared = await prepareRequest({ model, stream, tier, paygoOnly });
                assert.equal(prepared.nativeGeminiApiVersion, source === 'makersuite' ? 'v1beta' : 'v1');
                assert.doesNotMatch(JSON.stringify(prepared), /only-proxy-key|gateway|a\.b/u);
                // The streaming request carries the host's own headers; the other
                // one has none, like the plugin's native Gemini 4 route.
                const hostHeaders = stream ? { 'User-Agent': 'host-agent/1.0', Accept: 'text/event-stream' } : {};
                const input = { contents: [{ role: 'user', parts: [{ text: '你好' }] }], generationConfig: { maxOutputTokens: 100, temperature: 0.5 },
                    ...(tier === 'flex' ? { serviceTier: 'standard', service_tier: 'priority' } : {}) };
                const native = nativeLoopbackRequest(source, prepared, model, stream);
                const result = await post(native.url, { headers: { ...native.headers, ...hostHeaders }, payload: JSON.stringify(input) });
                assert.equal(result.status, 200, result.text);
                assert.match(result.text, /proxy reply/u);
                assert.equal(calls.length, 1);
                const [call] = calls;
                const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
                const path = source === 'makersuite'
                    ? `/gateway/a.b/v1beta/models/${encodedModelSegment(model)}:${endpoint}?key=${password}${stream ? '&alt=sse' : ''}`
                    : `/gateway/a.b/${model === 'gemini-4-hydrogen' ? 'v1beta1' : 'v1'}/publishers/google/models/${encodedModelSegment(model)}:${endpoint}${stream ? '?alt=sse' : ''}`;
                assert.equal(call.method, 'POST');
                assert.equal(call.url, path);
                assert.equal(call.headers['content-length'], String(call.raw.length));
                assert.equal(call.headers['transfer-encoding'], undefined);
                assert.equal(call.headers['user-agent'], hostHeaders['User-Agent'] ?? 'node-fetch');
                assert.equal(call.headers.accept, hostHeaders.Accept ?? '*/*');
                assert.equal(call.headers['accept-encoding'], undefined);
                assert.equal(call.headers['x-goog-api-key'], undefined);
                // An HTTP parser drops the trailing space of an empty Bearer value.
                assert.equal(call.headers.authorization, source === 'vertexai' ? `Bearer ${password}`.trimEnd() : undefined);
                assert.equal(call.headers['x-vertex-ai-llm-request-type'], paygoOnly ? 'shared' : undefined);
                assert.equal(call.headers['x-vertex-ai-llm-shared-request-type'], source === 'vertexai' && tier !== 'standard' ? tier : undefined);
                assert.equal(call.headers['x-server-timeout'], tier === 'flex' ? '1800' : undefined);
                assert.deepEqual(call.body.contents, input.contents);
                assert.equal(call.body.generationConfig.temperature, model === 'gemini-4-hydrogen' ? undefined : 0.5);
                const studioFlex = source === 'makersuite' && tier === 'flex';
                assert.equal(call.body.service_tier, studioFlex ? 'flex' : input.service_tier);
                assert.equal(call.body.serviceTier, studioFlex ? undefined : input.serviceTier);
                assert.doesNotMatch(JSON.stringify(logs), /only-proxy-key|gateway|a\.b|saved-key|你好/u);
            });
        } finally {
            await close(upstream);
        }
    });
}

test('a proxy that reserves its whole body limit for chunked uploads admits overlapping plugin requests', async () => {
    // Modeled on ais2api: a chunked upload reserves request_bytes x 4 of a
    // 256 MiB budget until its response ends, and the credential is ?key=.
    const budget = 256 * 1024 * 1024;
    const requestBytes = 32 * 1024 * 1024;
    let admitted = 0;
    const waiting = [];
    const seen = [];
    const upstream = http.createServer(async (request, res) => {
        const declared = request.headers['content-length'];
        const reservation = (declared !== undefined ? Number(declared) : request.headers['transfer-encoding'] ? requestBytes : 0) * 4 + 65536;
        if (reservation > budget - admitted) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end('{"error":{"code":429,"status":"memory_budget"}}');
            return;
        }
        admitted += reservation;
        try {
            for await (const chunk of request) void chunk;
            const key = new URL(request.url, 'http://proxy.invalid').searchParams.get('key');
            seen.push({ key, chunked: Boolean(request.headers['transfer-encoding']) });
            if (key !== 'proxy-key') {
                res.writeHead(401);
                res.end();
                return;
            }
            // Keep both generations open together, like two overlapping chats.
            await new Promise(resolve => {
                waiting.push(resolve);
                if (waiting.length === 2) waiting.splice(0).forEach(release => release());
                setTimeout(resolve, 2000).unref();
            });
            const stream = request.url.includes('alt=sse');
            res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
            res.end(geminiReply(stream));
        } finally {
            admitted -= reservation;
        }
    });
    await listen(upstream);
    const base = `http://127.0.0.1:${upstream.address().port}`;
    try {
        await withPlugin('makersuite', base, 'proxy-key', async ({ prepareRequest }) => {
            const requests = [];
            for (const stream of [true, false]) {
                const prepared = await prepareRequest({ stream, tier: 'standard' });
                const native = nativeLoopbackRequest('makersuite', prepared, 'gemini-2.5-pro', stream);
                // SillyTavern sends a length, but even a chunked loopback upload
                // must reach the proxy with one.
                requests.push(post(native.url, { payload: '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}', chunked: stream }));
            }
            const results = await Promise.all(requests);
            assert.deepEqual(results.map(result => result.status), [200, 200], JSON.stringify(results));
            assert.deepEqual(seen, [{ key: 'proxy-key', chunked: false }, { key: 'proxy-key', chunked: false }]);
        });
    } finally {
        await close(upstream);
    }
});

test('an AI Studio Flex body that is not a JSON object fails before reaching the proxy', async () => {
    let calls = 0;
    const upstream = http.createServer((request, res) => { calls += 1; res.end(); });
    await listen(upstream);
    try {
        await withPlugin('makersuite', `http://127.0.0.1:${upstream.address().port}`, 'proxy-key', async ({ prepareRequest }) => {
            const prepared = await prepareRequest({ tier: 'flex' });
            const native = nativeLoopbackRequest('makersuite', prepared, 'gemini-2.5-pro', false);
            const result = await post(native.url, { payload: '[]' });
            assert.equal(result.status, 400);
            assert.equal(JSON.parse(result.text).code, 'INVALID_GOOGLE_BODY');
            assert.equal(calls, 0);
        });
    } finally {
        await close(upstream);
    }
});

test('a Gemini 4 proxy error never repeats the proxy credential', async () => {
    const password = 'proxy secret/1';
    for (const source of SOURCES) {
        const upstream = http.createServer((request, res) => {
            const credential = source === 'makersuite'
                ? new URL(request.url, 'http://proxy.invalid').searchParams.get('key') : request.headers.authorization.slice(7);
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED',
                message: `Rejected ${credential} (${encodeURIComponent(credential)}) for ${request.url}` } }));
        });
        await listen(upstream);
        try {
            await withPlugin(source, `http://127.0.0.1:${upstream.address().port}`, password, async ({ prepareRequest, logs }) => {
                const prepared = await prepareRequest({ model: 'gemini-4-hydrogen', tier: 'flex' });
                const native = nativeLoopbackRequest(source, prepared, 'gemini-4-hydrogen', false);
                const result = await post(native.url, { headers: native.headers,
                    payload: '{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":100}}' });
                assert.equal(result.status, 401);
                const error = JSON.parse(result.text);
                assert.equal(error.code, 'GEMINI4_UPSTREAM_HTTP_ERROR');
                assert.match(error.message, /\[redacted\]/u);
                assert.doesNotMatch(result.text, /proxy secret|proxy%20secret/u);
                assert.doesNotMatch(JSON.stringify(logs), /proxy secret|proxy%20secret/u);
            });
        } finally {
            await close(upstream);
        }
    }
});

test('a host endpoint outside the selected proxy fails preparation without issuing a ticket', async () => {
    for (const source of SOURCES) {
        const ticketStore = new TicketStore();
        const prepare = createPrepareHandler({ ticketStore, loopbackTransport: { baseUrl: 'http://127.0.0.1:1234' },
            stRuntime: { getGoogleApiConfig: async () => ({ url: hostProxyUrl(source, 'https://other.example', 'gemini-2.5-pro', 'generateContent'),
                headers: hostProxyHeaders(source, 'proxy-key') }) },
        });
        try {
            const res = response();
            await prepare({ body: body(source, { reverse_proxy: 'https://selected.example' }), user: USER }, res);
            assert.equal(res.body.code, 'UNSAFE_GOOGLE_TARGET');
            assert.equal(ticketStore.size, 0);
            assert.equal(ticketStore.pendingSize, 0);
            assert.doesNotMatch(JSON.stringify(res.body), /proxy-key|other\.example|selected\.example/u);
        } finally {
            ticketStore.close();
        }
    }
});
