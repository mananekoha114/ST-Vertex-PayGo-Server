'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBridgeListener, readBridgePort, DEFAULT_BRIDGE_PORT, CONFIG_FILE } = require('../src/bridge-listener.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');

async function reservePort() {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }

test('bridge port configuration is saved and reused; malformed and dynamic ports are rejected', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-port-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    assert.equal(await readBridgePort(root), DEFAULT_BRIDGE_PORT);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, CONFIG_FILE))), { port: DEFAULT_BRIDGE_PORT });
    await fs.writeFile(path.join(root, CONFIG_FILE), '{"port":23456}');
    assert.equal(await readBridgePort(root), 23456);
    for (const config of ['{', '{"port":0}', '{"port":65536}', '{"port":"18443"}', '{"port":18443,"host":"0.0.0.0"}']) {
        await fs.writeFile(path.join(root, CONFIG_FILE), config);
        await assert.rejects(readBridgePort(root), { code: 'BRIDGE_CONFIG_INVALID' });
        assert.equal(await fs.readFile(path.join(root, CONFIG_FILE), 'utf8'), config);
    }
});

test('bridge keeps the same loopback port across restarts and does not expose PayGo routes', async () => {
    const reservation = await reservePort();
    const port = reservation.address().port;
    await close(reservation);
    let baseUrl;
    const bridge = { setBaseUrl(value) { baseUrl = value; }, route(req, res) {
        if (req.url !== '/openai/v1/models') return false;
        res.setHeader('Connection', 'close'); res.end('{"data":[]}'); return true;
    } };
    for (let i = 0; i < 2; i++) {
        const listener = createBridgeListener({ openaiBridge: bridge, port });
        try {
            await listener.start();
            assert.equal(baseUrl, `http://127.0.0.1:${port}`);
            assert.deepEqual(await (await fetch(`${baseUrl}/openai/v1/models`)).json(), { data: [] });
            assert.equal((await fetch(`${baseUrl}/proxy/anything`)).status, 404);
        } finally { await listener.close(); }
        assert.equal(baseUrl, null);
    }
});

test('occupied fixed port fails without random fallback; separate main transport remains usable', async t => {
    const occupied = await reservePort();
    t.after(() => close(occupied));
    const transport = createLoopbackTransport({ ticketStore: {} });
    t.after(() => transport.close());
    await transport.start();
    let assigned = false;
    const listener = createBridgeListener({ port: occupied.address().port, openaiBridge: { setBaseUrl() { assigned = true; } } });
    await assert.rejects(listener.start(), { code: 'BRIDGE_PORT_IN_USE' });
    assert.equal(assigned, false);
    assert.equal((await fetch(`${transport.baseUrl}/openai/v1/models`)).status, 405);
    await listener.close();
});
