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
const { PLUGIN_ID, PROTOCOL_VERSION, validatePreparePayload } = require('./protocol.cjs');
const { prepareGoogleHeaders, prepareGoogleTarget } = require('./target-policy.cjs');

function createPrepareHandler({ stRuntime, ticketStore, loopbackTransport }) {
    return async function prepareHandler(request, response) {
        try {
            const config = validatePreparePayload(request.body);
            if (!request.user || !request.user.directories) {
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
            }

            const syntheticBody = {
                api: 'vertexai',
                vertexai_auth_mode: config.authMode,
                vertexai_region: config.region,
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
                    'VERTEX_AUTH_CONFIGURATION_FAILED',
                    'Vertex AI authentication is unavailable for this configuration.',
                    { cause: error },
                );
            }

            const targetUrl = prepareGoogleTarget(googleConfig.url, config);
            const headers = prepareGoogleHeaders(googleConfig.headers, buildPayGoHeaders(config));
            if (request.aborted || response.destroyed) {
                return undefined;
            }
            const issued = ticketStore.create({
                targetUrl,
                headers,
                model: config.model,
                stream: config.stream,
                endpoint,
                tier: config.tier,
                region: config.region,
            });
            const proxyUrl = `${loopbackTransport.baseUrl}/proxy/${issued.ticket}`;

            response.set?.('Cache-Control', 'no-store');
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
            return sendExpressError(response, error);
        }
    };
}

module.exports = { createPrepareHandler };
