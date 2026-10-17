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

const {
    createCheckUpdateHandler,
    createStartUpdateHandler,
    createUpdateStatusHandler,
} = require('../src/updater/routes.cjs');
const { PluginError } = require('../src/errors.cjs');

function makeResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        set(name, value) { this.headers[name] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = value; return this; },
        send(value) { this.body = value; return this; },
    };
}

function user(admin = false, authenticated = true) {
    return authenticated ? { user: { directories: {}, profile: { admin } } } : {};
}

test('a check answers administrators and refuses everyone else', async () => {
    const calls = [];
    const updater = { check: async () => { calls.push('check'); return { status: 'update-available', components: [{ name: 'frontend', status: 'update' }] }; } };
    const handler = createCheckUpdateHandler({ updater });

    const response = makeResponse();
    await handler(user(true), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.status, 'update-available');
    assert.equal(response.headers['Cache-Control'], 'no-store');

    const denied = makeResponse();
    await handler(user(false), denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.code, 'UPDATER_ACCESS_FORBIDDEN');

    const anonymous = makeResponse();
    await handler(user(false, false), anonymous);
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.body.code, 'AUTHENTICATED_USER_REQUIRED');
    assert.deepEqual(calls, ['check']);
});

test('a failing check reports its own code instead of a generic failure', async () => {
    const updater = {
        check: async () => { throw new PluginError(409, 'UPDATER_COMPONENT_AMBIGUOUS', 'Several copies exist.'); },
    };
    const response = makeResponse();
    await createCheckUpdateHandler({ updater })(user(true), response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'UPDATER_COMPONENT_AMBIGUOUS');
    assert.equal(response.body.message, 'Several copies exist.');
});

test('starting an update answers immediately and names a conflict when one runs', () => {
    let started = 0;
    const updater = { start: () => { started += 1; } };
    const response = makeResponse();
    createStartUpdateHandler({ updater })(user(true), response);
    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.body, { ok: true, started: true });
    assert.equal(started, 1);

    const busy = {
        start: () => { throw new PluginError(409, 'UPDATER_IN_PROGRESS', 'An update is already running.'); },
    };
    const conflict = makeResponse();
    createStartUpdateHandler({ updater: busy })(user(true), conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.code, 'UPDATER_IN_PROGRESS');

    const denied = makeResponse();
    createStartUpdateHandler({ updater })(user(false), denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(started, 1);
});

test('status reports the running job and the last outcome to administrators only', () => {
    const updater = {
        status: () => ({
            running: true,
            job: { phase: 'activating', startedAt: '2026-10-15T00:00:00.000Z' },
            lastResult: null,
        }),
    };
    const response = makeResponse();
    createUpdateStatusHandler({ updater })(user(true), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.running, true);
    assert.equal(response.body.job.phase, 'activating');

    const denied = makeResponse();
    createUpdateStatusHandler({ updater })(user(false), denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.code, 'UPDATER_ACCESS_FORBIDDEN');
});
