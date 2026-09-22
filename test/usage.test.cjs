/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageCapture } = require('../src/usage-capture.cjs');
const { UsageStore } = require('../src/usage-store.cjs');
const { createUsageHandler } = require('../src/usage-route.cjs');
const { validatePreparePayload } = require('../src/protocol.cjs');
const { buildPayGoHeaders } = require('../src/header-policy.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');
const { PassThrough } = require('node:stream');

test('usage capture handles split SSE and keeps the latest cumulative metadata', () => {
    const capture = new UsageCapture({ stream: true });
    const body = [
        'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}\n\n',
        'data: {"text":"你好","usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":3,"candidatesTokenCount":7,"thoughtsTokenCount":4,"trafficType":"ON_DEMAND"}}\n\n',
    ].join('');
    const bytes = Buffer.from(body);
    for (const chunk of [bytes.subarray(0, 17), bytes.subarray(17, 83), bytes.subarray(83, 111), bytes.subarray(111)]) capture.write(chunk);
    assert.deepEqual(capture.finish(), {
        promptTokenCount: 10,
        cachedContentTokenCount: 3,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 4,
        toolUsePromptTokenCount: 0,
        trafficType: 'ON_DEMAND',
    });
});

test('partial cumulative SSE frames merge fields without summing or clearing earlier counts', () => {
    const capture = new UsageCapture({ stream: true });
    capture.write(Buffer.from('data: {"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":6,"thoughtsTokenCount":2}}\n\n'));
    capture.write(Buffer.from('data: {"usageMetadata":{"candidatesTokenCount":7}}\n\n'));
    assert.deepEqual(capture.finish(), {
        promptTokenCount: 10,
        cachedContentTokenCount: 6,
        thoughtsTokenCount: 2,
        candidatesTokenCount: 7,
        toolUsePromptTokenCount: 0,
    });
});

test('usage capture reads non-stream JSON without retaining generated content', () => {
    const capture = new UsageCapture({ stream: false });
    capture.write(Buffer.from('{"candidates":[{"content":{"parts":[{"text":"secret response"}]}}],'));
    capture.write(Buffer.from('"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":8}}'));
    assert.deepEqual(capture.finish(), {
        promptTokenCount: 5,
        candidatesTokenCount: 8,
        cachedContentTokenCount: 0,
        thoughtsTokenCount: 0,
        toolUsePromptTokenCount: 0,
    });
});

test('usage ledger persists, immediately recovers prior-process pending records, and isolates user roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-usage-'));
    const userA = { directories: { root: path.join(root, 'a') } };
    const userB = { directories: { root: path.join(root, 'b') } };
    let now = Date.UTC(2026, 0, 1);
    try {
        const first = new UsageStore({ now: () => now, pendingTimeoutMs: 1000 });
        const reference = first.create(userA, {
            chatId: 'chat-1', model: 'gemini-2.5-pro', source: 'vertexai', tier: 'standard',
            region: 'us-central1', stream: true, price: { input: 1, cachedInput: 0.1, output: 2 },
        });
        assert.match(reference.id, /^[0-9a-f-]{36}$/u);
        assert.deepEqual(first.list(userB, 'chat-1'), []);
        const restarted = new UsageStore({ now: () => now, pendingTimeoutMs: 1000 });
        const [record] = restarted.list(userA, 'chat-1');
        assert.equal(record.status, 'incomplete');
        assert.equal(record.errorCode, 'PROCESS_RESTARTED');
        assert.equal(record.usage, null);
        assert.deepEqual(record.price, { input: 1, cachedInput: 0.1, output: 2 });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('usage route requires a real user root and returns only the requested chat', () => {
    const calls = [];
    const handler = createUsageHandler({ usageStore: { list(user, chatId, page) { calls.push({ user, chatId, page }); return { records: [{ id: 'usage' }] }; } } });
    const response = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler({ query: { chatId: 'chat:abc' }, user: { directories: { root: 'user-a' } } }, response);
    assert.deepEqual(response.body, { ok: true, records: [{ id: 'usage' }] });
    assert.equal(calls[0].chatId, 'chat:abc');

    const anonymous = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    handler({ query: { chatId: 'chat:abc' }, user: { directories: {} } }, anonymous);
    assert.equal(anonymous.statusCode, 401);
});

test('large JSON scans only top-level usage metadata and oversized SSE resumes at the next event', () => {
    const json = new UsageCapture({ stream: false, maxBufferBytes: 256 });
    json.write(Buffer.from(`{"candidates":[{"content":{"parts":[{"text":"${'x'.repeat(3 * 1024 * 1024)}"}]}}],`));
    json.write(Buffer.from('"usageMetadata":{"promptTokenCount":21,"candidatesTokenCount":34}}'));
    assert.equal(json.finish().candidatesTokenCount, 34);
    assert.equal(json.limitExceeded, false);

    const sse = new UsageCapture({ stream: true, maxBufferBytes: 256 });
    sse.write(Buffer.from(`data: {"text":"${'x'.repeat(1024)}"}\n\n`));
    sse.write(Buffer.from('data: {"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":9}}\n\n'));
    assert.equal(sse.finish().candidatesTokenCount, 9);
    assert.equal(sse.limitExceeded, false);

    const truncatedFinal = new UsageCapture({ stream: true, maxBufferBytes: 256 });
    truncatedFinal.write(Buffer.from('data: {"usageMetadata":{"promptTokenCount":8}}\n\n'));
    truncatedFinal.write(Buffer.from(`data: {"usageMetadata":{"candidatesTokenCount":9},"padding":"${'x'.repeat(1024)}"}\n\n`));
    assert.equal(truncatedFinal.finish().promptTokenCount, 8);
    assert.equal(truncatedFinal.limitExceeded, true);
});

test('usage ledger pagination has a stable snapshot and never deletes history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-usage-pages-'));
    const user = { directories: { root } };
    const store = new UsageStore();
    const details = { chatId: 'chat-pages', model: 'gemini', source: 'vertexai', tier: 'standard', region: 'global', stream: false, price: null };
    try {
        for (let index = 0; index < 3; index += 1) store.create(user, details);
        const first = store.list(user, 'chat-pages', { limit: 2 });
        assert.equal(first.records.length, 2);
        assert.equal(first.truncated, true);
        assert.equal(typeof first.nextCursor, 'string');
        store.create(user, details);
        const second = store.list(user, 'chat-pages', { limit: 2, cursor: first.nextCursor });
        assert.equal(second.records.length, 1);
        assert.equal(second.nextCursor, undefined);
        assert.equal(store.list(user, 'chat-pages').length, 4);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('usage ledger caches its folded JSONL index and times out live pending records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-usage-index-'));
    const user = { directories: { root } };
    let reads = 0;
    let now = Date.UTC(2026, 0, 1);
    const countedFs = Object.create(fs);
    countedFs.readFileSync = (...args) => { reads += 1; return fs.readFileSync(...args); };
    const store = new UsageStore({ fsModule: countedFs, now: () => now, pendingTimeoutMs: 1000 });
    try {
        store.create(user, { chatId: 'chat-index', model: 'gemini', source: 'vertexai', tier: 'standard', region: 'global', stream: false, price: null });
        store.list(user, 'chat-index');
        assert.equal(reads, 1);
        now += 1001;
        const [record] = store.list(user, 'chat-index');
        assert.equal(record.status, 'incomplete');
        assert.equal(record.errorCode, 'USAGE_CAPTURE_TIMEOUT');
        assert.equal(reads, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Standard is proxied for both Google sources without tier headers or body policy', () => {
    for (const source of ['vertexai', 'makersuite']) {
        const config = validatePreparePayload({
            protocolVersion: 2, chat_completion_source: source, model: 'gemini-2.5-flash', stream: false,
            tier: 'standard', paygoOnly: false,
            ...(source === 'vertexai' ? { vertexai_auth_mode: 'full', vertexai_region: 'us-central1' } : {}),
        });
        assert.equal(config.tier, 'standard');
        assert.deepEqual(buildPayGoHeaders(config), {});
    }
});

test('usage price and chat identifiers are validated and snapshotted', () => {
    const config = validatePreparePayload({
        protocolVersion: 2, chat_completion_source: 'vertexai', model: 'gemini-2.5-pro', stream: true,
        tier: 'standard', paygoOnly: false, vertexai_auth_mode: 'full', vertexai_region: 'global',
        usageChatId: '123e4567-e89b-12d3-a456-426614174000',
        usagePrice: { input: 1.25, cachedInput: 0.2, output: 10, longContextThreshold: 200000, longInput: 2.5, longCachedInput: 0.4, longOutput: 15 },
    });
    assert.equal(config.usagePrice.longOutput, 15);
    const thresholdOnly = validatePreparePayload({
        protocolVersion: 2, chat_completion_source: 'vertexai', model: 'gemini-2.5-pro', stream: false,
        tier: 'standard', paygoOnly: false, vertexai_auth_mode: 'full', vertexai_region: 'global',
        usagePrice: { input: 1, cachedInput: 0.1, output: 3, longContextThreshold: 200000 },
    });
    assert.equal(thresholdOnly.usagePrice.longContextThreshold, 200000);
    assert.equal(thresholdOnly.usagePrice.longInput, undefined);
    assert.throws(() => validatePreparePayload({ ...config, chat_completion_source: config.source, vertexai_region: config.region, vertexai_auth_mode: config.authMode, usagePrice: { input: -1, cachedInput: 0, output: 1 } }), { code: 'INVALID_PREPARE_REQUEST' });
});

for (const stream of [true, false]) {
    test(`Standard proxy records ${stream ? 'split SSE' : 'JSON'} usage end to end`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-usage-e2e-'));
        const user = { directories: { root } };
        const usageStore = new UsageStore();
        const ticketStore = new TicketStore();
        const calls = [];
        const transport = createLoopbackTransport({
            usageStore, ticketStore,
            upstreamRequest(_target, options, callback) {
                calls.push(options);
                const request = new PassThrough();
                request.on('data', () => {});
                request.on('finish', () => {
                    const response = new PassThrough();
                    response.statusCode = 200;
                    response.headers = { 'content-type': stream ? 'text/event-stream' : 'application/json' };
                    callback(response);
                    const payload = stream
                        ? 'data: {"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":13}}\n\n'
                        : '{"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":13}}';
                    response.write(payload.slice(0, 19));
                    response.end(payload.slice(19));
                });
                return request;
            },
        });
        await transport.start();
        try {
            const usage = usageStore.create(user, {
                chatId: 'chat-e2e', model: 'gemini-2.5-flash', source: 'vertexai', tier: 'standard',
                region: 'us-central1', stream, price: null,
            });
            const issued = ticketStore.create({
                targetUrl: `https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/gemini-2.5-flash:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer private' },
                source: 'vertexai', model: 'gemini-2.5-flash', stream,
                endpoint: stream ? 'streamGenerateContent' : 'generateContent', tier: 'standard', region: 'us-central1',
                usageReference: { file: usage.file, id: usage.id },
            });
            const url = `${transport.baseUrl}/proxy/${issued.ticket}/v1/publishers/google/models/gemini-2.5-flash:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
            const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${issued.proxySecret}` }, body: '{}' });
            assert.equal(response.status, 200);
            await response.text();
            const [record] = usageStore.list(user, 'chat-e2e');
            assert.equal(record.status, 'complete');
            assert.equal(record.usage.promptTokenCount, 11);
            assert.equal(record.usage.candidatesTokenCount, 13);
            assert.equal(record.price, null);
            assert.equal(Object.keys(calls[0].headers).some(name => /LLM|Server-Timeout/iu.test(name)), false);
        } finally {
            ticketStore.close();
            await transport.close();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}
