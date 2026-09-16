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
            importModule: async specifier => specifier.endsWith('/secrets.js')
                ? { SECRET_KEYS: { MAKERSUITE: 'makersuite' }, readSecret: () => '' }
                : { getGoogleApiConfig: helper },
        });
        assert.equal(runtime.hostName, host.name);
        assert.equal(runtime.stVersion, host.version);
        assert.notEqual(runtime.getGoogleApiConfig, helper);
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
            importModule: async specifier => specifier.endsWith('/secrets.js')
                ? { SECRET_KEYS: { MAKERSUITE: 'makersuite' }, readSecret: () => '' }
                : { getGoogleApiConfig: helper },
        }), { code: 'INCOMPATIBLE_SILLYTAVERN' });
    }

    await assert.rejects(loadStRuntime({
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async () => ({}),
    }), { code: 'INCOMPATIBLE_SILLYTAVERN' });
});

test('honors explicit AI Studio secrets for both supported host names', async () => {
    const calls = [];
    const helper = async request => {
        calls.push(request);
        return { url: 'https://generativelanguage.googleapis.com/v1beta/models/generateContent', headers: { 'x-goog-api-key': 'default' } };
    };
    for (const name of ['sillytavern', 'luker']) {
        const runtime = await loadStRuntime({
            rootDir: 'C:\\fake-host',
            readFile: async () => JSON.stringify({ name, version: name === 'luker' ? '2.7.0' : '1.18.0' }),
            importModule: async specifier => specifier.endsWith('/secrets.js')
                ? {
                    SECRET_KEYS: { MAKERSUITE: 'makersuite' },
                    readSecret: (_directories, key, id) => key === 'makersuite' && id === 'selected' ? 'selected-key' : '',
                }
                : { getGoogleApiConfig: helper },
        });
        const config = await runtime.getGoogleApiConfig({ body: { api: 'makersuite', secret_id: 'selected' }, user: { directories: {} } }, 'gemini', 'generateContent');
        assert.equal(config.headers['x-goog-api-key'], 'selected-key');
    }
    assert.equal(calls.length, 2);
});

test('fails closed for missing explicit secrets and unsupported Vertex authentication', async () => {
    let helperCalls = 0;
    const runtime = await loadStRuntime({
        rootDir: 'C:\\fake-host',
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async specifier => specifier.endsWith('/secrets.js')
            ? { SECRET_KEYS: { MAKERSUITE: 'makersuite' }, readSecret: () => '' }
            : { getGoogleApiConfig: async () => { helperCalls++; return { headers: {} }; } },
    });
    await assert.rejects(runtime.getGoogleApiConfig({ body: { api: 'makersuite', secret_id: 'missing' }, user: { directories: {} } }), { code: 'EXPLICIT_SECRET_NOT_FOUND' });
    await assert.rejects(runtime.getGoogleApiConfig({ body: { api: 'vertexai', secret_id: 'selected', vertexai_auth_mode: 'full' }, user: { directories: {} } }), { code: 'EXPLICIT_SECRET_UNSUPPORTED' });
    assert.equal(helperCalls, 0);
});

test('route registration exposes handshake, prepare, and fail-closed sink', () => {
    const routes = { get: [], post: [], use: [] };
    const logEvents = [];
    const router = {
        get(path, handler) { routes.get.push({ path, handler }); },
        post(path, handler) { routes.post.push({ path, handler }); },
        use(path, handler) { routes.use.push({ path, handler }); },
    };
    registerRoutes(router, {
        stRuntime: { hostName: 'sillytavern', stVersion: '1.18.0' },
        ticketStore: {},
        loopbackTransport: {},
        logStore: {
            server(level, event, context) { logEvents.push({ level, event, context }); },
        },
    });
    assert.deepEqual(routes.get.map(route => route.path), ['/health', '/logs']);
    assert.deepEqual(routes.post.map(route => route.path), ['/logs/client', '/prepare']);
    assert.deepEqual(routes.use.map(route => route.path), ['/rejected']);

    const response = {
        body: undefined,
        set() { return this; },
        json(value) { this.body = value; return this; },
    };
    routes.get[0].handler({ user: { profile: { admin: true } } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.protocolVersion, 1);
    assert.equal(response.body.transport, 'loopback-http');
    assert.equal(response.body.pluginVersion, '0.3.0');
    assert.equal(response.body.sillyTavern.compatibleRange, '>=1.16.0');
    assert.deepEqual(response.body.capabilities, { logs: true, clientLogging: true });
    assert.equal(Object.hasOwn(response.body, 'port'), false);
    assert.deepEqual(logEvents, []);

    const nonAdminResponse = {
        body: undefined,
        set() { return this; },
        json(value) { this.body = value; return this; },
    };
    routes.get[0].handler({ user: { profile: { admin: false } } }, nonAdminResponse);
    assert.equal(nonAdminResponse.body.capabilities.logs, false);
    assert.equal(nonAdminResponse.body.capabilities.clientLogging, false);
    assert.deepEqual(logEvents, []);
});
