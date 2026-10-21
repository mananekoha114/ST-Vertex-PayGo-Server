/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');

const ALLOWED_GOOGLE_HEADERS = new Set(['content-type', 'authorization', 'x-goog-api-key']);

function escapeRegularExpression(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function parseAndValidateGoogleTarget(rawUrl, { model, region, stream, source = 'vertexai', reverseProxy }, prepared) {
    let target;
    try {
        target = new URL(rawUrl);
    } catch {
        throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'SillyTavern returned an invalid Google endpoint.');
    }

    const aiStudio = source === 'makersuite';
    // A ticket may use only the exact base selected for this Studio request.
    // Official requests and Vertex retain their provider allowlist.
    let proxyBase;
    if (aiStudio && reverseProxy) {
        try {
            proxyBase = new URL(reverseProxy);
            if (!['http:', 'https:'].includes(proxyBase.protocol) || proxyBase.username || proxyBase.password
                || proxyBase.search || proxyBase.hash) throw new Error();
        } catch {
            throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'The stored AI Studio proxy base failed validation.');
        }
    }
    const expectedHost = aiStudio ? 'generativelanguage.googleapis.com' : region === 'global'
        ? 'aiplatform.googleapis.com'
        : `${region}-aiplatform.googleapis.com`;
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const expectedPath = aiStudio ? new RegExp(
        `^${proxyBase ? escapeRegularExpression(proxyBase.pathname.replace(/\/+$/u, '')) : ''}/v1(?:beta|alpha)?/models/${escapeRegularExpression(model)}:${endpoint}$`, 'u',
    ) : new RegExp(
        `^/${/^gemini-4-argon(?:-cyber-permissive)?$/u.test(model) && prepared ? 'v1(?:beta1)?' : 'v1'}/(?:projects/[a-z0-9][a-z0-9-]{0,62}/locations/${escapeRegularExpression(region)}/)?publishers/google/models/${escapeRegularExpression(model)}:${endpoint}$`,
        'u',
    );

    if (
        (proxyBase ? target.origin !== proxyBase.origin : target.protocol !== 'https:' || target.hostname !== expectedHost || target.port !== '')
        || target.username !== ''
        || target.password !== ''
        || target.hash !== ''
        || !expectedPath.test(target.pathname)
    ) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'SillyTavern returned a Google endpoint outside the approved provider target.');
    }

    const queryEntries = [...target.searchParams.entries()];
    if (prepared && stream) {
        if (queryEntries.length !== 1 || queryEntries[0][0] !== 'alt' || queryEntries[0][1] !== 'sse') {
            throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'The stored streaming endpoint failed validation.');
        }
    } else if (queryEntries.length !== 0) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_TARGET', 'The Vertex AI endpoint contains an unexpected query.');
    }

    return target;
}

function prepareGoogleTarget(rawUrl, config) {
    const target = parseAndValidateGoogleTarget(rawUrl, config, false);
    if (config.stream) {
        target.searchParams.set('alt', 'sse');
    }
    return target.toString();
}

function validatePreparedGoogleTarget(rawUrl, config) {
    return parseAndValidateGoogleTarget(rawUrl, config, true);
}

function prepareGoogleHeaders(configHeaders, payGoHeaders, { allowUnauthenticated = false } = {}) {
    if (!configHeaders || typeof configHeaders !== 'object' || Array.isArray(configHeaders)) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_HEADERS', 'SillyTavern returned invalid Vertex AI headers.');
    }

    const headers = {};
    for (const [name, value] of Object.entries(configHeaders)) {
        const normalizedName = name.toLowerCase();
        // ST permits proxies without a password. Omit its empty header rather
        // than falling back to the user's real Google credential.
        if (allowUnauthenticated && normalizedName === 'x-goog-api-key' && (value === '' || value == null)) continue;
        if (!ALLOWED_GOOGLE_HEADERS.has(normalizedName) || typeof value !== 'string' || value.length === 0) {
            throw new PluginError(500, 'UNSAFE_GOOGLE_HEADERS', 'SillyTavern returned an unexpected Vertex AI header.');
        }
        headers[name] = value;
    }
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
    }
    if (!allowUnauthenticated && !Object.keys(headers).some(name => ['authorization', 'x-goog-api-key'].includes(name.toLowerCase()))) {
        throw new PluginError(500, 'UNSAFE_GOOGLE_HEADERS', 'SillyTavern did not return Vertex AI authentication.');
    }

    return Object.freeze({ ...headers, ...payGoHeaders });
}

module.exports = {
    prepareGoogleHeaders,
    prepareGoogleTarget,
    validatePreparedGoogleTarget,
};
