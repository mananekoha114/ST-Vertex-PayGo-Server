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

const body = overrides => ({ protocolVersion: 2, chat_completion_source: 'makersuite', model: 'gemini-2.5-pro',
    stream: false, tier: 'flex', paygoOnly: false, ...overrides });
const response = () => ({ statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; } });

test('Studio proxy validation permits HTTP(S) bases and binds the full origin and path', () => {
    for (const reverse_proxy of ['https://proxy.example', 'http://localhost:9000/a.b/prefix///']) {
        const config = validatePreparePayload(body({ reverse_proxy, proxy_password: 'proxy-key' }));
        const base = reverse_proxy.replace(/\/+$/u, '');
        assert.equal(config.reverseProxy, base);
        const raw = `${base}/v1beta/models/${config.model}:generateContent`;
        const prepared = prepareGoogleTarget(raw, config);
        assert.equal(validatePreparedGoogleTarget(prepared, config).toString(), raw);
        for (const invalid of [raw.replace('/v1beta/', '/v1beta/extra/'), raw.replace(config.model, 'gemini-wrong'),
            raw.replace(':generateContent', ':streamGenerateContent'), raw + '?key=private',
            raw.replace(new URL(raw).origin, 'https://other.example'), raw.replace('/a.b/', '/axb/')].filter(url => url !== raw)) {
            assert.throws(() => prepareGoogleTarget(invalid, config), { code: 'UNSAFE_GOOGLE_TARGET' });
        }
    }
    for (const reverse_proxy of ['', null, 123, 'file:///tmp', 'ftp://example.com', 'https://u:p@example.com',
        'https://example.com/?key=private', 'https://example.com/#fragment', ' https://example.com', 'https://example.com/with space',
        'https:\\example.com']) {
        assert.throws(() => validatePreparePayload(body({ reverse_proxy })), { code: 'INVALID_REVERSE_PROXY' });
    }
    for (const proxy_password of [123, {}, 'key\r\nHost: evil', 'a'.repeat(8193)]) {
        assert.throws(() => validatePreparePayload(body({ reverse_proxy: 'https://example.com', proxy_password })), { code: 'INVALID_PROXY_PASSWORD' });
    }
    assert.throws(() => validatePreparePayload(body({ proxy_password: 'orphan' })), { code: 'INVALID_REVERSE_PROXY' });
    const config = validatePreparePayload(body());
    assert.throws(() => prepareGoogleTarget('https://proxy.example/v1beta/models/gemini-2.5-pro:generateContent', config), { code: 'UNSAFE_GOOGLE_TARGET' });
});

test('host runtime uses the Studio proxy before any explicit or active Google secret', async () => {
    const calls = [];
    const runtime = await loadStRuntime({
        rootDir: 'C:\\fake-host',
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async specifier => specifier.endsWith('/secrets.js')
            ? { SECRET_KEYS: { MAKERSUITE: 'makersuite' }, readSecret() { throw new Error('Google secrets must not be read'); } }
            : { getGoogleApiConfig: async request => { calls.push(request.body); return { headers: { 'x-goog-api-key': request.body.proxy_password } }; } },
    });
    const config = await runtime.getGoogleApiConfig({ body: { api: 'makersuite', secret_id: 'missing-google-secret',
        reverse_proxy: 'https://proxy.example', proxy_password: 'proxy-only-key' } }, 'gemini-2.5-pro', 'generateContent');
    assert.equal(config.headers['x-goog-api-key'], 'proxy-only-key');
    assert.equal(calls.length, 1);
});

for (const model of ['gemini-2.5-pro', 'gemini-4-argon']) for (const stream of [false, true]) for (const tier of ['standard', 'flex']) {
    test(`Studio custom proxy forwards over real HTTP with prefix (${model}, stream=${stream}, tier=${tier})`, async () => {
        const calls = [];
        const logs = [];
        const password = tier === 'flex' ? 'only-proxy-key' : '';
        const upstream = http.createServer(async (request, res) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            calls.push({ url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
            const value = { candidates: [{ content: { role: 'model', parts: [{ text: 'proxy reply' }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } };
            res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
            res.end(stream ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value));
        });
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
        const base = `http://127.0.0.1:${upstream.address().port}/gateway/a.b`;
        const ticketStore = new TicketStore();
        const transport = createLoopbackTransport({ ticketStore, logStore: { server: (...entry) => logs.push(entry) } });
        await transport.start();
        const prepare = createPrepareHandler({ ticketStore, loopbackTransport: transport,
            logStore: { server: (...entry) => logs.push(entry) },
            stRuntime: { async getGoogleApiConfig(request, requestedModel, endpoint) {
                assert.deepEqual(request.body, { api: 'makersuite', secret_id: 'missing-key', reverse_proxy: base, proxy_password: password });
                return { url: `${request.body.reverse_proxy}/v1alpha/models/${requestedModel}:${endpoint}`,
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': password } };
            } },
        });
        try {
            const prepared = response();
            await prepare({ body: body({ model, stream, tier, secret_id: 'missing-key', reverse_proxy: base + '///', proxy_password: password }),
                user: { directories: { root: 'test-user' } } }, prepared);
            assert.equal(prepared.statusCode, 200, JSON.stringify(prepared.body));
            assert.equal(prepared.body.nativeGeminiApiVersion, 'v1alpha');
            assert.doesNotMatch(JSON.stringify(prepared.body), /only-proxy-key|gateway|a\.b/u);
            const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
            const url = `${prepared.body.proxyUrl}/v1alpha/models/${model}:${endpoint}?key=${prepared.body.proxySecret}${stream ? '&alt=sse' : ''}`;
            const wrongVersion = await fetch(url.replace('/v1alpha/', '/v1beta/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            assert.equal(wrongVersion.status, 409);
            await wrongVersion.text();
            assert.equal(calls.length, 0);
            const input = { contents: [{ role: 'user', parts: [{ text: '你好' }] }], generationConfig: { maxOutputTokens: 100 },
                ...(tier === 'flex' ? { serviceTier: 'standard', service_tier: 'priority' } : {}) };
            const result = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(3000) });
            assert.equal(result.status, 200);
            assert.match(await result.text(), /proxy reply/u);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].url, `/gateway/a.b/v1alpha/models/${model}:${endpoint}${stream ? '?alt=sse' : ''}`);
            assert.equal(calls[0].headers['x-goog-api-key'], password || undefined);
            assert.equal(calls[0].headers.authorization, undefined);
            assert.deepEqual(calls[0].body.contents, input.contents);
            assert.equal(calls[0].body.service_tier, tier === 'flex' ? 'flex' : undefined);
            assert.equal(calls[0].body.serviceTier, undefined);
            assert.doesNotMatch(JSON.stringify(logs), /only-proxy-key|gateway|missing-key|你好/u);
        } finally {
            ticketStore.close();
            await transport.close();
            await new Promise(resolve => upstream.close(resolve));
        }
    });
}

test('a host endpoint outside the selected proxy fails preparation without issuing a ticket', async () => {
    const ticketStore = new TicketStore();
    const prepare = createPrepareHandler({ ticketStore, loopbackTransport: { baseUrl: 'http://127.0.0.1:1234' },
        stRuntime: { getGoogleApiConfig: async () => ({ url: 'https://other.example/v1beta/models/gemini-2.5-pro:generateContent',
            headers: { 'x-goog-api-key': 'proxy-key' } }) },
    });
    try {
        const res = response();
        await prepare({ body: body({ reverse_proxy: 'https://selected.example' }), user: { directories: { root: 'test-user' } } }, res);
        assert.equal(res.body.code, 'UNSAFE_GOOGLE_TARGET');
        assert.equal(ticketStore.size, 0);
        assert.equal(ticketStore.pendingSize, 0);
        assert.doesNotMatch(JSON.stringify(res.body), /proxy-key|other.example|selected.example/u);
    } finally { ticketStore.close(); }
});
