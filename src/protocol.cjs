/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');

const PROTOCOL_VERSION = 2;
const PLUGIN_ID = 'vertex-paygo';
const PLUGIN_VERSION = '0.6.1-pre1';
const COMPATIBLE_ST_RANGE = '>=1.16.0';
const TIERS = Object.freeze(['standard', 'flex', 'priority']);
const AUTH_MODES = Object.freeze(['express', 'full']);

function requireCanonicalString(value, field, pattern, maxLength = 128) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || !pattern.test(value)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `Invalid ${field}.`);
    }
    return value;
}

function validateChatId(value) {
    return requireCanonicalString(value, 'usage chat ID', /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 128);
}

function validateUsagePrice(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'Invalid usage price.');
    }
    const allowed = new Set(['input', 'cachedInput', 'output', 'longContextThreshold', 'longInput', 'longCachedInput', 'longOutput']);
    if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'Invalid usage price field.');
    }
    for (const field of ['input', 'cachedInput', 'output']) {
        if (!Number.isFinite(value[field]) || value[field] < 0) {
            throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `Invalid usage price ${field}.`);
        }
    }
    const result = { input: value.input, cachedInput: value.cachedInput, output: value.output };
    if (value.longContextThreshold !== undefined) {
        if (!Number.isSafeInteger(value.longContextThreshold) || value.longContextThreshold <= 0) {
            throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'Invalid usage price longContextThreshold.');
        }
        result.longContextThreshold = value.longContextThreshold;
        const longFields = ['longInput', 'longCachedInput', 'longOutput'];
        const suppliedLongFields = longFields.filter(field => value[field] !== undefined);
        if (suppliedLongFields.length !== 0 && suppliedLongFields.length !== longFields.length) {
            throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'Long-context prices must be supplied together.');
        }
        for (const field of suppliedLongFields) {
            if (!Number.isFinite(value[field]) || value[field] < 0) {
                throw new PluginError(400, 'INVALID_PREPARE_REQUEST', `Invalid usage price ${field}.`);
            }
            result[field] = value[field];
        }
    } else if (['longInput', 'longCachedInput', 'longOutput'].some(field => value[field] !== undefined)) {
        throw new PluginError(400, 'INVALID_PREPARE_REQUEST', 'Long-context prices require longContextThreshold.');
    }
    return Object.freeze(result);
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
    if (source !== 'makersuite' && (Object.hasOwn(body, 'reverse_proxy') || Object.hasOwn(body, 'proxy_password'))) {
        throw new PluginError(400, 'UPSTREAM_PROXY_UNSUPPORTED', 'Existing reverse-proxy settings are not accepted by this transport.');
    }
    let reverseProxy;
    let proxyPassword;
    if (Object.hasOwn(body, 'reverse_proxy')) {
        try {
            if (typeof body.reverse_proxy !== 'string' || !body.reverse_proxy || body.reverse_proxy.length > 4096
                || body.reverse_proxy.trim() !== body.reverse_proxy || /[\s\\]/u.test(body.reverse_proxy)) throw new Error();
            const url = new URL(body.reverse_proxy);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
            reverseProxy = url.toString().replace(/\/+$/u, '');
        } catch {
            throw new PluginError(400, 'INVALID_REVERSE_PROXY', 'The AI Studio reverse proxy must be an HTTP(S) base URL without credentials, query or fragment.');
        }
        proxyPassword = body.proxy_password ?? '';
        if (typeof proxyPassword !== 'string' || proxyPassword.length > 8192 || /[^\t\x20-\x7e\x80-\xff]/u.test(proxyPassword)) {
            throw new PluginError(400, 'INVALID_PROXY_PASSWORD', 'The AI Studio proxy password is invalid.');
        }
    } else if (Object.hasOwn(body, 'proxy_password')) {
        throw new PluginError(400, 'INVALID_REVERSE_PROXY', 'A proxy password requires an AI Studio reverse proxy URL.');
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
        throw new PluginError(400, 'AI_STUDIO_TIER_UNSUPPORTED', 'Google AI Studio supports Standard and Flex without Vertex PayGo-only in this plugin.');
    }
    if (source === 'vertexai' && (tier === 'flex' || tier === 'priority') && region !== 'global') {
        throw new PluginError(409, 'GLOBAL_REGION_REQUIRED', 'Flex and Priority require the global Vertex AI region.');
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

    const usageChatId = body.usageChatId === undefined || body.usageChatId === null || body.usageChatId === ''
        ? undefined : validateChatId(body.usageChatId);
    const usagePrice = validateUsagePrice(body.usagePrice);

    return Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        source,
        ...(reverseProxy ? { reverseProxy, proxyPassword } : {}),
        model,
        region,
        authMode,
        stream: body.stream,
        tier,
        paygoOnly: body.paygoOnly,
        expressProjectId,
        secretId,
        usageChatId,
        usagePrice,
    });
}

module.exports = {
    AUTH_MODES,
    COMPATIBLE_ST_RANGE,
    PLUGIN_ID,
    PLUGIN_VERSION,
    PROTOCOL_VERSION,
    TIERS,
    validateChatId,
    validatePreparePayload,
    validateUsagePrice,
};
