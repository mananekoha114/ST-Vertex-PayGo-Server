'use strict';
// Dedicated host streaming check (npm run test:host-streaming).
//
// Runs the real loopback proxy, Gemini 4 transport and native route inside
// SillyTavern's own express stack: compression() and body-parser are mounted
// globally before plugin routers, as in src/server-main.js. Every scenario
// below once surfaced as "Argon writes nothing": SSE frames held back by
// compression, Google errors without a reason, a thinking-only budget and
// silent mid-stream failures. Frames are parsed with the host's own
// getStreamingReply and tryParseStreamingError.
//
// PAYGO_ST_ROOT selects a SillyTavern checkout with installed dependencies
// (default: ../SillyTavern-1.18.0 next to this repository). PAYGO_REQUIRE_HOST=1
// turns a missing host into a failure instead of a skip, for CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');
const { createNativeGeminiHandler } = require('../src/native-gemini.cjs');

const hostRoot = path.resolve(process.env.PAYGO_ST_ROOT || path.join(__dirname, '../../SillyTavern-1.18.0'));
const FRAME_TIMEOUT_MS = 5000;
const MODEL = 'gemini-4-argon';

function loadHost() {
    try {
        const hostRequire = createRequire(path.join(hostRoot, 'package.json'));
        const read = file => fs.readFileSync(path.join(hostRoot, file), 'utf8');
        return { express: hostRequire('express'), compression: hostRequire('compression'), bodyParser: hostRequire('body-parser'),
            converters: read('src/prompt-converters.js'), openai: read('public/scripts/openai.js') };
    } catch (error) {
        if (process.env.PAYGO_REQUIRE_HOST === '1') throw error;
        return null;
    }
}
const host = loadHost();
const skip = host ? false : `SillyTavern with installed dependencies was not found at ${hostRoot}`;

function extract(source, name) {
    const start = source.indexOf(`export function ${name}(`);
    assert(start >= 0, `host function ${name}`);
    return source.slice(start).match(/^[\s\S]*?^}\r?$/m)[0].replace('export ', '');
}

// The host's own prompt converter, stream parser and error toast parser.
function hostFunctions() {
    const toasts = [];
    const sandbox = vm.createContext({ enableThoughtSignatures: true, GEMINI_MEDIA_RESOLUTION: {},
        tryParse: text => { try { return JSON.parse(text); } catch { return null; } },
        chat_completion_sources: new Proxy({}, { get: (_, key) => key }), oai_settings: { show_thoughts: true },
        isDataURL: () => false, checkQuotaError: () => {}, checkModerationError: () => {},
        toastr: { error: message => toasts.push(message), warning: () => {}, info: () => {} } });
    vm.runInContext([extract(host.converters, 'convertGooglePrompt'), extract(host.openai, 'getStreamingReply'),
        extract(host.openai, 'tryParseStreamingError')].join('\n'), sandbox);
    return { sandbox, toasts };
}

// Google stand-in: each hop is scripted and may wait for the browser side.
function createUpstream(hops) {
    const calls = [];
    const failures = [];
    const upstreamRequest = (target, options, callback) => {
        const outgoing = new PassThrough();
        const chunks = [];
        outgoing.on('data', chunk => chunks.push(chunk));
        outgoing.on('finish', () => {
            const hop = calls.length;
            calls.push({ target: target.toString(), body: JSON.parse(Buffer.concat(chunks).toString()) });
            const incoming = new PassThrough();
            const script = hops[hop];
            const io = {
                send: value => incoming.write(`data: ${JSON.stringify(value)}\n\n`),
                end: () => incoming.end(),
                fail(status, body) { incoming.statusCode = status; incoming.end(JSON.stringify(body)); },
            };
            incoming.headers = { 'content-type': 'text/event-stream' };
            if (script.status) {
                incoming.headers = { 'content-type': 'application/json' };
                io.fail(script.status, script.body);
                callback(incoming);
                return;
            }
            incoming.statusCode = 200;
            callback(incoming);
            Promise.resolve().then(() => script(io)).catch(error => { failures.push(error); incoming.destroy(error); });
        });
        return outgoing;
    };
    return { calls, failures, upstreamRequest };
}

const frame = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] });
const usage = (candidates, thoughts) => ({ usageMetadata: { promptTokenCount: 8, candidatesTokenCount: candidates, thoughtsTokenCount: thoughts, totalTokenCount: 8 + candidates + thoughts } });

async function startHost(hops, { stripNoTransform = false } = {}) {
    const { sandbox, toasts } = hostFunctions();
    const upstream = createUpstream(hops);
    const store = new TicketStore();
    const transport = createLoopbackTransport({ ticketStore: store, usageStore: { update() {} }, upstreamRequest: upstream.upstreamRequest });
    await transport.start();
    const runtime = { getNativeGeminiHelpers: async () => ({ convertGooglePrompt: sandbox.convertGooglePrompt, GEMINI_SAFETY: [], VERTEX_SAFETY: [] }) };
    const { express, compression, bodyParser } = host;
    const app = express();
    app.use(compression());
    app.use(bodyParser.json({ limit: '500mb' }));
    app.use((request, response, next) => {
        request.user = { directories: { root: 'host-streaming-user' } };
        if (stripNoTransform) {
            // Negative control: the pre-fix header, proving compression is live here.
            const setHeader = response.setHeader;
            response.setHeader = function (name, value) {
                return setHeader.call(this, name, String(name).toLowerCase() === 'cache-control' ? 'no-store' : value);
            };
        }
        next();
    });
    const router = express.Router();
    router.post('/native-gemini/generate', createNativeGeminiHandler({ runtime, loopbackTransport: transport }));
    app.use('/api/plugins/vertex-paygo', router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        sandbox, toasts, upstream, store, transport, server,
        async close() {
            store.close();
            await transport.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    };
}

// Browser-like client: advertises br/gzip and records frames as they arrive.
function generate(env, source, body = {}) {
    const endpoint = 'streamGenerateContent';
    const targetUrl = source === 'vertexai'
        ? `https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/${MODEL}:${endpoint}?alt=sse`
        : `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:${endpoint}?alt=sse`;
    const ticket = env.store.create({ source, model: MODEL, stream: true, endpoint, tier: 'standard',
        region: source === 'vertexai' ? 'global' : undefined, targetUrl,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-google-only' }, usageReference: null });
    const payload = JSON.stringify({ model: MODEL, stream: true, chat_completion_source: source, max_tokens: 64,
        include_reasoning: true, reasoning_effort: 'medium', native_gemini_api_version: 'v1beta',
        vertexai_auth_mode: 'express', vertexai_region: 'global', messages: [{ role: 'user', content: 'Question' }],
        reverse_proxy: `${env.transport.baseUrl}/proxy/${ticket.ticket}`, proxy_password: ticket.proxySecret, ...body });
    const frames = [];
    const waiters = [];
    let text = '';
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const notify = () => { for (const waiter of [...waiters]) if (frames.length >= waiter.count) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); } };
    const request = http.request({ host: '127.0.0.1', port: env.server.address().port, method: 'POST',
        path: '/api/plugins/vertex-paygo/native-gemini/generate',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate, br' } }, response => {
        let buffer = '';
        response.setEncoding('latin1');
        response.on('data', chunk => {
            text += chunk;
            if (response.headers['content-encoding']) return;
            buffer += chunk;
            const parts = buffer.split(/\r?\n\r?\n/u);
            buffer = parts.pop();
            for (const part of parts) if (part.trim()) frames.push(Buffer.from(part, 'latin1').toString('utf8').replace(/^data: ?/u, ''));
            notify();
        });
        response.on('end', () => resolveDone({ status: response.statusCode, headers: response.headers, frames, text: Buffer.from(text, 'latin1').toString('utf8') }));
        response.on('error', rejectDone);
    });
    request.on('error', rejectDone);
    request.end(payload);
    return {
        done,
        frames,
        waitFor(count) {
            if (frames.length >= count) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Frame ${count} did not reach the client within ${FRAME_TIMEOUT_MS} ms; the host is buffering the stream.`)), FRAME_TIMEOUT_MS);
                waiters.push({ count, resolve: () => { clearTimeout(timer); resolve(); } });
            });
        },
    };
}

function readFrames(env, source, frames) {
    const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
    let text = '';
    for (const raw of frames) {
        env.sandbox.tryParseStreamingError({ statusText: 'OK' }, raw);
        text += env.sandbox.getStreamingReply(JSON.parse(raw), state, { chatCompletionSource: source.toUpperCase(), overrideShowThoughts: true });
    }
    return { text, reasoning: state.reasoning };
}

for (const source of ['makersuite', 'vertexai']) {
    test(`host stack delivers every SSE frame before Google sends the next one (${source})`, { skip }, async () => {
        let client;
        const env = await startHost([async io => {
            io.send(frame([{ thought: true, text: 'thinking' }]));
            await client.waitFor(1);
            io.send(frame([{ text: 'Hello', thoughtSignature: 'sig' }]));
            await client.waitFor(2);
            io.send({ ...frame([{ text: ' world' }], { finishReason: 'STOP' }), ...usage(2, 4) });
            io.end();
        }]);
        try {
            client = generate(env, source);
            const result = await client.done;
            assert.deepEqual(env.upstream.failures, []);
            assert.equal(result.status, 200);
            assert.equal(result.headers['content-encoding'], undefined);
            assert.match(result.headers['cache-control'], /no-transform/u);
            assert.equal(result.headers['x-accel-buffering'], 'no');
            assert.deepEqual(readFrames(env, source, result.frames), { text: 'Hello world', reasoning: 'thinking' });
            assert.deepEqual(env.toasts, []);
        } finally { await env.close(); }
    });
}

test('negative control: without no-transform the host compresses and holds the stream', { skip }, async () => {
    const env = await startHost([async io => {
        io.send(frame([{ text: 'Hello' }]));
        io.send({ ...frame([], { finishReason: 'STOP' }), ...usage(1, 0) });
        io.end();
    }], { stripNoTransform: true });
    try {
        const result = await generate(env, 'makersuite').done;
        assert.match(result.headers['content-encoding'] ?? '', /^(br|gzip|deflate)$/u);
    } finally { await env.close(); }
});

test('Google rejection before streaming reaches the host toast with its reason', { skip }, async () => {
    const env = await startHost([{ status: 400, body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Gemini 4 Argon is not available on the free tier.' } } }]);
    try {
        const result = await generate(env, 'makersuite').done;
        assert.equal(result.status, 400);
        env.sandbox.tryParseStreamingError({ statusText: 'Bad Request' }, result.text);
        assert.deepEqual(env.toasts, ['The Google upstream returned HTTP 400 FAILED_PRECONDITION: Gemini 4 Argon is not available on the free tier.']);
    } finally { await env.close(); }
});

test('thinking that exhausts the output budget ends with a host-visible explanation', { skip }, async () => {
    const env = await startHost([async io => {
        io.send(frame([{ thought: true, text: 'long thinking' }]));
        io.send({ ...frame([{ text: '' }], { finishReason: 'MAX_TOKENS' }), continuationToken: 'more', ...usage(0, 64) });
        io.end();
    }]);
    try {
        const result = await generate(env, 'makersuite').done;
        assert.equal(result.status, 200);
        assert.equal(env.upstream.calls.length, 1);
        assert.deepEqual(readFrames(env, 'makersuite', result.frames), { text: '', reasoning: 'long thinking' });
        assert.equal(env.toasts.length, 1);
        assert.match(env.toasts[0], /whole output budget/u);
    } finally { await env.close(); }
});

test('a Google failure on a continuation hop ends the stream with a host-visible error', { skip }, async () => {
    let client;
    const env = await startHost([async io => {
        io.send({ ...frame([{ text: 'Partial' }], { finishReason: 'CONTINUATION' }), continuationToken: 'next', ...usage(4, 0) });
        await client.waitFor(1);
        io.end();
    }, { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } } }]);
    try {
        client = generate(env, 'vertexai');
        const result = await client.done;
        assert.equal(result.status, 200);
        assert.equal(env.upstream.calls[1].body.continuationToken, 'next');
        assert.equal(readFrames(env, 'vertexai', result.frames).text, 'Partial');
        assert.deepEqual(env.toasts, ['The Google upstream returned HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded.']);
    } finally { await env.close(); }
});
