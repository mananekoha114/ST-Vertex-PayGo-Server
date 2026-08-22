'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadStRuntime } = require('../src/st-runtime.cjs');
const { registerRoutes } = require('../src/routes.cjs');

test('ST runtime loader validates version and the required export', async () => {
    const helper = async () => ({});
    const runtime = await loadStRuntime({
        rootDir: 'C:\\fake-st',
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.18.0' }),
        importModule: async () => ({ getGoogleApiConfig: helper }),
    });
    assert.equal(runtime.stVersion, '1.18.0');
    assert.equal(runtime.getGoogleApiConfig, helper);

    await assert.rejects(loadStRuntime({
        readFile: async () => JSON.stringify({ name: 'sillytavern', version: '1.19.0' }),
        importModule: async () => ({ getGoogleApiConfig: helper }),
    }), { code: 'INCOMPATIBLE_SILLYTAVERN' });
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
    assert.equal(Object.hasOwn(response.body, 'port'), false);
});
