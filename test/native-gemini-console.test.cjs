'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const { createNativeGeminiHandler } = require('../src/native-gemini.cjs');

const baseUrl = 'http://127.0.0.1:1234';
const runtime = { async getNativeGeminiHelpers() { return {
    GEMINI_SAFETY: [], VERTEX_SAFETY: [],
    convertGooglePrompt(messages) { return { contents: messages.map(message => ({ role: 'user', parts: [{ text: message.content, thoughtSignature: 'request-signature-private' }] })) }; },
}; } };
function input(overrides = {}) { return {
    model: 'gemini-4-argon', chat_completion_source: 'makersuite', max_tokens: 1024,
    messages: [{ role: 'user', content: 'prompt-body-sentinel' }],
    reverse_proxy: `${baseUrl}/proxy/ticket-private`, proxy_password: 'credential-private', ...overrides,
}; }
function request(body) { return Object.assign(new EventEmitter(), { body, user: { directories: { root: 'test' } } }); }
function response() {
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
    return Object.assign(res, { chunks, setHeader() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.data = value; this.end(); return this; } });
}
function capture() {
    const entries = [];
    return { entries, logger: Object.fromEntries(['debug', 'info', 'warn'].map(level => [level, (label, detail) => entries.push({ level, label, detail })])) };
}
const terminal = entries => entries.filter(entry => /request (?:completed|failed|cancelled):$/.test(entry.label));
function assertTerminal(entries, event) {
    assert.equal(terminal(entries).length, 1);
    assert.match(terminal(entries)[0].label, new RegExp(`request ${event}:$`));
}
function sse(frames, failure) {
    return { ok: true, body: new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')));
        if (failure) setTimeout(() => controller.error(failure), 5); else controller.close();
    } }) };
}
const answer = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'reply-body-sentinel', thoughtSignature: 'response-signature-private' }] }, continuationToken: 'candidate-token-private' }], continuationToken: 'top-token-private', nativeGeminiSignature: 'native-signature-private', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10, unexpected: 'usage-private' } });

for (const provider of ['makersuite', 'vertexai']) for (const stream of [false, true]) for (const model of ['gemini-4-argon', 'gemini-4-argon-cyber-permissive']) {
    test(`console success preserves transport (${provider}, stream=${stream}, ${model})`, async () => {
        const { logger, entries } = capture();
        let sent;
        const upstream = answer();
        const handler = createNativeGeminiHandler({ runtime, loopbackTransport: { baseUrl }, logger, fetchImpl: async (_url, options) => {
            sent = JSON.parse(options.body);
            return stream ? sse([upstream]) : { ok: true, json: async () => upstream };
        } });
        const res = response();
        await handler(request(input({ chat_completion_source: provider, model, stream })), res);
        const api = provider === 'vertexai' ? 'Google Vertex AI' : 'Google AI Studio';
        assert.equal(entries[0].label, `${api} request:`);
        assert.equal(entries[0].level, 'debug');
        assert.match(entries[0].detail, /prompt-body-sentinel/);
        assert.match(entries[0].detail, /generationConfig/);
        assert.doesNotMatch(entries[0].detail, /messages:|reverse_proxy|proxy_password/);
        assert.equal(sent.contents[0].parts[0].thoughtSignature, 'request-signature-private');
        assertTerminal(entries, 'completed');
        const debug = entries.filter(entry => entry.level === 'debug');
        assert.equal(debug.length, stream ? 1 : 2);
        if (stream) {
            assert.equal(entries.filter(entry => entry.label === `${api} streaming request in progress:`).length, 1);
            assert.match(Buffer.concat(res.chunks).toString(), /response-signature-private/);
        } else {
            assert.equal(debug[1].label, `${api} response:`);
            assert.match(debug[1].detail, /reply-body-sentinel/);
            assert.equal(res.data.responseContent.parts[0].thoughtSignature, 'response-signature-private');
            assert.equal(res.data.continuationToken, 'top-token-private');
        }
        assert.match(terminal(entries)[0].detail, /totalTokenCount/);
        assert.doesNotMatch(terminal(entries)[0].detail, /reply-body-sentinel|usage-private/);
        assert.doesNotMatch(entries.map(entry => entry.detail).join('\n'), /request-signature-private|response-signature-private|candidate-token-private|top-token-private|native-signature-private|credential-private|ticket-private/);
    });
}

for (const kind of ['http', 'sse', 'empty', 'broken']) test(`console failure has one safe terminal (${kind})`, async () => {
    const { logger, entries } = capture();
    const secret = 'https://private.invalid/credential-private';
    const fetchImpl = async () => kind === 'http'
        ? { ok: false, status: 429, json: async () => ({ code: 'GEMINI4_UPSTREAM_HTTP_ERROR', message: secret, details: { upstreamMessage: secret } }) }
        : kind === 'sse' ? sse([{ error: { code: 'GEMINI4_UPSTREAM_HTTP_ERROR', message: secret } }])
            : kind === 'empty' ? sse([{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: 'thought-private' }] } }] }])
                : sse([{ candidates: [{ content: { parts: [{ text: 'partial-private' }] } }] }], new Error(secret));
    const res = response();
    await createNativeGeminiHandler({ runtime, loopbackTransport: { baseUrl }, logger, fetchImpl })(request(input({ stream: kind !== 'http' })), res);
    assertTerminal(entries, 'failed');
    const failure = terminal(entries)[0];
    assert.equal(failure.level, 'warn');
    assert.match(failure.detail, /code:/);
    assert.doesNotMatch(failure.detail, /private|https:|stack|message/);
    assert.doesNotMatch(entries.map(entry => entry.detail).join('\n'), /thought-private|partial-private/);
});

test('console cancellation is distinct and aborts upstream', async () => {
    const { logger, entries } = capture();
    let signal;
    const fetchImpl = async (_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(new Error('private cancellation detail')));
    });
    const req = request(input({ stream: true })), res = response();
    const pending = createNativeGeminiHandler({ runtime, loopbackTransport: { baseUrl }, logger, fetchImpl })(req, res);
    await new Promise(resolve => setImmediate(resolve));
    res.emit('close');
    await pending;
    assert.equal(signal.aborted, true);
    assertTerminal(entries, 'cancelled');
    assert.doesNotMatch(terminal(entries)[0].detail, /private/);
    assert.equal(req.listenerCount('aborted'), 0);
});

for (const stream of [false, true]) test(`throwing console logger cannot break generation (stream=${stream})`, async () => {
    const logger = Object.fromEntries(['debug', 'info', 'warn'].map(level => [level, () => { throw new Error('logger failed'); }]));
    const res = response();
    await createNativeGeminiHandler({ runtime, loopbackTransport: { baseUrl }, logger, fetchImpl: async () => stream ? sse([answer()]) : { ok: true, json: async () => answer() } })(request(input({ stream })), res);
    assert.equal(res.writableEnded, true);
    assert.match(stream ? Buffer.concat(res.chunks).toString() : res.data.choices[0].message.content, /reply-body-sentinel/);
});

test('throwing warning logger cannot suppress the host error response', async () => {
    const logger = { debug() {}, warn() { throw new Error('logger failed'); } };
    const res = response();
    await createNativeGeminiHandler({ runtime, loopbackTransport: { baseUrl }, logger, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ code: 'GEMINI4_UPSTREAM_HTTP_ERROR', message: 'quota' }) }) })(request(input()), res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.data.error.code, 'GEMINI4_UPSTREAM_HTTP_ERROR');
});
