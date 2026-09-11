/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const http = require('node:http');
const { PluginError } = require('./errors.cjs');
const { describeError } = require('./log-store.cjs');
const { createProxyHandler } = require('./proxy-handler.cjs');

function createLoopbackTransport({ ticketStore, logStore, upstreamRequest, maxBodyBytes, upstreamTimeoutMs } = {}) {
    const proxyHandler = createProxyHandler({ ticketStore, logStore, upstreamRequest, maxBodyBytes, upstreamTimeoutMs });
    let server;
    let baseUrl;

    return {
        async start() {
            if (server) throw new Error('Loopback transport is already running.');
            logStore?.server('info', 'loopback_starting');
            try {
                server = http.createServer((request, response) => {
                    response.setHeader('Cache-Control', 'no-store');
                    proxyHandler(request, response);
                });
                server.requestTimeout = 0;
                server.headersTimeout = 60_000;
                server.keepAliveTimeout = 5_000;

                await new Promise((resolve, reject) => {
                    const onError = error => {
                        server?.removeListener('listening', onListening);
                        reject(error);
                    };
                    const onListening = () => {
                        server?.removeListener('error', onError);
                        resolve();
                    };
                    server.once('error', onError);
                    server.once('listening', onListening);
                    server.listen(0, '127.0.0.1');
                });
                const address = server.address();
                if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
                    await this.close();
                    throw new PluginError(500, 'LOOPBACK_BIND_FAILED', 'The private loopback proxy could not be started.');
                }
                baseUrl = `http://127.0.0.1:${address.port}`;
                logStore?.server('info', 'loopback_started');
            } catch (error) {
                logStore?.server('error', 'loopback_start_failed', describeError(error));
                throw error;
            }
        },

        get baseUrl() {
            if (!baseUrl) throw new PluginError(503, 'LOOPBACK_NOT_READY', 'The private loopback proxy is not ready.');
            return baseUrl;
        },

        async close() {
            const activeServer = server;
            server = undefined;
            baseUrl = undefined;
            if (!activeServer) return;
            const closed = new Promise(resolve => activeServer.close(() => resolve()));
            activeServer.closeAllConnections?.();
            await closed;
            logStore?.server('info', 'loopback_stopped');
        },
    };
}

module.exports = { createLoopbackTransport };
