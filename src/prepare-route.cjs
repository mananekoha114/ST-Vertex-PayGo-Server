/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { buildPayGoHeaders } = require('./header-policy.cjs');
const { sendExpressError, PluginError } = require('./errors.cjs');
const { describeError } = require('./log-store.cjs');
const { PLUGIN_ID, PROTOCOL_VERSION, validatePreparePayload } = require('./protocol.cjs');
const { prepareGoogleHeaders, prepareGoogleTarget } = require('./target-policy.cjs');

function prepareLogContext(config, startedAt, additional = undefined) {
    return {
        ...(config ? {
            model: config.model,
            provider: config.source,
            tier: config.tier,
            region: config.region,
            stream: config.stream,
            paygoOnly: config.paygoOnly,
        } : {}),
        durationMs: Date.now() - startedAt,
        ...additional,
    };
}

function createPrepareHandler({ stRuntime, ticketStore, loopbackTransport, logStore }) {
    return async function prepareHandler(request, response) {
        const startedAt = Date.now();
        let config;
        logStore?.server('info', 'prepare_started');
        try {
            config = validatePreparePayload(request.body);
            if (!request.user || !request.user.directories) {
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
            }

            const syntheticBody = {
                api: config.source,
                ...(config.source === 'vertexai' ? {
                    vertexai_auth_mode: config.authMode,
                    vertexai_region: config.region,
                } : {}),
            };
            if (config.expressProjectId) syntheticBody.vertexai_express_project_id = config.expressProjectId;
            if (config.secretId) syntheticBody.secret_id = config.secretId;

            // Deliberately synthesize a new object and never copy reverse_proxy or
            // proxy_password from the browser-controlled prepare payload.
            const syntheticRequest = {
                body: syntheticBody,
                user: { directories: request.user.directories },
            };
            const endpoint = config.stream ? 'streamGenerateContent' : 'generateContent';

            let googleConfig;
            try {
                googleConfig = await stRuntime.getGoogleApiConfig(syntheticRequest, config.model, endpoint);
            } catch (error) {
                throw new PluginError(
                    400,
                    config.source === 'vertexai' ? 'VERTEX_AUTH_CONFIGURATION_FAILED' : 'GOOGLE_AUTH_CONFIGURATION_FAILED',
                    'Google authentication is unavailable for this configuration.',
                    { cause: error },
                );
            }

            const targetUrl = prepareGoogleTarget(googleConfig.url, config);
            const headers = prepareGoogleHeaders(googleConfig.headers, buildPayGoHeaders(config));
            if (request.aborted || response.destroyed) {
                logStore?.server('warn', 'prepare_client_disconnected', prepareLogContext(config, startedAt));
                return undefined;
            }
            const issued = ticketStore.create({
                targetUrl,
                headers,
                source: config.source,
                model: config.model,
                stream: config.stream,
                endpoint,
                tier: config.tier,
                region: config.region,
            });
            const proxyUrl = `${loopbackTransport.baseUrl}/proxy/${issued.ticket}`;

            response.set?.('Cache-Control', 'no-store');
            logStore?.server('info', 'prepare_succeeded', prepareLogContext(config, startedAt));
            return response.json({
                ok: true,
                protocolVersion: PROTOCOL_VERSION,
                pluginId: PLUGIN_ID,
                transport: 'loopback-http',
                ticket: issued.ticket,
                proxySecret: issued.proxySecret,
                proxyUrl,
                expiresAt: issued.expiresAt,
            });
        } catch (error) {
            logStore?.server('error', 'prepare_failed', prepareLogContext(config, startedAt, describeError(error)));
            return sendExpressError(response, error);
        }
    };
}

module.exports = { createPrepareHandler };
