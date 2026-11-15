/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const path = require('node:path');
const { readBoundedStream } = require('./bounded-buffer.cjs');
const { PluginError } = require('./errors.cjs');

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,62}$/u;
const SAFE_NETWORK_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/u;
const DEFAULT_OAUTH_TIMEOUT_MS = 15_000;
const MAX_OAUTH_RESPONSE_BYTES = 16 * 1024;
const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 3600;
const REFRESH_EARLY_MS = 5 * 60_000;
const MAX_CACHE_TTL_MS = 55 * 60_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_OAUTH_DESCRIPTION_LENGTH = 200;

const ALLOWED_OAUTH_ERRORS = new Set([
    'invalid_grant',
    'invalid_client',
    'unauthorized_client',
    'invalid_request',
    'invalid_scope',
    'unsupported_grant_type',
    'access_denied',
]);

const TIMEOUT_NETWORK_CODES = new Set([
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
]);

function invalidServiceAccountError() {
    return new PluginError(
        400,
        'VERTEX_INVALID_SERVICE_ACCOUNT',
        'The saved Vertex AI service account JSON or private key is invalid.',
    );
}

function validateServiceAccount(serialized, googleModule = undefined) {
    if (typeof serialized !== 'string' || !serialized.trim()) {
        throw invalidServiceAccountError();
    }
    let serviceAccount;
    try {
        serviceAccount = JSON.parse(serialized);
    } catch {
        throw invalidServiceAccountError();
    }
    if (!serviceAccount || typeof serviceAccount !== 'object' || Array.isArray(serviceAccount)) {
        throw invalidServiceAccountError();
    }
    let projectId;
    try {
        projectId = typeof googleModule?.getProjectIdFromServiceAccount === 'function'
            ? googleModule.getProjectIdFromServiceAccount(serviceAccount)
            : serviceAccount.project_id;
    } catch {
        throw invalidServiceAccountError();
    }
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
        throw invalidServiceAccountError();
    }
    if (typeof serviceAccount.client_email !== 'string'
        || !serviceAccount.client_email.trim()
        || serviceAccount.client_email.length > 320) {
        throw invalidServiceAccountError();
    }
    if (typeof serviceAccount.private_key !== 'string' || !serviceAccount.private_key.trim()) {
        throw invalidServiceAccountError();
    }
    return { serviceAccount, projectId };
}

async function signServiceAccountJwt(serviceAccount, googleModule = undefined, nowSeconds = Math.floor(Date.now() / 1000)) {
    try {
        if (typeof googleModule?.generateJWTToken === 'function') {
            const token = await googleModule.generateJWTToken(serviceAccount);
            if (typeof token !== 'string' || !token.trim()) {
                throw new Error('Empty JWT');
            }
            return token;
        }
        const headerBase64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payloadBase64 = Buffer.from(JSON.stringify({
            iss: serviceAccount.client_email,
            scope: OAUTH_SCOPE,
            aud: OAUTH_TOKEN_URL,
            iat: nowSeconds,
            exp: nowSeconds + DEFAULT_TOKEN_EXPIRES_IN_SECONDS,
        })).toString('base64url');
        const signatureInput = `${headerBase64}.${payloadBase64}`;
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(signatureInput);
        const signature = sign.sign(serviceAccount.private_key, 'base64url');
        return `${signatureInput}.${signature}`;
    } catch {
        throw invalidServiceAccountError();
    }
}

function sanitizeOAuthDescription(description, serviceAccount) {
    if (typeof description !== 'string' || !description.trim()) return undefined;
    let text = description;
    for (const secret of [serviceAccount?.private_key, serviceAccount?.private_key_id]) {
        if (typeof secret === 'string' && secret.trim()) {
            text = text.split(secret).join('[redacted]');
            const escaped = JSON.stringify(secret).slice(1, -1);
            if (escaped) text = text.split(escaped).join('[redacted]');
        }
    }
    text = text
        .replace(/-----BEGIN[\s\S]*?-----END[^\r\n-]*-----/gu, '[redacted]')
        .replace(/-----BEGIN[^\r\n]*/gu, '[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)+\b/gu, '[redacted]')
        .replace(/\bya29\.[0-9A-Za-z._-]+/gu, '[redacted]')
        .replace(/\bAIza[0-9A-Za-z_-]{20,}/gu, '[redacted]')
        .replace(/[A-Za-z0-9+/=_-]{48,}/gu, '[redacted]')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, MAX_OAUTH_DESCRIPTION_LENGTH);
    return text || undefined;
}

function classifyNetworkFailure(error, timedOut = false) {
    const rawCode = error?.code ?? error?.cause?.code;
    const networkCode = typeof rawCode === 'string' && SAFE_NETWORK_CODE_PATTERN.test(rawCode) ? rawCode : undefined;
    if (timedOut || (networkCode && TIMEOUT_NETWORK_CODES.has(networkCode))) {
        return new PluginError(
            504,
            'VERTEX_OAUTH_TIMEOUT',
            'Timed out while requesting a Google OAuth access token.',
            networkCode ? { details: { networkCode } } : undefined,
        );
    }
    return new PluginError(
        502,
        'VERTEX_OAUTH_NETWORK_FAILED',
        'Could not connect to Google OAuth token endpoint.',
        networkCode ? { details: { networkCode } } : undefined,
    );
}

function classifyOAuthHttpFailure(statusCode, parsed, serviceAccount) {
    if (statusCode === 429) {
        return new PluginError(
            429,
            'VERTEX_OAUTH_RATE_LIMITED',
            'Google OAuth rate-limited the access token request.',
            { details: { upstreamStatus: 429 } },
        );
    }
    if (statusCode >= 500 && statusCode <= 504) {
        return new PluginError(
            statusCode,
            'VERTEX_OAUTH_UPSTREAM_ERROR',
            `Google OAuth or the network proxy returned HTTP ${statusCode}.`,
            { details: { upstreamStatus: statusCode } },
        );
    }
    if ((statusCode === 400 || statusCode === 401 || statusCode === 403)
        && parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && (typeof parsed.error === 'string' || (parsed.error && typeof parsed.error === 'object'))) {
        const rawOAuthError = typeof parsed.error === 'string' ? parsed.error : undefined;
        const oauthError = rawOAuthError && ALLOWED_OAUTH_ERRORS.has(rawOAuthError) ? rawOAuthError : undefined;
        const oauthDescription = oauthError
            ? sanitizeOAuthDescription(parsed.error_description, serviceAccount)
            : undefined;
        // Never return HTTP 401 on host routes: browsers with SillyTavern HTTP
        // Basic Auth enabled would treat 401 as a host authentication challenge.
        return new PluginError(
            400,
            'VERTEX_OAUTH_REJECTED',
            oauthError
                ? `Google OAuth rejected the service account credentials (${oauthError}${oauthDescription ? `: ${oauthDescription}` : ''}).`
                : 'Google OAuth rejected the service account credentials.',
            {
                details: {
                    upstreamStatus: statusCode,
                    ...(oauthError ? { oauthError } : {}),
                    ...(oauthDescription ? { oauthDescription } : {}),
                },
            },
        );
    }
    return new PluginError(
        502,
        'VERTEX_OAUTH_UPSTREAM_ERROR',
        `Google OAuth or the network proxy returned HTTP ${statusCode}.`,
        { details: { upstreamStatus: statusCode } },
    );
}

function exchangeJwtForAccessToken({
    jwtToken,
    serviceAccount,
    oauthRequest = https.request,
    timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
}) {
    const payload = Buffer.from(new URLSearchParams({
        grant_type: OAUTH_GRANT_TYPE,
        assertion: jwtToken,
    }).toString(), 'utf8');

    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let activeResponse;

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };

        let outgoing;
        try {
            outgoing = oauthRequest(new URL(OAUTH_TOKEN_URL), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': payload.length,
                    Accept: 'application/json',
                    'Accept-Encoding': 'identity',
                },
            }, async incoming => {
                activeResponse = incoming;
                const statusCode = Number.isSafeInteger(incoming.statusCode) ? incoming.statusCode : 502;
                if (statusCode >= 300 && statusCode < 400) {
                    incoming.destroy();
                    finish(new PluginError(
                        502,
                        'VERTEX_OAUTH_UPSTREAM_ERROR',
                        'Google OAuth returned an unexpected redirect.',
                        { details: { upstreamStatus: statusCode } },
                    ));
                    return;
                }
                let rawBuffer;
                try {
                    rawBuffer = await readBoundedStream(incoming, MAX_OAUTH_RESPONSE_BYTES);
                } catch (streamError) {
                    finish(classifyNetworkFailure(streamError, timedOut));
                    return;
                }
                if (rawBuffer === null) {
                    if (statusCode >= 200 && statusCode < 300) {
                        finish(new PluginError(
                            502,
                            'VERTEX_OAUTH_INVALID_RESPONSE',
                            'Google OAuth returned an oversized access token response.',
                        ));
                        return;
                    }
                    finish(classifyOAuthHttpFailure(statusCode, undefined, serviceAccount));
                    return;
                }

                let parsed;
                try {
                    parsed = JSON.parse(rawBuffer.toString('utf8'));
                } catch {
                    parsed = undefined;
                }

                if (statusCode >= 200 && statusCode < 300) {
                    const accessToken = parsed?.access_token;
                    if (typeof accessToken !== 'string' || !accessToken.trim() || /[\r\n]/u.test(accessToken)) {
                        finish(new PluginError(
                            502,
                            'VERTEX_OAUTH_INVALID_RESPONSE',
                            'Google OAuth returned an invalid access token response.',
                        ));
                        return;
                    }
                    const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
                        ? Math.floor(parsed.expires_in)
                        : DEFAULT_TOKEN_EXPIRES_IN_SECONDS;
                    finish(null, { accessToken, expiresIn });
                    return;
                }

                finish(classifyOAuthHttpFailure(statusCode, parsed, serviceAccount));
            });
        } catch (error) {
            finish(classifyNetworkFailure(error, false));
            return;
        }

        outgoing.setTimeout?.(timeoutMs, () => {
            timedOut = true;
            activeResponse?.destroy();
            outgoing.destroy();
            finish(classifyNetworkFailure(undefined, true));
        });
        outgoing.once('error', error => {
            finish(classifyNetworkFailure(error, timedOut));
        });
        outgoing.end(payload);
    });
}

async function exchangeWithHostHelper(jwtToken, googleModule) {
    try {
        const accessToken = await googleModule.getAccessToken(jwtToken);
        if (typeof accessToken !== 'string' || !accessToken.trim() || /[\r\n]/u.test(accessToken)) {
            throw new PluginError(
                502,
                'VERTEX_OAUTH_INVALID_RESPONSE',
                'Google OAuth returned an invalid access token response.',
            );
        }
        return { accessToken, expiresIn: DEFAULT_TOKEN_EXPIRES_IN_SECONDS };
    } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new PluginError(
            502,
            'VERTEX_OAUTH_UPSTREAM_ERROR',
            'Google OAuth could not issue an access token.',
        );
    }
}

function computeOAuthCacheKey(userRoot, serialized) {
    const normalizedRoot = typeof userRoot === 'string' && userRoot ? path.resolve(userRoot) : '';
    return crypto.createHash('sha256').update(JSON.stringify([normalizedRoot, serialized])).digest('hex');
}

function createVertexOAuthClient({
    oauthRequest = https.request,
    timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
    maxEntries = MAX_CACHE_ENTRIES,
    now = Date.now,
} = {}) {
    const cache = new Map();
    const inFlight = new Map();

    function pruneCache(currentTime) {
        for (const [key, entry] of cache) {
            if (entry.expiresAt <= currentTime) cache.delete(key);
        }
        while (cache.size >= maxEntries) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) break;
            cache.delete(oldestKey);
        }
    }

    return Object.freeze({
        validateServiceAccount,

        async authenticateServiceAccount({
            userRoot = '',
            serialized,
            googleModule = undefined,
            useHostAccessTokenFallback = false,
        }) {
            const { serviceAccount, projectId } = validateServiceAccount(serialized, googleModule);
            const oauthCacheKey = computeOAuthCacheKey(userRoot, serialized);
            const currentTime = now();
            const cached = cache.get(oauthCacheKey);
            if (cached) {
                if (cached.expiresAt > currentTime) {
                    cache.delete(oauthCacheKey);
                    cache.set(oauthCacheKey, cached);
                    return {
                        projectId,
                        accessToken: cached.accessToken,
                        oauthCacheKey,
                        fromCache: true,
                    };
                }
                cache.delete(oauthCacheKey);
            }

            let pending = inFlight.get(oauthCacheKey);
            if (!pending) {
                pending = (async () => {
                    const jwtToken = await signServiceAccountJwt(
                        serviceAccount,
                        googleModule,
                        Math.floor(now() / 1000),
                    );
                    const { accessToken, expiresIn } = useHostAccessTokenFallback
                        ? await exchangeWithHostHelper(jwtToken, googleModule)
                        : await exchangeJwtForAccessToken({
                            jwtToken,
                            serviceAccount,
                            oauthRequest,
                            timeoutMs,
                        });
                    const ttlMs = Math.min(
                        Math.max((Number.isFinite(expiresIn) ? expiresIn : DEFAULT_TOKEN_EXPIRES_IN_SECONDS) * 1000 - REFRESH_EARLY_MS, 0),
                        MAX_CACHE_TTL_MS,
                    );
                    if (ttlMs > 0) {
                        const settledAt = now();
                        pruneCache(settledAt);
                        cache.set(oauthCacheKey, { accessToken, expiresAt: settledAt + ttlMs });
                    }
                    return accessToken;
                })();
                inFlight.set(oauthCacheKey, pending);
                pending.finally(() => {
                    if (inFlight.get(oauthCacheKey) === pending) {
                        inFlight.delete(oauthCacheKey);
                    }
                }).catch(() => {});
            }

            const accessToken = await pending;
            return {
                projectId,
                accessToken,
                oauthCacheKey,
                fromCache: false,
            };
        },

        invalidate(oauthCacheKey) {
            if (typeof oauthCacheKey === 'string' && oauthCacheKey) {
                cache.delete(oauthCacheKey);
            }
        },

        clear() {
            cache.clear();
            inFlight.clear();
        },

        get cacheSize() {
            return cache.size;
        },
    });
}

module.exports = {
    ALLOWED_OAUTH_ERRORS,
    DEFAULT_OAUTH_TIMEOUT_MS,
    MAX_CACHE_TTL_MS,
    OAUTH_TOKEN_URL,
    REFRESH_EARLY_MS,
    computeOAuthCacheKey,
    createVertexOAuthClient,
    exchangeJwtForAccessToken,
    sanitizeOAuthDescription,
    signServiceAccountJwt,
    validateServiceAccount,
};
