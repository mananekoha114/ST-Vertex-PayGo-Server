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

test('fails closed when explicit secrets are missing or host Vertex helpers are unavailable', async () => {
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

test('explicit Vertex Express and Full secrets use the selected host secret only', async () => {
    const selectedServiceAccount = { project_id: 'selected-project', client_email: 'selected@example.test', private_key: 'selected-private' };
    const reads = [];
    const runtime = await loadStRuntime({
        rootDir: 'C:\\fake-host',
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async specifier => specifier.endsWith('/secrets.js') ? {
            SECRET_KEYS: { MAKERSUITE: 'makersuite', VERTEXAI: 'vertex-key', VERTEXAI_SERVICE_ACCOUNT: 'vertex-sa' },
            readSecret: (_directories, key, id) => {
                reads.push({ key, id });
                if (key === 'vertex-key' && id === 'express-selected') return 'selected-api-key';
                if (key === 'vertex-sa' && id === 'full-selected') return JSON.stringify(selectedServiceAccount);
                return '';
            },
        } : {
            getGoogleApiConfig: async () => { throw new Error('native helper must not select credentials'); },
            getProjectIdFromServiceAccount: account => account.project_id,
            generateJWTToken: async account => `jwt-for-${account.client_email}`,
            getAccessToken: async jwt => `access-for-${jwt}`,
        },
    });
    const express = await runtime.getGoogleApiConfig({
        body: { api: 'vertexai', secret_id: 'express-selected', vertexai_auth_mode: 'express', vertexai_region: 'us-central1', vertexai_express_project_id: 'express-project' },
        user: { directories: { root: 'user' } },
    }, 'gemini-2.5-flash', 'generateContent');
    assert.equal(express.headers['x-goog-api-key'], 'selected-api-key');
    assert.match(express.url, /projects\/express-project\/locations\/us-central1/u);

    const full = await runtime.getGoogleApiConfig({
        body: { api: 'vertexai', secret_id: 'full-selected', vertexai_auth_mode: 'full', vertexai_region: 'global' },
        user: { directories: { root: 'user' } },
    }, 'gemini-2.5-pro', 'streamGenerateContent');
    assert.equal(full.headers.Authorization, 'Bearer access-for-jwt-for-selected@example.test');
    assert.match(full.url, /projects\/selected-project\/locations\/global/u);
    assert.deepEqual(reads, [
        { key: 'vertex-key', id: 'express-selected' },
        { key: 'vertex-sa', id: 'full-selected' },
    ]);
    const bridgeRequest = { user: { directories: { root: 'user' } } };
    const selected = runtime.resolveOpenAIConnection(bridgeRequest, {
        source: 'vertexai', model: 'gemini-2.5-flash', authMode: 'full', region: 'global', secretId: 'full-selected',
    });
    assert.equal(selected.credentialSnapshot, undefined);
    assert.equal(selected.logCredential, JSON.stringify(selectedServiceAccount));
    for (const authenticate of [false, true]) {
        const config = await runtime.getOpenAIConfig(bridgeRequest, selected.connection, authenticate);
        assert.equal(config.logCredential, JSON.stringify(selectedServiceAccount));
        assert.equal(Boolean(config.headers), authenticate);
    }
});

test('bridge pins active IDs when exposed and snapshots credentials on older hosts', async () => {
    let active = 'first';
    const runtime = await loadStRuntime({
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async specifier => specifier.endsWith('/secrets.js') ? {
            SECRET_KEYS: { MAKERSUITE: 'api_key_makersuite', VERTEXAI_SERVICE_ACCOUNT: 'vertexai_service_account_json' },
            readSecretState: () => ({ api_key_makersuite: [{ id: active, active: true }] }),
            readSecret: (_directories, _key, id) => id ? `credential-${id}` : `credential-${active}`,
        } : { getGoogleApiConfig: async () => { throw new Error('Native API must not be called'); } },
    });
    const request = { user: { directories: { root: 'alice' } } };
    const selected = runtime.resolveOpenAIConnection(request, { source: 'makersuite', model: 'gemini-2.5-flash' });
    assert.equal(selected.connection.secretId, 'first');
    assert.equal(selected.logCredential, 'credential-first');
    active = 'second';
    assert.equal((await runtime.getOpenAIConfig(request, selected.connection)).headers.Authorization, 'Bearer credential-first');
    assert.equal((await runtime.getOpenAIConfig(request, selected.connection)).logCredential, 'credential-first');
    assert.equal(selected.credentialSnapshot, undefined);

    const oldRuntime = await loadStRuntime({
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async specifier => specifier.endsWith('/secrets.js') ? {
            SECRET_KEYS: { MAKERSUITE: 'api_key_makersuite' },
            readSecretState: () => ({ api_key_makersuite: true }),
            readSecret: () => `credential-${active}`,
        } : { getGoogleApiConfig: async () => { throw new Error('Native API must not be called'); } },
    });
    const snapshot = oldRuntime.resolveOpenAIConnection(request, { source: 'makersuite', model: 'gemini-2.5-flash' });
    assert.equal((await oldRuntime.getOpenAIConfig(request, snapshot.connection, true, snapshot.credentialSnapshot)).headers.Authorization, 'Bearer credential-second');
    active = 'third';
    await assert.rejects(oldRuntime.getOpenAIConfig(request, snapshot.connection, true, snapshot.credentialSnapshot), { code: 'GOOGLE_CONNECTION_CHANGED' });
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
    assert.deepEqual(routes.get.map(route => route.path), ['/health', '/logs', '/usage', '/update', '/update/status']);
    assert.deepEqual(routes.post.map(route => route.path), ['/logs/client', '/prepare', '/update']);
    assert.deepEqual(routes.use.map(route => route.path), ['/rejected']);

    const response = {
        body: undefined,
        set() { return this; },
        json(value) { this.body = value; return this; },
    };
    routes.get[0].handler({ user: { profile: { admin: true } } }, response);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.protocolVersion, 2);
    assert.equal(response.body.transport, 'loopback-http');
    assert.equal(response.body.pluginVersion, '0.5.1');
    assert.equal(response.body.sillyTavern.compatibleRange, '>=1.16.0');
    assert.deepEqual(response.body.capabilities, { logs: true, clientLogging: true, usage: true, dataBackups: false, updater: false, openaiBridge: false, openaiBridgeDebug: false, openaiBridgeLogs: false, openaiBridgeGateway: false, openaiBridgePersistence: false });
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
    assert.equal(nonAdminResponse.body.capabilities.usage, true);
    assert.equal(nonAdminResponse.body.capabilities.openaiBridge, false);
    assert.deepEqual(logEvents, []);
});

test('health advertises the bridge only when its management routes are installed', () => {
    const handlers = new Map();
    const router = { get(path, handler) { handlers.set(`GET ${path}`, handler); }, post(path, handler) { handlers.set(`POST ${path}`, handler); }, use() {} };
    const openaiBridge = { get() {}, update() {}, persistenceEnabled: true };
    registerRoutes(router, { stRuntime: { stVersion: '1.18.0' }, openaiBridge });
    assert.equal(typeof handlers.get('GET /openai-bridge'), 'function');
    assert.equal(typeof handlers.get('POST /openai-bridge'), 'function');
    const response = { set() { return this; }, json(value) { this.body = value; return this; } };
    handlers.get('GET /health')({ user: {} }, response);
    assert.equal(response.body.capabilities.openaiBridge, true);
    assert.equal(response.body.capabilities.openaiBridgeDebug, true);
    assert.equal(response.body.capabilities.openaiBridgeLogs, true);
    assert.equal(response.body.capabilities.openaiBridgeGateway, true);
    assert.equal(response.body.capabilities.openaiBridgePersistence, true);
});
test('Luker follows its authoritative settings repository using only the trusted owner handle', async () => {
    for (const method of ['get', 'load']) {
        const owners = []; const saved = { main_api: 'openai' }; let broken = false;
        const runtime = await loadStRuntime({ rootDir: 'C:\\fake-luker', readFile: async () => JSON.stringify({ name: 'luker', version: '2.7.0' }), fileExists: () => true,
            importModule: async specifier => specifier.endsWith('/storage/index.js') ? { getSettingsRepo: () => ({ [method]: async handle => { owners.push(handle); if (broken) throw new Error('Database secret'); return saved; } }) }
                : specifier.endsWith('/secrets.js') ? { SECRET_KEYS: { MAKERSUITE: 'key' }, readSecret: () => '' } : { getGoogleApiConfig: async () => ({}) },
        });
        assert.equal(await runtime.readSavedSettings('alice'), saved); assert.deepEqual(owners, ['alice']);
        await assert.rejects(runtime.readSavedSettings(undefined), { code: 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE' }); assert.deepEqual(owners, ['alice']);
        broken = true;
        await assert.rejects(runtime.readSavedSettings('alice'), cause => cause.code === 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE' && !cause.message.includes('Database secret'));
    }
});
test('only absent Luker storage or SillyTavern uses file follow; existing broken storage stays authoritative', async () => {
    for (const [name, exists, broken] of [['luker', false, false], ['sillytavern', true, false], ['luker', true, true]]) {
        let storageImports = 0;
        const runtime = await loadStRuntime({ readFile: async () => JSON.stringify({ name, version: name === 'luker' ? '2.7.0' : '1.18.0' }), fileExists: () => exists,
            importModule: async specifier => {
                if (specifier.endsWith('/storage/index.js')) { storageImports++; throw new Error('Storage dependency unavailable'); }
                return specifier.endsWith('/secrets.js') ? { SECRET_KEYS: { MAKERSUITE: 'key' }, readSecret: () => '' } : { getGoogleApiConfig: async () => ({}) };
            },
        });
        assert.equal(typeof runtime.readSavedSettings === 'function', broken);
        assert.equal(storageImports, broken ? 1 : 0);
        if (broken) await assert.rejects(runtime.readSavedSettings('alice'), { code: 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE' });
    }
});

test('bridge startup enumerates trusted enabled accounts and supports account-free hosts', async () => {
    for (const name of ['sillytavern', 'luker']) {
        for (const accountsEnabled of [true, false]) {
            const requested = []; let registryReads = 0;
            const runtime = await loadStRuntime({ rootDir: 'C:/fake-host',
                readFile: async () => JSON.stringify({ name, version: '2.7.0' }), fileExists: () => false,
                importModule: async specifier => {
                    if (specifier.endsWith('/users.js')) return {
                        getAllEnabledUsers: async () => { registryReads++; return [{ handle: 'alice', enabled: true }, { handle: 'disabled', enabled: false }]; },
                        getUserDirectories: handle => { requested.push(handle); return { root: require('node:path').resolve('data', handle), secrets: handle + '/secrets.json' }; },
                    };
                    if (specifier.endsWith('/util.js')) return { getConfigValue(key, fallback, type) { assert.equal(key, 'enableUserAccounts'); assert.equal(type, 'boolean'); return accountsEnabled; } };
                    if (specifier.endsWith('/constants.js')) return { DEFAULT_USER: { handle: 'default-user', enabled: true, unrelatedPrivateField: 'not copied' } };
                    if (specifier.endsWith('/secrets.js')) return { SECRET_KEYS: {}, readSecret: () => '' };
                    return { getGoogleApiConfig: async () => ({}) };
                },
            });
            const owners = await runtime.listBridgeUsers();
            const handle = accountsEnabled ? 'alice' : 'default-user';
            assert.deepEqual(requested, [handle]); assert.equal(registryReads, accountsEnabled ? 1 : 0);
            assert.deepEqual(owners, [{ user: { directories: { root: require('node:path').resolve('data', handle), secrets: handle + '/secrets.json' }, profile: { handle } } }]);
        }
    }
});

test('bridge user enumeration never falls back to a different user after host registry errors', async () => {
    for (const failure of ['import', 'registry', 'directory', 'missing-helper']) {
        const runtime = await loadStRuntime({ rootDir: 'C:/fake-host', fileExists: () => false,
            readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.19.0' }),
            importModule: async specifier => {
                if (specifier.endsWith('/users.js')) {
                    if (failure === 'import') throw new Error('private registry diagnostic');
                    if (failure === 'missing-helper') return {};
                    return { getAllEnabledUsers: async () => {
                        if (failure === 'registry') throw new Error('private database diagnostic');
                        return [{ handle: 'alice', enabled: true }];
                    }, getUserDirectories: () => ({ root: 'relative/untrusted' }) };
                }
                if (specifier.endsWith('/util.js')) return { getConfigValue: () => true };
                if (specifier.endsWith('/constants.js')) return { DEFAULT_USER: { handle: 'default-user' } };
                if (specifier.endsWith('/secrets.js')) return { SECRET_KEYS: {}, readSecret: () => '' };
                return { getGoogleApiConfig: async () => ({}) };
            },
        });
        await assert.rejects(runtime.listBridgeUsers(), error => error.code === 'BRIDGE_USERS_UNAVAILABLE' && !error.message.includes('private'));
    }
});

test('data backups use all trusted accounts and the host retention configuration', async () => {
    for (const enabled of [false, true]) {
        const directory = require('node:path');
        const runtime = await loadStRuntime({ rootDir: '/fake-host', fileExists: () => false,
            readFile: async () => JSON.stringify({ name: 'luker', version: '2.8.0' }),
            importModule: async specifier => {
                if (specifier.endsWith('/users.js')) return { getAllUserHandles: async () => ['alice', 'disabled'],
                    getUserDirectories: handle => ({ root: directory.resolve('data', handle), backups: directory.resolve('data', handle, 'backups') }) };
                if (specifier.endsWith('/util.js')) return { getConfigValue: key => key === 'enableUserAccounts' ? enabled : 3 };
                if (specifier.endsWith('/constants.js')) return { DEFAULT_USER: { handle: 'default-user' } };
                if (specifier.endsWith('/secrets.js')) return { SECRET_KEYS: {}, readSecret() {} };
                return { getGoogleApiConfig() {} };
            },
        });
        const context = await runtime.dataBackupContext();
        assert.equal(context.retention, 3);
        assert.deepEqual(context.users.map(user => user.user.profile.handle), enabled ? ['alice', 'disabled'] : ['default-user']);
    }
});

test('data backup routes and capability are installed together', () => {
    const routes = { get: [], post: [] };
    const router = { get(p, h) { routes.get.push([p, h]); }, post(p, h) { routes.post.push([p, h]); }, use() {} };
    registerRoutes(router, { stRuntime: { stVersion: '2.8.0' }, dataBackups: {} });
    assert.deepEqual(routes.get.map(([p]) => p), ['/health', '/logs', '/usage', '/update', '/update/status', '/data-backups']);
    assert.deepEqual(routes.post.map(([p]) => p), ['/logs/client', '/prepare', '/update', '/data-restore', '/data-restore/cancel']);
    const response = { set() {}, json(body) { this.body = body; } };
    routes.get[0][1]({ user: {} }, response);
    assert.equal(response.body.capabilities.dataBackups, true);
});
