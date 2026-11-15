/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
    OAUTH_TOKEN_URL,
    createVertexOAuthClient,
    exchangeJwtForAccessToken,
    sanitizeOAuthDescription,
    signServiceAccountJwt,
    validateServiceAccount,
} = require('../src/vertex-oauth.cjs');

const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeServiceAccount(overrides = {}) {
    return {
        type: 'service_account',
        project_id: 'demo-vertex-project',
        private_key_id: 'private-key-id-secret-value',
        private_key: TEST_PRIVATE_KEY,
        client_email: 'runner@demo-vertex-project.iam.gserviceaccount.com',
        ...overrides,
    };
}

function createFakeOAuthRequest(responder) {
    const calls = [];
    const oauthRequest = (url, options, onResponse) => {
        const outgoing = new EventEmitter();
        const requestChunks = [];
        let timeoutHandler;
        let destroyed = false;

        outgoing.setTimeout = (_ms, handler) => {
            timeoutHandler = handler;
            return outgoing;
        };
        outgoing.destroy = () => {
            destroyed = true;
        };
        outgoing.write = chunk => {
            requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
        };
        outgoing.end = chunk => {
            if (chunk) outgoing.write(chunk);
            const body = Buffer.concat(requestChunks).toString('utf8');
            const record = {
                url: String(url),
                options,
                body,
                get destroyed() { return destroyed; },
                triggerTimeout() { timeoutHandler?.(); },
            };
            calls.push(record);
            queueMicrotask(() => responder({
                outgoing,
                record,
                reply(statusCode, payload, headers = { 'content-type': 'application/json' }) {
                    const incoming = new PassThrough();
                    incoming.statusCode = statusCode;
                    incoming.headers = headers;
                    onResponse(incoming);
                    if (payload !== undefined) {
                        incoming.end(typeof payload === 'string' || Buffer.isBuffer(payload)
                            ? payload
                            : JSON.stringify(payload));
                    } else {
                        incoming.end();
                    }
                    return incoming;
                },
            }));
        };
        return outgoing;
    };
    return { oauthRequest, calls };
}

test('built-in RS256 signer generates verifiable service account assertions', async () => {
    const account = makeServiceAccount();
    const { serviceAccount, projectId } = validateServiceAccount(JSON.stringify(account));
    assert.equal(projectId, 'demo-vertex-project');

    const jwt = await signServiceAccountJwt(serviceAccount, undefined, 1_700_000_000);
    const parts = jwt.split('.');
    assert.equal(parts.length, 3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
    assert.equal(payload.iss, account.client_email);
    assert.equal(payload.aud, OAUTH_TOKEN_URL);
    assert.equal(payload.iat, 1_700_000_000);
    assert.equal(payload.exp, 1_700_003_600);

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    assert.equal(verifier.verify(TEST_PUBLIC_KEY, parts[2], 'base64url'), true);
});

test('malformed service account JSON, project_id, or private key fails with 400 VERTEX_INVALID_SERVICE_ACCOUNT without leaking secrets', async () => {
    const invalidInputs = [
        '',
        'not-json-at-all-secret-marker',
        '[]',
        JSON.stringify(makeServiceAccount({ project_id: 'INVALID_UPPERCASE' })),
        JSON.stringify(makeServiceAccount({ project_id: 'abc' })),
        JSON.stringify(makeServiceAccount({ client_email: '' })),
        JSON.stringify(makeServiceAccount({ private_key: '' })),
        JSON.stringify(makeServiceAccount({ private_key: '-----BEGIN PRIVATE KEY-----\ncorrupt-secret-material\n-----END PRIVATE KEY-----' })),
    ];

    const client = createVertexOAuthClient({
        oauthRequest: () => assert.fail('network must not be called for invalid local credentials'),
    });

    for (const serialized of invalidInputs) {
        await assert.rejects(
            client.authenticateServiceAccount({ userRoot: '/tmp/alice', serialized }),
            error => {
                assert.equal(error.status, 400);
                assert.equal(error.code, 'VERTEX_INVALID_SERVICE_ACCOUNT');
                assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /secret-marker|corrupt-secret-material|BEGIN PRIVATE KEY/u);
                return true;
            },
        );
    }
});

test('OAuth HTTP 5xx and 429 preserve upstream status codes instead of collapsing to 400', async () => {
    for (const statusCode of [500, 502, 503, 504]) {
        const { oauthRequest } = createFakeOAuthRequest(({ reply }) => {
            reply(statusCode, '<html>Upstream Gateway Error</html>', { 'content-type': 'text/html' });
        });
        await assert.rejects(
            exchangeJwtForAccessToken({ jwtToken: 'signed.jwt.value', serviceAccount: makeServiceAccount(), oauthRequest }),
            error => {
                assert.equal(error.status, statusCode);
                assert.equal(error.code, 'VERTEX_OAUTH_UPSTREAM_ERROR');
                assert.deepEqual(error.details, { upstreamStatus: statusCode });
                return true;
            },
        );
    }

    const rateLimited = createFakeOAuthRequest(({ reply }) => {
        reply(429, { error: 'rate_limit_exceeded' });
    });
    await assert.rejects(
        exchangeJwtForAccessToken({ jwtToken: 'signed.jwt.value', serviceAccount: makeServiceAccount(), oauthRequest: rateLimited.oauthRequest }),
        error => {
            assert.equal(error.status, 429);
            assert.equal(error.code, 'VERTEX_OAUTH_RATE_LIMITED');
            assert.deepEqual(error.details, { upstreamStatus: 429 });
            return true;
        },
    );
});

test('Google OAuth rejections map to HTTP 400 VERTEX_OAUTH_REJECTED (never 401) and redact credential-like fragments', async () => {
    const account = makeServiceAccount();
    for (const upstreamStatus of [400, 401, 403]) {
        const { oauthRequest } = createFakeOAuthRequest(({ reply }) => {
            reply(upstreamStatus, {
                error: 'invalid_grant',
                error_description: `Invalid JWT Signature: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig token ya29.secret_access_token key ${account.private_key_id}`,
            });
        });
        await assert.rejects(
            exchangeJwtForAccessToken({ jwtToken: 'signed.jwt.value', serviceAccount: account, oauthRequest }),
            error => {
                assert.equal(error.status, 400);
                assert.notEqual(error.status, 401);
                assert.equal(error.code, 'VERTEX_OAUTH_REJECTED');
                assert.equal(error.details.upstreamStatus, upstreamStatus);
                assert.equal(error.details.oauthError, 'invalid_grant');
                assert.match(error.details.oauthDescription, /Invalid JWT Signature/u);
                assert.doesNotMatch(error.details.oauthDescription, /eyJhbGci|ya29\.|private-key-id-secret-value/u);
                assert.doesNotMatch(error.message, /eyJhbGci|ya29\.|private-key-id-secret-value/u);
                return true;
            },
        );
    }

    assert.equal(
        sanitizeOAuthDescription('Clock skew for -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', account),
        'Clock skew for [redacted]',
    );
});

test('unexpected proxy HTML pages, redirects, socket failures, timeouts, and invalid 200 payloads map to 502 or 504', async () => {
    const proxyAuth = createFakeOAuthRequest(({ reply }) => {
        reply(407, '<html>Proxy Authentication Required</html>', { 'content-type': 'text/html' });
    });
    await assert.rejects(
        exchangeJwtForAccessToken({ jwtToken: 'jwt', serviceAccount: makeServiceAccount(), oauthRequest: proxyAuth.oauthRequest }),
        { status: 502, code: 'VERTEX_OAUTH_UPSTREAM_ERROR', details: { upstreamStatus: 407 } },
    );

    const redirect = createFakeOAuthRequest(({ reply }) => {
        reply(302, '', { location: 'https://evil.example/login' });
    });
    await assert.rejects(
        exchangeJwtForAccessToken({ jwtToken: 'jwt', serviceAccount: makeServiceAccount(), oauthRequest: redirect.oauthRequest }),
        { status: 502, code: 'VERTEX_OAUTH_UPSTREAM_ERROR', details: { upstreamStatus: 302 } },
    );

    const reset = createFakeOAuthRequest(({ outgoing }) => {
        outgoing.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    });
    await assert.rejects(
        exchangeJwtForAccessToken({ jwtToken: 'jwt', serviceAccount: makeServiceAccount(), oauthRequest: reset.oauthRequest }),
        { status: 502, code: 'VERTEX_OAUTH_NETWORK_FAILED', details: { networkCode: 'ECONNRESET' } },
    );

    const etimedout = createFakeOAuthRequest(({ outgoing }) => {
        outgoing.emit('error', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    });
    await assert.rejects(
        exchangeJwtForAccessToken({ jwtToken: 'jwt', serviceAccount: makeServiceAccount(), oauthRequest: etimedout.oauthRequest }),
        { status: 504, code: 'VERTEX_OAUTH_TIMEOUT', details: { networkCode: 'ETIMEDOUT' } },
    );

    const localTimeout = createFakeOAuthRequest(({ record }) => {
        record.triggerTimeout();
    });
    await assert.rejects(
        exchangeJwtForAccessToken({ jwtToken: 'jwt', serviceAccount: makeServiceAccount(), oauthRequest: localTimeout.oauthRequest, timeoutMs: 25 }),
        error => error.status === 504 && error.code === 'VERTEX_OAUTH_TIMEOUT' && localTimeout.calls[0].destroyed,
    );

    for (const badBody of [{}, { access_token: '   ' }, { access_token: 'bad\r\ntoken' }, 'x'.repeat(20 * 1024)]) {
        const invalid200 = createFakeOAuthRequest(({ reply }) => {
            reply(200, badBody);
        });
        await assert.rejects(
            exchangeJwtForAccessToken({ jwtToken: 'jwt', serviceAccount: makeServiceAccount(), oauthRequest: invalid200.oauthRequest }),
            { status: 502, code: 'VERTEX_OAUTH_INVALID_RESPONSE' },
        );
    }
});

test('in-memory token cache reuses fresh tokens, refreshes 5 minutes before expiry, deduplicates concurrent calls, and isolates users/keys', async () => {
    let currentTime = 1_700_000_000_000;
    let tokenCounter = 0;
    let releaseFirstBatch;
    const firstBatchGate = new Promise(resolve => { releaseFirstBatch = resolve; });

    const { oauthRequest, calls } = createFakeOAuthRequest(async ({ reply }) => {
        const index = ++tokenCounter;
        if (index === 1) await firstBatchGate;
        reply(200, { access_token: `ya29.cached-token-${index}`, expires_in: 3600 });
    });

    const client = createVertexOAuthClient({
        oauthRequest,
        now: () => currentTime,
        maxEntries: 2,
    });
    const serializedA = JSON.stringify(makeServiceAccount());
    const serializedB = JSON.stringify(makeServiceAccount({ client_email: 'second@demo-vertex-project.iam.gserviceaccount.com' }));

    // Singleflight: 4 concurrent calls for the same user + credential share 1 OAuth request.
    const concurrent = Array.from({ length: 4 }, () => client.authenticateServiceAccount({
        userRoot: '/users/alice',
        serialized: serializedA,
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1);
    releaseFirstBatch();
    const results = await Promise.all(concurrent);
    assert.deepEqual(results.map(item => item.accessToken), Array(4).fill('ya29.cached-token-1'));
    assert.equal(client.cacheSize, 1);

    // Cache hit at T + 54m59s (within 3600s - 300s = 3300s window).
    currentTime += (54 * 60 + 59) * 1000;
    const hit = await client.authenticateServiceAccount({ userRoot: '/users/alice', serialized: serializedA });
    assert.equal(hit.fromCache, true);
    assert.equal(hit.accessToken, 'ya29.cached-token-1');
    assert.equal(calls.length, 1);

    // Early refresh once within 5 minutes of expiry (T + 55m01s).
    currentTime += 2_000;
    const refreshed = await client.authenticateServiceAccount({ userRoot: '/users/alice', serialized: serializedA });
    assert.equal(refreshed.fromCache, false);
    assert.equal(refreshed.accessToken, 'ya29.cached-token-2');
    assert.equal(calls.length, 2);

    // Different user directory and different service account never share cached tokens.
    const bob = await client.authenticateServiceAccount({ userRoot: '/users/bob', serialized: serializedA });
    assert.equal(bob.accessToken, 'ya29.cached-token-3');
    assert.notEqual(bob.oauthCacheKey, refreshed.oauthCacheKey);
    assert.equal(client.cacheSize, 2);

    // Bounded capacity evicts the oldest entry when maxEntries (2) is reached.
    const rotated = await client.authenticateServiceAccount({ userRoot: '/users/alice', serialized: serializedB });
    assert.equal(rotated.accessToken, 'ya29.cached-token-4');
    assert.equal(client.cacheSize, 2);

    // Downstream 401 invalidation evicts only that credential's cached token.
    client.invalidate(rotated.oauthCacheKey);
    assert.equal(client.cacheSize, 1);
    const reissued = await client.authenticateServiceAccount({ userRoot: '/users/alice', serialized: serializedB });
    assert.equal(reissued.accessToken, 'ya29.cached-token-5');

    client.clear();
    assert.equal(client.cacheSize, 0);
});

test('failed in-flight OAuth exchange is not cached and allows immediate retry', async () => {
    let attempt = 0;
    const { oauthRequest } = createFakeOAuthRequest(({ reply }) => {
        attempt += 1;
        if (attempt === 1) {
            reply(500, 'Internal Server Error', { 'content-type': 'text/plain' });
            return;
        }
        reply(200, { access_token: 'ya29.recovered-token', expires_in: 300 });
    });
    const client = createVertexOAuthClient({ oauthRequest });
    const serialized = JSON.stringify(makeServiceAccount());

    await assert.rejects(
        client.authenticateServiceAccount({ userRoot: '/users/alice', serialized }),
        { status: 500, code: 'VERTEX_OAUTH_UPSTREAM_ERROR' },
    );
    assert.equal(client.cacheSize, 0);

    const recovered = await client.authenticateServiceAccount({ userRoot: '/users/alice', serialized });
    assert.equal(recovered.accessToken, 'ya29.recovered-token');
    // expires_in <= 300s has zero TTL after the 5-minute safety margin, so it is not retained.
    assert.equal(client.cacheSize, 0);
});
