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
const { PassThrough, Readable } = require('node:stream');
const {
    createClientLogHandler,
    createReadLogsHandler,
    readClientLogEvent,
} = require('../src/log-routes.cjs');
const { CLIENT_LOG_MEDIA_TYPE, MAX_CLIENT_EVENT_BYTES } = require('../src/log-store.cjs');

function makeResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        send(value) { this.body = value; return this; },
        sendStatus(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
    };
}

function authenticatedUser(admin = false) {
    return {
        user: {
            directories: {},
            profile: { admin },
        },
    };
}

function makeClientLogRequest(body, {
    admin = true,
    authenticated = true,
    contentType = CLIENT_LOG_MEDIA_TYPE,
    includeLength = true,
} = {}) {
    const encoded = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = Readable.from([encoded]);
    request.headers = { 'content-type': contentType };
    if (includeLength) request.headers['content-length'] = String(encoded.byteLength);
    if (authenticated) Object.assign(request, authenticatedUser(admin));
    return request;
}

test('log read route returns the current text log only to administrators', () => {
    const serverEvents = [];
    let reads = 0;
    const logStore = {
        read() { reads += 1; return '{"source":"server"}\n'; },
        server(level, event, context) { serverEvents.push({ level, event, context }); },
    };
    const handler = createReadLogsHandler({ logStore });

    const response = makeResponse();
    handler(authenticatedUser(true), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"source":"server"}\n');
    assert.equal(response.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(reads, 1);

    const forbidden = makeResponse();
    handler(authenticatedUser(false), forbidden);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.body.code, 'LOG_ACCESS_FORBIDDEN');
    assert.equal(reads, 1);
    assert.deepEqual(serverEvents, []);
});

test('client log route accepts bounded vendor JSON from administrators only', async () => {
    const clientEvents = [];
    const serverEvents = [];
    const logStore = {
        client(level, event, context) { clientEvents.push({ level, event, context }); },
        server(level, event, context) { serverEvents.push({ level, event, context }); },
    };
    const handler = createClientLogHandler({ logStore });

    const response = makeResponse();
    await handler(makeClientLogRequest({
        level: 'warn',
        event: 'model_blocked',
        context: {
            model: 'claude-sonnet-4',
            phase: 'failed',
            errorCode: 'MODEL_UNSUPPORTED',
        },
    }, { contentType: `${CLIENT_LOG_MEDIA_TYPE}; charset=utf-8` }), response);
    assert.equal(response.statusCode, 204);
    assert.deepEqual(clientEvents, [{
        level: 'warn',
        event: 'model_blocked',
        context: {
            model: 'claude-sonnet-4',
            phase: 'failed',
            errorCode: 'MODEL_UNSUPPORTED',
        },
    }]);

    const forbidden = makeResponse();
    await handler(makeClientLogRequest({ level: 'info', event: 'client_ready' }, { admin: false }), forbidden);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.body.code, 'CLIENT_LOG_ACCESS_FORBIDDEN');

    const rejected = makeResponse();
    await handler(makeClientLogRequest({
        level: 'error',
        event: 'unsafe_event',
        message: 'Bearer private-token',
    }), rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.code, 'INVALID_CLIENT_LOG_EVENT');
    assert.equal(JSON.stringify(serverEvents).includes('private-token'), false);

    const unauthenticated = makeResponse();
    await handler(makeClientLogRequest({ level: 'info', event: 'client_ready' }, { authenticated: false }), unauthenticated);
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.body.code, 'AUTHENTICATED_USER_REQUIRED');
    assert.deepEqual(serverEvents, []);
});

test('client log route rejects globally parsed JSON and enforces 4 KiB while streaming', async () => {
    const clientEvents = [];
    const handler = createClientLogHandler({
        logStore: { client(...args) { clientEvents.push(args); } },
    });

    const wrongMediaType = makeResponse();
    await handler(makeClientLogRequest(
        { level: 'info', event: 'client_ready' },
        { contentType: 'application/json' },
    ), wrongMediaType);
    assert.equal(wrongMediaType.statusCode, 415);
    assert.equal(wrongMediaType.body.code, 'CLIENT_LOG_MEDIA_TYPE_REQUIRED');

    const declaredOversizedRequest = makeClientLogRequest({ level: 'info', event: 'client_ready' });
    declaredOversizedRequest.headers['content-length'] = String(MAX_CLIENT_EVENT_BYTES + 1);
    const declaredOversized = makeResponse();
    await handler(declaredOversizedRequest, declaredOversized);
    assert.equal(declaredOversized.statusCode, 413);
    assert.equal(declaredOversized.body.code, 'CLIENT_LOG_EVENT_TOO_LARGE');

    const oversized = makeResponse();
    await handler(makeClientLogRequest('x'.repeat(MAX_CLIENT_EVENT_BYTES + 1), {
        includeLength: false,
    }), oversized);
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.body.code, 'CLIENT_LOG_EVENT_TOO_LARGE');
    assert.deepEqual(clientEvents, []);
});

test('client log stream rejects pre-destroyed and mid-read interrupted requests without hanging', async () => {
    const makeStream = () => {
        const request = new PassThrough();
        request.headers = { 'content-type': CLIENT_LOG_MEDIA_TYPE };
        return request;
    };

    const preDestroyed = makeStream();
    preDestroyed.destroy();
    await assert.rejects(readClientLogEvent(preDestroyed), { code: 'INVALID_CLIENT_LOG_EVENT' });

    const interrupted = makeStream();
    const result = readClientLogEvent(interrupted);
    interrupted.destroy();
    await assert.rejects(result, { code: 'INVALID_CLIENT_LOG_EVENT' });
    for (const event of ['data', 'end', 'error', 'aborted', 'close']) {
        assert.equal(interrupted.listenerCount(event), 0, event);
    }
});
