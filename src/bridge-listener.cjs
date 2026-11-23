/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PluginError } = require('./errors.cjs');

const DEFAULT_BRIDGE_PORT = 18443;
const CONFIG_FILE = 'st-vertex-paygo-bridge.json';
const READ_ONLY_CODES = new Set(['EROFS', 'EACCES', 'EPERM', 'ENOENT']);

function validPort(port) { return Number.isInteger(port) && port >= 1024 && port <= 65535; }

async function readExistingBridgePort(filename, fsModule) {
    let stat;
    try {
        stat = await fsModule.stat(filename);
    } catch (cause) {
        if (cause?.code === 'ENOENT') return null;
        throw new PluginError(503, 'BRIDGE_CONFIG_INVALID', `${CONFIG_FILE} must contain a port integer from 1024 to 65535.`, { cause });
    }
    try {
        if (stat.size > 4096) throw new Error('Oversized configuration');
        const config = JSON.parse(await fsModule.readFile(filename, 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => key !== 'port') || !validPort(config.port)) {
            throw new Error('Invalid port');
        }
        return config.port;
    } catch (cause) {
        if (cause?.code === 'ENOENT') return null;
        throw new PluginError(503, 'BRIDGE_CONFIG_INVALID', `${CONFIG_FILE} must contain a port integer from 1024 to 65535.`, { cause });
    }
}

async function migrateLegacyBridgeConfig(resolvedRoot, filename, port, fsModule) {
    const payload = `${JSON.stringify({ port }, null, 2)}\n`;
    let tempFile;
    try {
        await fsModule.mkdir?.(resolvedRoot, { recursive: true, mode: 0o700 });
        if (typeof fsModule.rename === 'function') {
            const candidate = path.join(resolvedRoot, `.${CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`);
            await fsModule.writeFile(candidate, payload, { flag: 'wx', mode: 0o600 });
            tempFile = candidate;
            await fsModule.rename(candidate, filename);
            tempFile = undefined;
        } else {
            await fsModule.writeFile(filename, payload, { flag: 'wx', mode: 0o600 });
        }
    } catch (cause) {
        if (tempFile) {
            try { await fsModule.unlink?.(tempFile); } catch { /* ignore cleanup failure */ }
        }
        if (cause?.code === 'EEXIST' || READ_ONLY_CODES.has(cause?.code)) {
            return;
        }
        throw new PluginError(503, 'BRIDGE_CONFIG_FAILED', `Cannot create ${CONFIG_FILE}.`, { cause });
    }
}

async function readBridgePort(rootDir = process.cwd(), { legacyRootDir, fsModule = fs } = {}) {
    const resolvedRoot = path.resolve(rootDir);
    const filename = path.join(resolvedRoot, CONFIG_FILE);

    const primaryPort = await readExistingBridgePort(filename, fsModule);
    if (primaryPort !== null) return primaryPort;

    const resolvedLegacy = typeof legacyRootDir === 'string' && legacyRootDir.trim().length > 0
        ? path.resolve(legacyRootDir)
        : null;
    if (resolvedLegacy && path.relative(resolvedRoot, resolvedLegacy) !== '') {
        const legacyPort = await readExistingBridgePort(path.join(resolvedLegacy, CONFIG_FILE), fsModule);
        if (legacyPort !== null) {
            await migrateLegacyBridgeConfig(resolvedRoot, filename, legacyPort, fsModule);
            return legacyPort;
        }
    }

    const payload = `${JSON.stringify({ port: DEFAULT_BRIDGE_PORT }, null, 2)}\n`;
    try {
        await fsModule.mkdir?.(resolvedRoot, { recursive: true, mode: 0o700 });
        await fsModule.writeFile(filename, payload, { flag: 'wx', mode: 0o600 });
        return DEFAULT_BRIDGE_PORT;
    } catch (cause) {
        if (cause?.code === 'EEXIST') {
            const racedPort = await readExistingBridgePort(filename, fsModule);
            if (racedPort !== null) return racedPort;
        }
        if (READ_ONLY_CODES.has(cause?.code)) {
            return DEFAULT_BRIDGE_PORT;
        }
        throw new PluginError(503, 'BRIDGE_CONFIG_FAILED', `Cannot create ${CONFIG_FILE}.`, { cause });
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
