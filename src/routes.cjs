/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const {
    COMPATIBLE_ST_RANGE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
} = require('./protocol.cjs');
const { createClientLogHandler, createReadLogsHandler } = require('./log-routes.cjs');
const { createPrepareHandler } = require('./prepare-route.cjs');
const { createUsageHandler } = require('./usage-route.cjs');

function registerRoutes(router, dependencies) {
    router.get('/health', (request, response) => {
        response.set?.('Cache-Control', 'no-store');
        const isAdmin = request.user?.profile?.admin === true;
        response.json({
            ok: true,
            status: 'ok',
            pluginId: PLUGIN_ID,
            pluginVersion: PLUGIN_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            transport: 'loopback-http',
            sillyTavern: {
                version: dependencies.stRuntime.stVersion,
                compatibleRange: COMPATIBLE_ST_RANGE,
            },
            capabilities: {
                logs: isAdmin,
                clientLogging: isAdmin,
                usage: true,
            },
        });
    });
    router.get('/logs', createReadLogsHandler(dependencies));
    router.get('/usage', createUsageHandler(dependencies));
    router.post('/logs/client', createClientLogHandler(dependencies));
    router.post('/prepare', createPrepareHandler(dependencies));
    router.use('/rejected', (_request, response) => response.status(503).json({
        error: true,
        code: 'PAYGO_REQUEST_BLOCKED',
        message: 'The Vertex PayGo request was blocked before proxy preparation completed.',
    }));
}

module.exports = { registerRoutes };
