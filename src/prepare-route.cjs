/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { buildPayGoHeaders } = require('./header-policy.cjs');
const { createHash } = require('node:crypto');
const { sendExpressError, PluginError } = require('./errors.cjs');
const { describeError } = require('./log-store.cjs');
const { PLUGIN_ID, PROTOCOL_VERSION, validatePreparePayload } = require('./protocol.cjs');
const { prepareGoogleHeaders, prepareGoogleTarget } = require('./target-policy.cjs');
const EXPLICIT_SECRET_ERROR_CODES = new Set([
    'EXPLICIT_SECRET_UNSUPPORTED',
    'EXPLICIT_SECRET_NOT_FOUND',
    'EXPLICIT_SECRET_UNAVAILABLE',
]);

function resolveUserKey(user) {
    const profile = user?.profile;
    for (const value of [profile?.handle, profile?.username, profile?.id, user?.id]) {
        if (typeof value === 'string' && value.length > 0 && value.length <= 256) return `identity:${value}`;
    }
    const root = user?.directories?.root;
    if (typeof root === 'string' && root.length > 0) {
        return `directory:${createHash('sha256').update(root).digest('hex')}`;
    }
    // Real authenticated ST requests have a profile handle or user directory.
    // Keep a conservative shared bucket for minimal test/custom middleware users.
    return 'anonymous';
}

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

function createPrepareHandler({ stRuntime, ticketStore, loopbackTransport, logStore, usageStore }) {
    return async function prepareHandler(request, response) {
        const startedAt = Date.now();
        let config;
        let reservation;
        let usageReference;
        logStore?.server('info', 'prepare_started', undefined, { priority: 'low' });
        try {
            config = validatePreparePayload(request.body);
            if (!request.user?.directories || typeof request.user.directories.root !== 'string' || !request.user.directories.root) {
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
            }

            // Reserve both global and per-user capacity before invoking the host's
            // potentially expensive credential loader. The reservation remains in
            // the limits while this async operation is in flight.
            reservation = ticketStore.reserve(resolveUserKey(request.user));

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
                if (EXPLICIT_SECRET_ERROR_CODES.has(error?.code)) {
                    throw new PluginError(400, error.code, error.message, { cause: error });
                }
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
                ticketStore.release(reservation);
                reservation = undefined;
                return undefined;
            }
            if (config.usageChatId) {
                try {
                    usageReference = usageStore?.create(request.user, {
                        chatId: config.usageChatId,
                        model: config.model,
                        source: config.source,
                        tier: config.tier,
                        region: config.region ?? null,
                        stream: config.stream,
                        price: config.usagePrice,
                    });
                } catch (error) {
                    logStore?.server('error', 'usage_ledger_create_failed', prepareLogContext(config, startedAt, describeError(error)), { priority: 'low' });
                }
            }
            const issued = ticketStore.commit(reservation, {
                targetUrl,
                headers,
                source: config.source,
                model: config.model,
                stream: config.stream,
                endpoint,
                tier: config.tier,
                region: config.region,
                usageReference: usageReference ? { file: usageReference.file, id: usageReference.id } : null,
            });
            reservation = undefined;
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
                usageId: usageReference?.id ?? null,
            });
        } catch (error) {
            if (reservation) ticketStore.release(reservation);
            if (usageReference) usageStore?.update(usageReference, { status: 'failed', errorCode: error?.code || 'PREPARE_FAILED' });
            // Every failed prepare is derived from browser-controlled setup or
            // authentication. Keep it out of the shared diagnostic budget so a
            // repeated rejection cannot hide successful proxy failures.
            logStore?.server('error', 'prepare_failed', prepareLogContext(config, startedAt, describeError(error)), { priority: 'low' });
            return sendExpressError(response, error);
        }
    };
}

module.exports = { createPrepareHandler, resolveUserKey };
