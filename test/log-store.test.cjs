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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    LOG_FILE_NAME,
    LogStore,
    describeError,
    validateClientLogEvent,
} = require('../src/log-store.cjs');

function makeTemporaryRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-paygo-log-'));
}

test('log store writes safe server and client JSON lines in the configured root', () => {
    const rootDir = makeTemporaryRoot();
    const now = () => new Date('2026-09-05T01:02:03.456Z');
    const store = new LogStore({ rootDir, now });
    try {
        assert.equal(store.filePath, path.join(rootDir, LOG_FILE_NAME));
        assert.equal(store.server('info', 'plugin_ready', {
            model: 'gemini-2.5-pro',
            authorization: 'Bearer private-token',
            requestBody: 'private prompt',
        }), true);
        assert.equal(store.client('warn', 'health_failed', {
            clientVersion: '0.3.0',
            statusCode: 503,
        }), true);

        const records = store.read().trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(records, [
            {
                timestamp: '2026-09-05T01:02:03.456Z',
                source: 'server',
                level: 'info',
                event: 'plugin_ready',
                context: { model: 'gemini-2.5-pro' },
            },
            {
                timestamp: '2026-09-05T01:02:03.456Z',
                source: 'client',
                level: 'warn',
                event: 'health_failed',
                context: { clientVersion: '0.3.0', statusCode: 503 },
            },
        ]);
        assert.doesNotMatch(store.read(), /private-token|private prompt/u);
    } finally {
        store.close();
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('opening a log store overwrites the previous startup log', () => {
    const rootDir = makeTemporaryRoot();
    const filePath = path.join(rootDir, LOG_FILE_NAME);
    fs.writeFileSync(filePath, 'previous-start-private-data\n');

    let firstStore;
    let secondStore;
    try {
        firstStore = new LogStore({ rootDir });
        assert.equal(firstStore.read(), '');
        firstStore.server('info', 'first_start');
        firstStore.close();

        secondStore = new LogStore({ rootDir });
        secondStore.server('info', 'second_start');
        const contents = secondStore.read();
        assert.match(contents, /second_start/u);
        assert.doesNotMatch(contents, /previous-start|first_start/u);
    } finally {
        firstStore?.close();
        secondStore?.close();
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('client log validation accepts only bounded structured metadata', () => {
    assert.deepEqual(validateClientLogEvent({
        level: 'error',
        event: 'prepare_failed',
        context: {
            clientVersion: '0.3.0',
            protocolVersion: 1,
            phase: 'failed',
            statusCode: 503,
            errorCode: 'UNAVAILABLE',
            model: 'gemini-2.5-pro',
            tier: 'flex',
            region: 'global',
            stream: true,
            paygoOnly: false,
            durationMs: 1200,
            clientSessionId: 'session-123',
        },
    }), {
        level: 'error',
        event: 'prepare_failed',
        context: {
            clientVersion: '0.3.0',
            protocolVersion: 1,
            phase: 'failed',
            statusCode: 503,
            errorCode: 'UNAVAILABLE',
            model: 'gemini-2.5-pro',
            tier: 'flex',
            region: 'global',
            stream: true,
            paygoOnly: false,
            durationMs: 1200,
            clientSessionId: 'session-123',
        },
    });

    assert.throws(() => validateClientLogEvent({
        level: 'error',
        event: 'prepare_failed',
        message: 'Bearer private-token',
    }), { code: 'INVALID_CLIENT_LOG_EVENT' });
    assert.throws(() => validateClientLogEvent({
        level: 'info',
        event: 'client_ready',
        context: { apiKey: 'private' },
    }), { code: 'INVALID_CLIENT_LOG_EVENT' });
    assert.throws(() => validateClientLogEvent({
        level: 'info',
        event: 'client_ready',
        context: { model: 'invalid model with spaces' },
    }), { code: 'INVALID_CLIENT_LOG_EVENT' });
    assert.throws(() => validateClientLogEvent({
        level: 'info',
        event: 'client_ready',
        context: { phase: `ready-${'x'.repeat(4096)}` },
    }), { code: 'INVALID_CLIENT_LOG_EVENT' });
});

test('error descriptions omit messages, stacks, and causes', () => {
    const cause = new Error('private key contents');
    const error = new Error('Bearer private-token', { cause });
    error.code = 'VERTEX_UPSTREAM_FAILED';
    error.status = 502;
    assert.deepEqual(describeError(error), {
        errorName: 'Error',
        errorCode: 'VERTEX_UPSTREAM_FAILED',
        statusCode: 502,
    });
    assert.doesNotMatch(JSON.stringify(describeError(error)), /private/u);
});

test('log store stops cleanly at its hard file size limit', () => {
    const rootDir = makeTemporaryRoot();
    const maxFileBytes = 1024;
    const store = new LogStore({ rootDir, maxFileBytes });
    try {
        let rejected = false;
        for (let index = 0; index < 100; index += 1) {
            if (!store.server('info', 'bounded_event', {
                durationMs: index,
                model: 'gemini-2.5-pro',
            })) {
                rejected = true;
                break;
            }
        }
        assert.equal(rejected, true);
        const sizeAtCapacity = fs.statSync(store.filePath).size;
        assert.ok(sizeAtCapacity <= maxFileBytes);
        assert.equal(store.server('error', 'must_not_grow'), false);
        assert.equal(fs.statSync(store.filePath).size, sizeAtCapacity);
    } finally {
        store.close();
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('client log quota leaves capacity available for later server diagnostics', () => {
    const rootDir = makeTemporaryRoot();
    const store = new LogStore({ rootDir, maxFileBytes: 2048, maxClientBytes: 512 });
    try {
        let clientRejected = false;
        for (let index = 0; index < 100; index += 1) {
            if (!store.client('info', 'client_event', {
                requestId: `request-${index}`,
                model: 'gemini-2.5-pro',
            })) {
                clientRejected = true;
                break;
            }
        }
        assert.equal(clientRejected, true);
        assert.equal(store.client('error', 'client_must_not_grow'), false);
        assert.equal(store.server('error', 'server_diagnostic_retained', {
            errorCode: 'VERTEX_UPSTREAM_FAILED',
        }), true);

        const contents = store.read();
        assert.match(contents, /client_log_capacity_reached/u);
        assert.equal(contents.match(/client_log_capacity_reached/gu)?.length, 1);
        assert.match(contents, /server_diagnostic_retained/u);
        assert.ok(fs.statSync(store.filePath).size <= 2048);
    } finally {
        store.close();
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('low-priority prepare noise has its own bounded budget', () => {
    const rootDir = makeTemporaryRoot();
    const store = new LogStore({ rootDir, maxFileBytes: 2048, maxClientBytes: 512, maxLowPriorityBytes: 512 });
    try {
        let lowRejected = false;
        for (let index = 0; index < 100; index += 1) {
            if (!store.server('info', 'prepare_started', undefined, { priority: 'low' })) {
                lowRejected = true;
                break;
            }
            store.server('error', 'prepare_failed', { errorCode: 'INVALID_PREPARE_REQUEST' }, { priority: 'low' });
        }
        assert.equal(lowRejected, true);
        assert.equal(store.server('error', 'proxy_failed', { errorCode: 'VERTEX_UPSTREAM_FAILED' }), true);
        assert.equal(store.lowPriorityAtCapacity, true);
        assert.ok(fs.statSync(store.filePath).size <= 2048);
        assert.match(store.read(), /proxy_failed/u);
    } finally {
        store.close();
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});
