/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

// A user-selected reverse proxy must receive the request SillyTavern itself
// would send. Every reverse-proxy rule lives here: the accepted base URL and
// password, the model names a proxy may serve, and the credential placement
// and default headers of the forwarded request.

const { PluginError } = require('./errors.cjs');

const MAX_REVERSE_PROXY_LENGTH = 4096;
const MAX_PROXY_PASSWORD_LENGTH = 8192;
const MAX_PROXY_MODEL_LENGTH = 256;
const MAX_FORWARDED_HEADER_LENGTH = 1024;
// Redacting a one or two character secret would mangle every message while
// protecting nothing.
const MIN_REDACTED_SECRET_LENGTH = 4;
// SillyTavern sends its own proxy requests through node-fetch 3, which adds
// these headers when the caller does not.
const NODE_FETCH_ACCEPT = '*/*';
const NODE_FETCH_USER_AGENT = 'node-fetch';

function validateReverseProxy(body) {
    if (!Object.hasOwn(body, 'reverse_proxy')) {
        if (Object.hasOwn(body, 'proxy_password')) {
            throw new PluginError(400, 'INVALID_REVERSE_PROXY', 'A proxy password requires a reverse proxy URL.');
        }
        return undefined;
    }
    let reverseProxy;
    try {
        const value = body.reverse_proxy;
        if (typeof value !== 'string' || !value || value.length > MAX_REVERSE_PROXY_LENGTH
            || value.trim() !== value || /[\s\\?#]/u.test(value)) throw new Error();
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        reverseProxy = url.toString().replace(/\/+$/u, '');
    } catch {
        throw new PluginError(400, 'INVALID_REVERSE_PROXY', 'The reverse proxy must be an HTTP(S) base URL without credentials, query or fragment.');
    }
    const proxyPassword = body.proxy_password ?? '';
    if (typeof proxyPassword !== 'string' || proxyPassword.length > MAX_PROXY_PASSWORD_LENGTH
        || /[^\t\x20-\x7e\x80-\xff]/u.test(proxyPassword)) {
        throw new PluginError(400, 'INVALID_PROXY_PASSWORD', 'The reverse proxy password is invalid.');
    }
    return Object.freeze({ reverseProxy, proxyPassword });
}

// The frontend hands every Gemini-prefixed model to the plugin, and a proxy
// may serve aliases, upper-case names or localized suffixes. The name must
// still be a single path segment that survives URL encoding unchanged.
function isProxyModel(model) {
    return typeof model === 'string' && model.length <= MAX_PROXY_MODEL_LENGTH && model.isWellFormed()
        && /^gemini-/iu.test(model) && !/[\s\p{Cc}\p{Cf}/\\?#%]/u.test(model);
}

// SillyTavern interpolates the model into its URL and lets WHATWG URL parsing
// encode it, so paths are compared in that same encoded form.
function encodedModelSegment(model) {
    return new URL(`http://model.invalid/${model}`).pathname.slice(1);
}

function proxyPathPrefix(reverseProxy) {
    return reverseProxy ? new URL(reverseProxy).pathname.replace(/\/+$/u, '') : '';
}

// SillyTavern's own Studio chat request carries the proxy credential as ?key=,
// even when it is empty, so it is kept apart from the forwarded headers.
function takeProxyKey(headers) {
    let proxyKey = '';
    const remaining = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === 'x-goog-api-key') proxyKey = value;
        else remaining[name] = value;
    }
    return { headers: Object.freeze(remaining), proxyKey };
}

// Gemini 4 on Vertex needs v1beta1. Rewrite only the version segment that
// directly follows the selected proxy base, never a segment inside the base.
function toVertexBetaTarget(target, { source, reverseProxy }) {
    const result = new URL(target);
    const prefix = proxyPathPrefix(reverseProxy);
    if (source !== 'makersuite' && result.pathname.startsWith(`${prefix}/v1/`)) {
        result.pathname = `${prefix}/v1beta1/${result.pathname.slice(prefix.length + 4)}`;
    }
    return result;
}

function forwardedHeader(value, fallback) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_FORWARDED_HEADER_LENGTH
        && !/[^\t\x20-\x7e\x80-\xff]/u.test(value) ? value : fallback;
}

// Official targets keep the prepared request unchanged. A reverse proxy gets
// SillyTavern's native request instead: the Studio credential as the first
// query parameter and the host's Accept and User-Agent. Accept-Encoding stays
// unset so the response remains readable for usage capture.
// Call only after the stored target passed validatePreparedGoogleTarget, which
// must keep rejecting a key in the stored query.
function buildUpstreamRequest(target, ticketData, incomingHeaders = {}) {
    const headers = { ...ticketData.headers };
    let url = new URL(target);
    if (!ticketData.reverseProxy) return { url, headers };
    if (ticketData.source === 'makersuite') {
        url.search = '';
        // Interpolate exactly like SillyTavern so the proxy receives the same bytes.
        url = new URL(`${url.toString()}?key=${ticketData.proxyKey ?? ''}${ticketData.stream ? '&alt=sse' : ''}`);
    }
    for (const name of Object.keys(headers)) {
        if (['accept', 'user-agent', 'accept-encoding'].includes(name.toLowerCase())) delete headers[name];
    }
    headers.Accept = forwardedHeader(incomingHeaders.accept, NODE_FETCH_ACCEPT);
    headers['User-Agent'] = forwardedHeader(incomingHeaders['user-agent'], NODE_FETCH_USER_AGENT);
    return { url, headers };
}

function proxyCredential(ticketData) {
    if (!ticketData?.reverseProxy) return '';
    if (ticketData.source === 'makersuite') return typeof ticketData.proxyKey === 'string' ? ticketData.proxyKey : '';
    const authorization = Object.entries(ticketData.headers || {})
        .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
    return typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

// A proxy may echo its credential, or the URL carrying it, in an error message.
// Cover the raw value, its form in the forwarded query, and its component form.
function redactProxySecret(text, ticketData) {
    const secret = proxyCredential(ticketData);
    const forms = new Set([secret, new URL(`http://secret.invalid/?${secret}`).search.slice(1)]);
    try { forms.add(encodeURIComponent(secret)); } catch { /* A malformed string has no component form. */ }
    let result = text;
    for (const form of forms) {
        if (form.length >= MIN_REDACTED_SECRET_LENGTH) result = result.split(form).join('[redacted]');
    }
    return result;
}

module.exports = {
    buildUpstreamRequest,
    encodedModelSegment,
    isProxyModel,
    proxyPathPrefix,
    redactProxySecret,
    takeProxyKey,
    toVertexBetaTarget,
    validateReverseProxy,
};
