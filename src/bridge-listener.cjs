/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PluginError } = require('./errors.cjs');

const DEFAULT_BRIDGE_PORT = 18443;
const CONFIG_FILE = 'st-vertex-paygo-bridge.json';

function validPort(port) { return Number.isInteger(port) && port >= 1024 && port <= 65535; }

async function readBridgePort(rootDir = process.cwd()) {
    const filename = path.join(rootDir, CONFIG_FILE);
    try {
        await fs.writeFile(filename, `${JSON.stringify({ port: DEFAULT_BRIDGE_PORT }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (cause) {
        if (cause.code !== 'EEXIST') throw new PluginError(503, 'BRIDGE_CONFIG_FAILED', `Cannot create ${CONFIG_FILE}.`);
    }
    try {
        if ((await fs.stat(filename)).size > 4096) throw new Error('Oversized configuration');
        const config = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => key !== 'port') || !validPort(config.port)) throw new Error('Invalid port');
        return config.port;
    } catch {
        throw new PluginError(503, 'BRIDGE_CONFIG_INVALID', `${CONFIG_FILE} must contain a port integer from 1024 to 65535.`);
    }
}

function createBridgeListener({ openaiBridge, port = DEFAULT_BRIDGE_PORT } = {}) {
    if (!validPort(port)) throw new PluginError(503, 'BRIDGE_PORT_INVALID', 'The bridge port must be an integer from 1024 to 65535.');
    let server;
    return {
        async start() {
            if (server) throw new Error('Bridge listener is already running.');
            const candidate = http.createServer((request, response) => {
                response.setHeader('Cache-Control', 'no-store');
                if (!openaiBridge.route(request, response)) {
                    response.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' });
                    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'The endpoint was not found.' } }));
                    request.resume();
                }
            });
            candidate.requestTimeout = 0;
            candidate.headersTimeout = 60_000;
            candidate.keepAliveTimeout = 5_000;
            try {
                await new Promise((resolve, reject) => {
                    candidate.once('error', reject);
                    candidate.listen(port, '127.0.0.1', () => { candidate.removeListener('error', reject); resolve(); });
                });
                server = candidate;
                openaiBridge.setBaseUrl(`http://127.0.0.1:${port}`);
            } catch (cause) {
                candidate.close();
                throw new PluginError(503, cause.code === 'EADDRINUSE' ? 'BRIDGE_PORT_IN_USE' : 'BRIDGE_BIND_FAILED', `Cannot listen on bridge port ${port}. Check ${CONFIG_FILE} and restart the host.`, { cause });
            }
        },
        async close() {
            const previous = server;
            server = undefined;
            openaiBridge.setBaseUrl(null);
            if (!previous) return;
            const closed = new Promise(resolve => previous.close(resolve));
            previous.closeAllConnections?.();
            await closed;
        },
    };
}

module.exports = { createBridgeListener, readBridgePort, DEFAULT_BRIDGE_PORT, CONFIG_FILE };
