'use strict';

const {
    COMPATIBLE_ST_RANGE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
} = require('./protocol.cjs');
const { createPrepareHandler } = require('./prepare-route.cjs');

function registerRoutes(router, dependencies) {
    router.get('/health', (_request, response) => {
        response.set?.('Cache-Control', 'no-store');
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
        });
    });
    router.post('/prepare', createPrepareHandler(dependencies));
    router.use('/rejected', (_request, response) => response.status(503).json({
        error: true,
        code: 'PAYGO_REQUEST_BLOCKED',
        message: 'The Vertex PayGo request was blocked before proxy preparation completed.',
    }));
}

module.exports = { registerRoutes };
