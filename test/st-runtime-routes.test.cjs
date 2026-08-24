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
const { loadStRuntime } = require('../src/st-runtime.cjs');
const { registerRoutes } = require('../src/routes.cjs');

test('ST runtime loader accepts SillyTavern 1.16+ and compatible Luker hosts', async () => {
    const helper = async () => ({});
    const supportedHosts = [
        { name: 'sillytavern', version: '1.16.0' },
        { name: 'sillytavern', version: '1.18.0' },
        { name: 'sillytavern', version: '2.0.0-beta.1' },
        { name: 'luker', version: '2.7.0' },
    ];

    for (const host of supportedHosts) {
        const runtime = await loadStRuntime({
            rootDir: 'C:\\fake-host',
            readFile: async () => JSON.stringify(host),
            importModule: async () => ({ getGoogleApiConfig: helper }),
        });
        assert.equal(runtime.hostName, host.name);
        assert.equal(runtime.stVersion, host.version);
        assert.equal(runtime.getGoogleApiConfig, helper);
    }
});

test('ST runtime loader rejects old, unknown, malformed, or incomplete hosts', async () => {
    const helper = async () => ({});
    const unsupportedHosts = [
        { name: 'sillytavern', version: '1.15.9' },
        { name: 'sillytavern', version: 'not-a-version' },
        { name: 'luker', version: 'not-a-version' },
        { name: 'another-host', version: '2.7.0' },
    ];

    for (const host of unsupportedHosts) {
        await assert.rejects(loadStRuntime({
            readFile: async () => JSON.stringify(host),
            importModule: async () => ({ getGoogleApiConfig: helper }),
        }), { code: 'INCOMPATIBLE_SILLYTAVERN' });
    }

    await assert.rejects(loadStRuntime({
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async () => ({}),
    }), { code: 'INCOMPATIBLE_SILLYTAVERN' });
});

test('route registration exposes handshake, prepare, and fail-closed sink', () => {
    const routes = { get: [], post: [], use: [] };
    const router = {
        get(path, handler) { routes.get.push({ path, handler }); },
        post(path, handler) { routes.post.push({ path, handler }); },
        use(path, handler) { routes.use.push({ path, handler }); },
    };
    registerRoutes(router, {
        stRuntime: { stVersion: '1.18.0' },
        ticketStore: {},
        loopbackTransport: {},
    });
    assert.deepEqual(routes.get.map(route => route.path), ['/health']);
    assert.deepEqual(routes.post.map(route => route.path), ['/prepare']);
    assert.deepEqual(routes.use.map(route => route.path), ['/rejected']);

    const response = {
        body: undefined,
        set() { return this; },
        json(value) { this.body = value; return this; },
    };
    routes.get[0].handler({}, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.protocolVersion, 1);
    assert.equal(response.body.transport, 'loopback-http');
    assert.equal(response.body.pluginVersion, '0.2.0');
    assert.equal(response.body.sillyTavern.compatibleRange, '>=1.16.0');
    assert.equal(Object.hasOwn(response.body, 'port'), false);
});
