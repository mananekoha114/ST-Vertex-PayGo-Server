/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const https = require('node:https');
const { Transform } = require('node:stream');
const { PluginError, sendNodeError } = require('./errors.cjs');
const { describeError } = require('./log-store.cjs');
const { validatePreparedGoogleTarget } = require('./target-policy.cjs');

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

class ByteLimitTransform extends Transform {
    constructor(limit) {
        super();
        this.limit = limit;
        this.total = 0;
    }

    _transform(chunk, encoding, callback) {
        this.total += chunk.length;
        if (this.total > this.limit) {
            callback(new PluginError(413, 'REQUEST_BODY_TOO_LARGE', 'The proxied Vertex AI request body is too large.'));
            return;
        }
        callback(null, chunk);
    }
}

// Reuse the bounded request stream, buffering only AI Studio JSON because its
// service tier belongs in the body. Responses still stream without buffering.
class FlexBodyTransform extends ByteLimitTransform {
    constructor(limit) {
        super(limit);
        this.chunks = [];
    }

    _transform(chunk, encoding, callback) {
        super._transform(chunk, encoding, (error, data) => {
            if (error) return callback(error);
            this.chunks.push(data);
            callback();
        });
    }

    _flush(callback) {
        try {
            const body = JSON.parse(Buffer.concat(this.chunks).toString('utf8'));
            this.chunks = [];
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
            // Remove both spellings so an existing tier cannot override the ticket.
            delete body.serviceTier;
            body.service_tier = 'flex';
            callback(null, JSON.stringify(body));
        } catch {
            callback(new PluginError(400, 'INVALID_GOOGLE_BODY', 'The Google AI Studio request must be a JSON object.'));
        }
    }

    _destroy(error, callback) {
        this.chunks = [];
        callback(error);
    }
}

function getBearerSecret(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length <= 7) {
        throw new PluginError(401, 'INVALID_PROXY_SECRET', 'The proxy credential is invalid.');
    }
    return header.slice(7);
}

function parseProxyPath(requestUrl) {
    let parsed;
    try {
        parsed = new URL(requestUrl, 'http://127.0.0.1');
    } catch {
        throw new PluginError(404, 'INVALID_PROXY_PATH', 'The proxy path is invalid.');
    }

    const match = /^\/proxy\/([A-Za-z0-9_-]+)\/(v1\/publishers\/google|v1(?:beta|alpha)?)\/models\/([^/]+)$/u.exec(parsed.pathname);
    if (!match) {
        throw new PluginError(404, 'INVALID_PROXY_PATH', 'The proxy path is invalid.');
    }

    try {
        return {
            parsed, ticket: match[1], modelAction: decodeURIComponent(match[3]),
            source: match[2] === 'v1/publishers/google' ? 'vertexai' : 'makersuite',
        };
    } catch {
        throw new PluginError(404, 'INVALID_PROXY_PATH', 'The proxy path is invalid.');
    }
}

function validateSuffix(parsed, modelAction, ticketData) {
    if (modelAction !== `${ticketData.model}:${ticketData.endpoint}`) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', 'The proxy request does not match its ticket.');
    }
    const aiStudio = ticketData.source === 'makersuite';
    const expectedSuffix = aiStudio ? new URL(ticketData.targetUrl).pathname
        : `/v1/publishers/google/models/${ticketData.model}:${ticketData.endpoint}`;
    if (!parsed.pathname.endsWith(expectedSuffix)) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', 'The proxy provider or API version does not match its ticket.');
    }
    const keys = parsed.searchParams.getAll('key');
    if (keys.length > (aiStudio ? 1 : 0)) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', 'The proxy credential query does not match its ticket.');
    }
    const queryEntries = [...parsed.searchParams.entries()].filter(([name]) => !(aiStudio && name === 'key'));
    if (ticketData.stream) {
        if (queryEntries.length !== 1 || queryEntries[0][0] !== 'alt' || queryEntries[0][1] !== 'sse') {
            throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', 'The streaming proxy request does not match its ticket.');
        }
    } else if (queryEntries.length !== 0) {
        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', 'The proxy request does not match its ticket.');
    }
}

function copyUpstreamHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function createProxyHandler({
    ticketStore,
    logStore,
    upstreamRequest = https.request,
    maxBodyBytes = 500 * 1024 * 1024,
    upstreamTimeoutMs = 31 * 60_000,
} = {}) {
    return function proxyHandler(request, response) {
        const startedAt = Date.now();
        let upstream;
        let bodyStream;
        let logContext;
        let failureHandled = false;
        let clientGone = false;
        let terminalLogged = false;

        const makeLogContext = additional => ({
            ...(logContext || {}),
            durationMs: Date.now() - startedAt,
            ...(additional || {}),
        });
        const logTerminal = (level, event, additional = undefined) => {
            if (terminalLogged) return;
            terminalLogged = true;
            logStore?.server(level, event, makeLogContext(additional), {
                priority: logContext ? 'normal' : 'low',
            });
        };

        const fail = error => {
            if (failureHandled || clientGone) return;
            failureHandled = true;
            logTerminal('error', 'proxy_failed', describeError(error));
            upstream?.destroy();
            bodyStream?.destroy();
            sendNodeError(response, error);
        };

        // Until a ticket has been authenticated, this is browser-controlled
        // reject noise. Keep it in the bounded low-priority budget.
        logStore?.server('info', 'proxy_request_received', undefined, { priority: 'low' });
        try {
            if (request.method !== 'POST') {
                throw new PluginError(405, 'METHOD_NOT_ALLOWED', 'Only POST is accepted by the loopback proxy.');
            }
            const contentType = request.headers['content-type'];
            if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
                throw new PluginError(415, 'JSON_REQUIRED', 'The loopback proxy accepts JSON request bodies only.');
            }
            const declaredLength = Number(request.headers['content-length']);
            if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
                throw new PluginError(413, 'REQUEST_BODY_TOO_LARGE', 'The proxied Vertex AI request body is too large.');
            }

            const { parsed, ticket, modelAction, source } = parseProxyPath(request.url);
            // ST's native AI Studio serializer puts the disposable proxy secret
            // in ?key=. It never becomes the Google credential or upstream query.
            const proxySecret = source === 'makersuite'
                ? parsed.searchParams.get('key') || request.headers['x-goog-api-key'] || getBearerSecret(request.headers.authorization)
                : getBearerSecret(request.headers.authorization);
            const ticketData = ticketStore.consume(
                ticket,
                proxySecret,
                data => {
                    if (source !== (data.source || 'vertexai')) {
                        throw new PluginError(409, 'PROXY_REQUEST_MISMATCH', 'The proxy provider does not match its ticket.');
                    }
                    validateSuffix(parsed, modelAction, data);
                },
            );
            logContext = {
                model: ticketData.model,
                provider: ticketData.source || 'vertexai',
                tier: ticketData.tier,
                region: ticketData.region,
                stream: ticketData.stream,
            };

            // Revalidate the stored URL immediately before opening the socket. Tickets
            // only contain URLs produced by target-policy and cannot be client supplied.
            const target = validatePreparedGoogleTarget(ticketData.targetUrl, ticketData);

            upstream = upstreamRequest(target, {
                method: 'POST',
                headers: ticketData.headers,
                // node:https does not follow redirects and has no implicit fetch-style
                // response-header timeout, which is required for long Flex requests.
            }, upstreamResponse => {
                if (response.writableEnded) {
                    clientGone = true;
                    logTerminal('warn', 'proxy_client_disconnected');
                    upstreamResponse.destroy();
                    return;
                }
                const statusCode = upstreamResponse.statusCode || 502;
                if (statusCode >= 300 && statusCode < 400) {
                    // Relaying Location would let SillyTavern's outer node-fetch follow
                    // the redirect after it leaves this allowlisted transport.
                    upstreamResponse.destroy();
                    fail(new PluginError(502, 'VERTEX_REDIRECT_REJECTED', 'The Vertex AI upstream returned a redirect, which was not followed.'));
                    return;
                }
                const responseHeaders = copyUpstreamHeaders(upstreamResponse.headers);
                if (upstreamResponse.statusMessage) {
                    response.writeHead(statusCode, upstreamResponse.statusMessage, responseHeaders);
                } else {
                    response.writeHead(statusCode, responseHeaders);
                }
                logStore?.server(statusCode >= 400 ? 'warn' : 'info', 'proxy_upstream_response', makeLogContext({ statusCode }));
                upstreamResponse.on('error', error => {
                    failureHandled = true;
                    logTerminal('error', 'proxy_response_stream_failed', describeError(error));
                    response.destroy();
                });
                response.once('finish', () => {
                    logTerminal(statusCode >= 400 ? 'warn' : 'info', 'proxy_completed', { statusCode });
                });
                upstreamResponse.pipe(response);
            });
            logStore?.server('info', 'proxy_forward_started', makeLogContext());
            upstream.setTimeout?.(upstreamTimeoutMs, () => {
                fail(new PluginError(504, 'VERTEX_UPSTREAM_TIMEOUT', 'The Vertex AI upstream request timed out.'));
            });

            bodyStream = ticketData.source === 'makersuite'
                ? new FlexBodyTransform(maxBodyBytes) : new ByteLimitTransform(maxBodyBytes);
            bodyStream.on('error', fail);
            upstream.on('error', error => {
                fail(error instanceof PluginError
                    ? error
                    : new PluginError(502, 'VERTEX_UPSTREAM_FAILED', 'The Vertex AI upstream connection failed.', { cause: error }));
            });
            request.once('aborted', () => {
                if (clientGone) return;
                clientGone = true;
                logTerminal('warn', 'proxy_client_disconnected');
                upstream.destroy();
                bodyStream.destroy();
            });
            request.once('error', error => {
                fail(new PluginError(400, 'PROXY_REQUEST_STREAM_FAILED', 'The loopback request stream failed.', { cause: error }));
            });
            response.once('close', () => {
                if (!response.writableEnded) {
                    clientGone = true;
                    logTerminal('warn', 'proxy_client_disconnected');
                    upstream.destroy();
                    bodyStream.destroy();
                }
            });
            request.pipe(bodyStream).pipe(upstream);
        } catch (error) {
            fail(error);
        }
    };
}

module.exports = {
    ByteLimitTransform,
    copyUpstreamHeaders,
    createProxyHandler,
    parseProxyPath,
    validateSuffix,
};
