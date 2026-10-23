'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { runGemini4Transport, isGemini4Argon } = require('../src/gemini4-transport.cjs');
const { validatePreparedGoogleTarget } = require('../src/target-policy.cjs');
async function fixture(stream, replies, body = {}, { source = 'vertexai' } = {}) {
    const sent = []; let output = ''; let latest;
    const response = new Writable({ write(chunk, encoding, done) { output += chunk.toString(); done(); } });
    response.writeHead = () => { response.headersSent = true; };
    const ticketData = { model: 'gemini-4-argon', region: 'global', stream, headers: {}, source };
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const target = source === 'makersuite' ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:${action}`
        : `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:${action}`;
    try { await runGemini4Transport({request: Readable.from([Buffer.from(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'original' }] }], generationConfig: { maxOutputTokens: 100, temperature: 1, thinkingConfig: { includeThoughts: true } }, ...body }))]), response, ticketData, target,
        maxBodyBytes: 100000, upstreamTimeoutMs: 1000, onUsage: usage => { latest = usage; },
        upstreamRequest(url, options, callback) {
            assert.match(url.pathname, source === 'makersuite' ? /^\/v1beta\//u : /^\/v1beta1\//u);
            const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
            req.end = bytes => {
                sent.push(JSON.parse(bytes)); const reply = replies.shift();
                if (reply instanceof Error) { queueMicrotask(() => req.emit('error', reply)); return; }
                const failed = Number.isInteger(reply.status);
                const text = failed ? JSON.stringify(reply.body) : stream ? reply.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') : JSON.stringify(reply);
                const bytesOut = Buffer.from(text);
                const incoming = Readable.from([...bytesOut].map(byte => Buffer.from([byte])));
                incoming.statusCode = failed ? reply.status : 200; incoming.headers = {};
                queueMicrotask(() => callback(incoming));
            };
            return req;
        } });
    } catch (error) { throw Object.assign(error, { output, sent }); }
    return { sent, output, latest };
}
const value = (text, finishReason, token, count) => ({ candidates: [{ content: { role: 'model', parts: [{ text, thoughtSignature: 'signature' }, { text: '尾' }] }, finishReason }], ...(token ? { continuationToken: token } : {}), usageMetadata: { promptTokenCount: 5, candidatesTokenCount: count, totalTokenCount: 5 + count } });
test('nonstream continues with unchanged original prompt and cap; sums final usage and retains parts/signatures', async () => {
    const result = await fixture(false, [value('一', 'CONTINUATION', 'token', 10), value('二', 'STOP', null, 12)]);
    assert.equal(result.sent.length, 2);
    assert.deepEqual(result.sent[0].contents, result.sent[1].contents);
    assert.equal(result.sent[1].generationConfig.maxOutputTokens, 100);
    assert.equal(result.sent[0].generationConfig.temperature, undefined);
    assert.equal(result.sent[0].generationConfig.thinkingConfig.includeThoughts, true);
    assert.equal(result.sent[1].continuationToken, 'token');
    const output = JSON.parse(result.output);
    assert.equal(output.candidates[0].content.parts.length, 4);
    assert.equal(output.candidates[0].content.parts[0].thoughtSignature, 'signature');
    assert.equal(output.continuationToken, undefined);
    assert.equal(result.latest.candidatesTokenCount, 22);
});
test('stream splits parts and UTF8; counts only final cumulative usage per hop', async () => {
    const result = await fixture(true, [[value('一', undefined, null, 2), value('二', 'CONTINUATION', 'next', 10)], [value('三', 'STOP', null, 15)]]);
    const events = result.output.trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    assert.equal(events.length, 7);
    assert.equal(events[0].candidates[0].content.parts[0].text, '一');
    assert.equal(events.at(-1).usageMetadata.candidatesTokenCount, 25);
    assert.equal(events.at(-1).continuationToken, undefined);
});
test('MAX_TOKENS never requests another budget', async () => {
    const result = await fixture(false, [value('limit', 'MAX_TOKENS', 'next', 10)]);
    assert.equal(result.sent.length, 1);
    assert.equal(JSON.parse(result.output).candidates[0].finishReason, 'MAX_TOKENS');
});
test('continuation failures reject without synthetic STOP', async () => {
    await assert.rejects(fixture(true, [[value('partial', 'CONTINUATION', 'next', 10)], new Error('offline')]), /offline/u);
});
test('missing token does not continue; repeated token fails', async () => {
    await assert.rejects(fixture(false, [value('x', 'CONTINUATION', null, 10)]), /did not include a token/u);
    await assert.rejects(fixture(false, [value('x', 'CONTINUATION', 'same', 10), value('y', 'CONTINUATION', 'same', 10)]), /continuation limit/u);
});
test('model gate and beta target remain tightly scoped', () => {
    assert.equal(isGemini4Argon('gemini-4-argon-cyber-permissive'), true);
    assert.equal(isGemini4Argon('gemini-3-pro'), false);
    assert.throws(() => validatePreparedGoogleTarget('https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-3-pro:generateContent', {model: 'gemini-3-pro', region: 'global', stream: false}));
    assert.throws(() => validatePreparedGoogleTarget('https://evil.test/v1beta1/publishers/google/models/gemini-4-argon:generateContent', {model: 'gemini-4-argon', region: 'global', stream: false}));
});
test('client close destroys active upstream and rejects pending hop', async () => {
    const response = new Writable({ write(chunk, encoding, done) { done(); } });
    response.writeHead = () => {};
    let destroyed = false;
    const pending = runGemini4Transport({
        request: Readable.from([Buffer.from('{"generationConfig":{"maxOutputTokens":100}}')]), response,
        ticketData: { model: 'gemini-4-argon', region: 'global', stream: false, headers: {} },
        target: 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:generateContent',
        maxBodyBytes: 1000, upstreamTimeoutMs: 1000,
        upstreamRequest() {
            const upstream = new EventEmitter();
            upstream.setTimeout = () => {};
            upstream.end = () => queueMicrotask(() => response.destroy());
            upstream.destroy = error => { destroyed = true; if (error) upstream.emit('error', error); };
            return upstream;
        },
    });
    await assert.rejects(pending, /client disconnected/iu);
    assert.equal(destroyed, true);
});

test('candidate continuation token works; intermediate SSE removes both token locations', async () => {
    const first = value('candidate', 'CONTINUATION', null, 10);
    first.candidates[0].continuationToken = 'candidate-token';
    const last = value('end', 'STOP', null, 10);
    const result = await fixture(true, [[first], [last]]);
    assert.equal(result.sent[1].continuationToken, 'candidate-token');
    const events = result.output.trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
    for (const event of events) { assert.equal(event.continuationToken, undefined); assert.equal(event.candidates?.[0]?.continuationToken, undefined); }
});
test('thinking-only usage can continue and is charged against the explicit budget', async () => {
    const first = value('thinking', 'CONTINUATION', 'thinking-token', 0);
    first.usageMetadata = { thoughtsTokenCount: 5, promptTokenCount: 3 };
    const result = await fixture(false, [first, value('answer', 'STOP', null, 10)]);
    assert.equal(result.sent.length, 2);
    assert.equal(result.latest.thoughtsTokenCount, 5);
});
test('continuation with unknown budget or usage is explicit failure', async () => {
    await assert.rejects(fixture(false, [value('x', 'CONTINUATION', 'next', 10)], { generationConfig: {} }), /explicit output budget/u);
    const first = value('x', 'CONTINUATION', 'next', 10); delete first.usageMetadata;
    await assert.rejects(fixture(false, [first]), /explicit output budget/u);
});
test('continuation stops at total user output cap with MAX_TOKENS', async () => {
    const result = await fixture(false, [value('x', 'CONTINUATION', 'next', 100)]);
    assert.equal(result.sent.length, 1);
    assert.equal(JSON.parse(result.output).candidates[0].finishReason, 'MAX_TOKENS');
});
test('terminal metadata-only candidate retains model role', async () => {
    const result = await fixture(true, [[value('text', undefined, null, 2), { candidates: [{ finishReason: 'STOP' }], usageMetadata: { candidatesTokenCount: 2 } }]]);
    const last = JSON.parse(result.output.trim().split('\n\n').at(-1).slice(6));
    assert.equal(last.candidates[0].content.role, 'model');
});
test('stream EOF without a terminal reason fails instead of completing partial text', async () => {
    await assert.rejects(fixture(true, [[value('partial', undefined, null, 10)]]), error => error.code === 'GEMINI4_INCOMPLETE_RESPONSE');
});
test('stream prompt feedback block is a terminal response without candidate finishReason', async () => {
    const result = await fixture(true, [[{ promptFeedback: { blockReason: 'SAFETY' } }]]);
    assert.match(result.output, /SAFETY/u);
});

test('AI Studio per-request MAX_TOKENS with a token resumes within the unchanged total budget', async () => {
    const result = await fixture(false, [value('一', 'MAX_TOKENS', 'cap', 10), value('二', 'STOP', null, 12)], {}, { source: 'makersuite' });
    assert.equal(result.sent.length, 2);
    assert.equal(result.sent[1].continuationToken, 'cap');
    assert.equal(result.sent[1].generationConfig.maxOutputTokens, 100);
    assert.equal(JSON.parse(result.output).candidates[0].finishReason, 'STOP');
    const exhausted = await fixture(false, [value('x', 'MAX_TOKENS', 'cap', 100)], {}, { source: 'makersuite' });
    assert.equal(exhausted.sent.length, 1);
    assert.equal(JSON.parse(exhausted.output).candidates[0].finishReason, 'MAX_TOKENS');
    const vertex = await fixture(false, [value('x', 'MAX_TOKENS', 'cap', 10)]);
    assert.equal(vertex.sent.length, 1);
});
test('Google HTTP errors keep the redacted Google reason and status', async () => {
    const key = `AIza${'a'.repeat(35)}`;
    await assert.rejects(fixture(false, [{ status: 400, body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: `Key ${key} cannot use\n this model on the free tier.` } } }], {}, { source: 'makersuite' }), error => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'GEMINI4_UPSTREAM_HTTP_ERROR');
        assert.equal(error.message, 'The Google upstream returned HTTP 400 FAILED_PRECONDITION: Key [redacted] cannot use this model on the free tier.');
        assert.deepEqual(error.details, { upstreamStatus: 400, googleStatus: 'FAILED_PRECONDITION', upstreamMessage: 'Key [redacted] cannot use this model on the free tier.' });
        return true;
    });
    await assert.rejects(fixture(false, [{ status: 503, body: 'not json' }]), error => error.status === 503 && error.message === 'The Google upstream returned HTTP 503.');
});
test('stream failure after output started ends with an SSE error event', async () => {
    await assert.rejects(fixture(true, [[value('partial', 'CONTINUATION', 'next', 10)], { status: 429, body: { error: { message: 'Quota exceeded' } } }]), error => {
        const frames = error.output.trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /u, '')));
        assert.equal(frames[0].candidates[0].content.parts[0].text, 'partial');
        assert.deepEqual(frames.at(-1), { error: { code: 'GEMINI4_UPSTREAM_HTTP_ERROR', message: 'The Google upstream returned HTTP 429: Quota exceeded', details: { upstreamStatus: 429, upstreamMessage: 'Quota exceeded' } } });
        return true;
    });
});
