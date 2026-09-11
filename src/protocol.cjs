/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');

const PROTOCOL_VERSION = 1;
const PLUGIN_ID = 'vertex-paygo';
const PLUGIN_VERSION = '0.3.0';
const COMPATIBLE_ST_RANGE = '>=1.16.0';
const TIERS = Object.freeze(['standard', 'flex', 'priority']);
const AUTH_MODES = Object.freeze(['express', 'full']);

function requireCanonicalString(value, field, pattern, maxLength = 128) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || !pattern.test(value)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `Invalid ${field}.`);
    }
    return value;
}

function validatePreparePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'The prepare request body must be an object.');
    }
    if (body.protocolVersion !== PROTOCOL_VERSION) {
        throw new PluginError(409, 'PROTOCOL_MISMATCH', `Protocol version ${PROTOCOL_VERSION} is required.`);
    }
    const source = body.chat_completion_source;
    if (!['vertexai', 'makersuite'].includes(source)) {
        throw new PluginError(400, 'GOOGLE_ONLY', 'Only the Vertex AI and Google AI Studio sources are supported.');
    }
    if (Object.hasOwn(body, 'reverse_proxy') || Object.hasOwn(body, 'proxy_password')) {
        throw new PluginError(400, 'UPSTREAM_PROXY_UNSUPPORTED', 'Existing reverse-proxy settings are not accepted by this transport.');
    }

    const model = requireCanonicalString(body.model, 'model', /^gemini-[a-z0-9][a-z0-9._-]*$/u);
    const region = source === 'vertexai'
        ? requireCanonicalString(body.vertexai_region, 'Vertex AI region', /^(?:global|[a-z0-9][a-z0-9-]*)$/u, 63) : undefined;
    const authMode = source === 'vertexai'
        ? requireCanonicalString(body.vertexai_auth_mode, 'Vertex AI authentication mode', /^(?:express|full)$/u, 16) : undefined;
    const tier = requireCanonicalString(body.tier, 'PayGo tier', /^(?:standard|flex|priority)$/u, 16);

    if (typeof body.stream !== 'boolean' || typeof body.paygoOnly !== 'boolean') {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'stream and paygoOnly must be booleans.');
    }
    if (source === 'makersuite' && (tier === 'priority' || body.paygoOnly)) {
        throw new PluginError(400, 'AI_STUDIO_TIER_UNSUPPORTED', 'Google AI Studio supports Flex without Vertex PayGo-only in this plugin.');
    }
    if (source === 'vertexai' && (tier === 'flex' || tier === 'priority') && region !== 'global') {
        throw new PluginError(409, 'GLOBAL_REGION_REQUIRED', 'Flex and Priority require the global Vertex AI region.');
    }
    if (tier === 'standard' && !body.paygoOnly) {
        throw new PluginError(400, 'NATIVE_ROUTE_REQUIRED', 'Standard without PayGo-only must use SillyTavern\'s native Vertex AI route.');
    }

    let expressProjectId;
    if (source === 'vertexai' && body.vertexai_express_project_id !== undefined && body.vertexai_express_project_id !== '') {
        expressProjectId = requireCanonicalString(
            body.vertexai_express_project_id,
            'Vertex AI Express project ID',
            /^[a-z0-9][a-z0-9-]*$/u,
            63,
        );
    }

    let secretId;
    if (body.secret_id !== undefined && body.secret_id !== null && body.secret_id !== '') {
        secretId = requireCanonicalString(body.secret_id, 'secret ID', /^[A-Za-z0-9_-]+$/u, 128);
    }

    return Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        source,
        model,
        region,
        authMode,
        stream: body.stream,
        tier,
        paygoOnly: body.paygoOnly,
        expressProjectId,
        secretId,
    });
}

module.exports = {
    AUTH_MODES,
    COMPATIBLE_ST_RANGE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
    TIERS,
    validatePreparePayload,
};
