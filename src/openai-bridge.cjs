/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { randomBytes, createHash } = require('node:crypto');
const https = require('node:https');
const { Transform } = require('node:stream');
const { MAX_CAPTURE_BYTES } = require('./bridge-log-store.cjs');
const { PluginError, sendExpressError } = require('./errors.cjs');
const { discoverModels, validatedTarget } = require('./openai-models.cjs');

const MAX_BODY = 16 * 1024 * 1024;
const FORBIDDEN = /^(?:reverse_proxy|custom_url|proxy_password|apiKey|chat_completion_source|secret_id|secretId|authorization|headers|url|base_url)$/iu;
const PASS_HEADERS = ['content-type', 'content-encoding', 'retry-after', 'x-request-id'];
const modelPattern = /^(?:google\/)?gemini-[a-z0-9][a-z0-9._-]*$/u;

function localOrigin(value) {
    // Require a serialized origin: URL parsing alone normalizes spoofed paths.
    if (typeof value !== 'string' || !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(value)) return false;
    try { new URL(value); return true; } catch { return false; }
}
function cors(response, origin, preflight = false) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', preflight ? 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network' : 'Origin');
}

function error(response, status, code, message) {
    if (response.headersSent || response.writableEnded) return response.destroy();
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: { message, type: status < 500 ? 'invalid_request_error' : 'server_error', code } }));
}

function rejectEarly(request, response, status, code, message) {
    response.shouldKeepAlive = false;
    response.setHeader('Connection', 'close');
    error(response, status, code, message);
    request.resume();
}

function validateConnection(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginError(400, 'INVALID_CONNECTION', 'A Google connection is required.');
    if (Object.keys(value).some(key => !['source', 'model', 'authMode', 'region', 'secretId'].includes(key))) throw new PluginError(400, 'INVALID_CONNECTION', 'The connection has unsupported fields.');
    const { source, model, authMode, region, secretId } = value;
    if (!['makersuite', 'vertexai'].includes(source) || typeof model !== 'string' || !modelPattern.test(model)) throw new PluginError(400, 'INVALID_CONNECTION', 'The connection source or model is invalid.');
    if (secretId !== undefined && (typeof secretId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(secretId))) throw new PluginError(400, 'INVALID_CONNECTION', 'The secret ID is invalid.');
    if (source === 'vertexai') {
        if (authMode !== 'full' || typeof region !== 'string' || !/^(?:global|[a-z0-9][a-z0-9-]{0,62})$/u.test(region)) throw new PluginError(400, 'INVALID_CONNECTION', 'Vertex AI requires full authentication and a valid region.');
    } else if (authMode !== undefined || region !== undefined) throw new PluginError(400, 'INVALID_CONNECTION', 'AI Studio does not accept Vertex fields.');
    return Object.freeze({ source, model, ...(source === 'vertexai' ? { authMode, region } : {}), ...(secretId ? { secretId } : {}) });
}

function credentialValues(snapshot) {
    if (typeof snapshot !== 'string') return [];
    const values = [snapshot];
    try {
        const parsed = JSON.parse(snapshot);
        if (typeof parsed?.private_key === 'string') {
            values.push(parsed.private_key, JSON.stringify(parsed.private_key).slice(1, -1));
        }
    } catch { /* AI Studio keys are plain strings. */ }
    return values;
}

function userId(request) {
    const root = request?.user?.directories?.root;
    if (typeof root !== 'string' || !root) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated user is required.');
    return createHash('sha256').update(root).digest('hex');
}

function createOpenAIBridge({ stRuntime, upstreamRequest = https.request, maxBodyBytes = MAX_BODY, timeoutMs = 180_000, maxGlobal = 16, maxPerUser = 4, bridgeLogStore } = {}) {
    const states = new Map();
    const keys = new Map();
    const active = new Set();
    const revisions = new Map();
    let closed = false;
    let baseUrl = null;

    function view(state) {
        return { ok: true, enabled: Boolean(state), debugLocalAccess: Boolean(state?.debugLocalAccess), baseUrl: state ? `${baseUrl}/openai/v1` : null, apiKey: state?.key ?? null, model: 'st-current', connection: state?.connection ?? null };
    }
    function revoke(state) {
        if (!state) return;
        keys.delete(state.key);
        for (const operation of [...active]) if (operation.state === state) operation.cancel();
    }
    function route(request, response) {
        if (!request.url?.startsWith('/openai/')) return false;
        response.setHeader('Cache-Control', 'no-store');
        response.shouldKeepAlive = false;
        response.setHeader('Connection', 'close');
        if (closed) { rejectEarly(request, response, 503, 'BRIDGE_CLOSED', 'The bridge is closed.'); return true; }
        const path = request.url.split('?')[0];
        const keyMatch = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(request.headers.authorization || '');
        const logState = keyMatch && keys.get(keyMatch[1]);
        let entry; let earlyBodyListener; let logged = false; const secrets = logState ? [logState.key, ...(logState.logSecrets || [])] : [];
        const captures = new Map();
        const capture = (field, chunk, encoding) => {
            if (!entry || chunk === undefined || chunk === null) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
            const current = captures.get(field) || { chunks: [], size: 0 };
            const remaining = MAX_CAPTURE_BYTES - current.size;
            if (bytes.length > remaining) entry.truncated = true;
            if (remaining > 0) { const part = Buffer.from(bytes.subarray(0, remaining)); current.chunks.push(part); current.size += part.length; }
            captures.set(field, current);
        };
        if (bridgeLogStore && logState) {
            entry = { id: randomBytes(16).toString('hex'), timestamp: new Date().toISOString(), method: request.method, path: request.url, status: null, durationMs: 0, requestBody: '', forwardedBody: '', responseBody: '', error: null, truncated: false, interrupted: false };
            const started = Date.now();
            const write = response.write; const end = response.end;
            response.write = function(chunk, encoding, callback) { capture('responseBody', chunk, encoding); return write.call(this, chunk, encoding, callback); };
            response.end = function(chunk, encoding, callback) { capture('responseBody', chunk, encoding); return end.call(this, chunk, encoding, callback); };
            const flush = () => {
                if (logged) return; logged = true;
                if (earlyBodyListener) {
                    request.removeListener('data', earlyBodyListener);
                    entry.requestIncomplete = !request.readableEnded;
                }
                entry.status ??= response.headersSent ? response.statusCode : null;
                entry.durationMs = Date.now() - started; entry.interrupted ||= !response.writableFinished;
                for (const [field, value] of captures) entry[field] = Buffer.concat(value.chunks).toString('utf8');
                Promise.resolve().then(() => bridgeLogStore.append(logState.directories, entry, secrets)).catch(() => {});
            };
            response.once('finish', () => setImmediate(flush)); response.once('close', () => setImmediate(flush));
        }
        const early = (status, code, message) => {
            if (entry) {
                entry.status = status; entry.error = `${code}: ${message}`;
                earlyBodyListener = chunk => capture('requestBody', chunk);
                request.on('data', earlyBodyListener);
            }
            rejectEarly(request, response, status, code, message);
        };
        if (!['/openai/v1/models', '/openai/v1/chat/completions'].includes(path) || request.url.includes('?')) { early(404, 'NOT_FOUND', 'The endpoint was not found.'); return true; }
        const origin = request.headers.origin;
        if (request.method === 'OPTIONS') {
            const method = request.headers['access-control-request-method'];
            const headers = request.headers['access-control-request-headers'];
            const headerNames = headers === undefined ? [] : String(headers).split(',').map(name => name.trim());
            if (!localOrigin(origin) || ![...states.values()].some(item => item.debugLocalAccess) || method !== (path.endsWith('/models') ? 'GET' : 'POST') || headerNames.some(name => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) || (request.headers['access-control-request-private-network'] !== undefined && request.headers['access-control-request-private-network'] !== 'true')) {
                early(403, 'ORIGIN_NOT_ALLOWED', 'Local browser access is disabled or the preflight is invalid.'); return true;
            }
            cors(response, origin, true);
            response.setHeader('Access-Control-Allow-Methods', method);
            if (headerNames.length) response.setHeader('Access-Control-Allow-Headers', [...new Set(headerNames.map(name => name.toLowerCase()))].join(', '));
            response.setHeader('Access-Control-Max-Age', '0');
            if (request.headers['access-control-request-private-network'] === 'true') response.setHeader('Access-Control-Allow-Private-Network', 'true');
            response.writeHead(204); response.end(); return true;
        }
        const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(request.headers.authorization || '');
        const state = match && keys.get(match[1]);
        if (!state) { early(401, 'INVALID_API_KEY', 'The bridge API key is invalid.'); return true; }
        if (origin !== undefined) {
            if (!state.debugLocalAccess || !localOrigin(origin)) { early(403, 'ORIGIN_NOT_ALLOWED', 'Local browser access is disabled or the origin is invalid.'); return true; }
            cors(response, origin);
        }
        const modelsRequest = path.endsWith('/models');
        const method = modelsRequest ? 'GET' : 'POST';
        if (request.method !== method) { early(405, 'METHOD_NOT_ALLOWED', `${method} is required.`); return true; }
        if (!modelsRequest && !/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] || '')) { early(415, 'JSON_REQUIRED', 'A JSON body is required.'); return true; }
        if (Number(request.headers['content-length']) > maxBodyBytes) { early(413, 'REQUEST_BODY_TOO_LARGE', 'The request body is too large.'); return true; }
        if (active.size >= maxGlobal || [...active].filter(item => item.state === state).length >= maxPerUser) { early(429, 'BRIDGE_BUSY', 'The bridge concurrency limit was reached.'); return true; }
        const operation = { state, terminal: false, upstream: null, timer: null, rejectBody: null, cleanupBody: null };
        active.add(operation);
        const done = () => {
            if (operation.terminal) return false;
            operation.terminal = true;
            clearTimeout(operation.timer);
            operation.cleanupBody?.();
            active.delete(operation);
            return true;
        };
        const cancel = () => {
            if (entry) { entry.interrupted = true; entry.error ||= 'BRIDGE_CANCELLED: The request was interrupted.'; }
            const rejectBody = operation.rejectBody;
            if (!done()) return;
            rejectBody?.(new Error('Cancelled'));
            operation.upstream?.destroy();
            response.destroy();
        };
        const fail = (status, code, message) => {
            if (entry && !operation.terminal) { entry.status = status; entry.error = `${code}: ${message}`; }
            const rejectBody = operation.rejectBody;
            if (!done()) return;
            rejectBody?.(new Error('Terminated'));
            operation.upstream?.destroy();
            response.shouldKeepAlive = false;
            error(response, status, code, message);
            request.resume();
        };
        operation.cancel = cancel;
        operation.timer = setTimeout(() => fail(504, 'GOOGLE_TIMEOUT', 'The bridge request timed out.'), timeoutMs);
        response.once('close', () => { if (!response.writableEnded) cancel(); else { done(); operation.upstream?.destroy(); } });
        request.once('aborted', cancel);
        (async () => {
            try {
                if (modelsRequest) {
                    const config = await stRuntime.getOpenAIConfig({ user: { directories: state.directories } }, state.connection, true, state.credentialSnapshot);
                    secrets.push(config.headers?.Authorization, config.headers?.Authorization?.replace(/^Bearer /u, ''));
                    if (operation.terminal || keys.get(state.key) !== state) return;
                    // Tap discovery pages through a Transform so collection preserves upstream backpressure.
                    let discoveryPage = 0;
                    const discoveryRequest = (target, options, callback) => upstreamRequest(target, options, source => {
                        if (discoveryPage++) capture('upstreamResponseBody', `\n--- Google model page ${discoveryPage} ---\n`);
                        const tap = new Transform({ transform(chunk, encoding, next) { capture('upstreamResponseBody', chunk); next(null, chunk); } });
                        tap.statusCode = source.statusCode; tap.headers = source.headers;
                        source.once('error', cause => tap.destroy(cause));
                        source.once('aborted', () => tap.destroy(new Error('Google response aborted')));
                        source.once('close', () => { if (!source.readableEnded) tap.destroy(new Error('Google response closed early')); });
                        tap.once('close', () => source.destroy());
                        callback(tap); source.pipe(tap);
                    });
                    const catalog = await discoverModels({ config, connection: state.connection, upstreamRequest: entry ? discoveryRequest : upstreamRequest, operation });
                    if (operation.terminal || !catalog) return;
                    done(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(catalog)); return;
                }
                const chunks = []; let bytes = 0;
                await new Promise((resolve, reject) => {
                    const cleanup = () => {
                        request.removeListener('data', onData);
                        request.removeListener('end', onEnd);
                        request.removeListener('error', onError);
                        operation.cleanupBody = null;
                        operation.rejectBody = null;
                    };
                    const onData = chunk => {
                        capture('requestBody', chunk);
                        bytes += chunk.length;
                        if (bytes > maxBodyBytes) { cleanup(); reject(new PluginError(413, 'REQUEST_BODY_TOO_LARGE', 'The request body is too large.')); return; }
                        chunks.push(chunk);
                    };
                    const onEnd = () => { cleanup(); resolve(); };
                    const onError = cause => { cleanup(); reject(cause); };
                    operation.cleanupBody = cleanup;
                    operation.rejectBody = reject;
                    request.on('data', onData);
                    request.once('end', onEnd);
                    request.once('error', onError);
                });
                if (operation.terminal) return;
                let payload;
                try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PluginError(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
                if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.some(message => !message || typeof message !== 'object' || typeof message.role !== 'string')) throw new PluginError(400, 'INVALID_MESSAGES', 'A nonempty messages array is required.');
                if (Object.keys(payload).some(key => FORBIDDEN.test(key))) throw new PluginError(400, 'FORBIDDEN_FIELD', 'The request contains an internal routing or credential field.');
                const model = payload.model ?? 'st-current';
                if (model !== 'st-current' && (typeof model !== 'string' || !modelPattern.test(model))) throw new PluginError(400, 'INVALID_MODEL', 'The model is invalid.');
                payload.model = model === 'st-current' ? state.connection.model : model;
                if (state.connection.source === 'vertexai' && !payload.model.startsWith('google/')) payload.model = `google/${payload.model}`;
                if (state.connection.source === 'makersuite' && payload.model.startsWith('google/')) payload.model = payload.model.slice(7);
                const config = await stRuntime.getOpenAIConfig({ user: { directories: state.directories } }, state.connection, true, state.credentialSnapshot);
                secrets.push(config.headers?.Authorization, config.headers?.Authorization?.replace(/^Bearer /u, ''));
                if (operation.terminal || keys.get(state.key) !== state || response.writableEnded) return;
                const target = validatedTarget(config, state.connection);
                const body = Buffer.from(JSON.stringify(payload));
                capture('forwardedBody', body);
                const upstream = upstreamRequest(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Accept-Encoding': 'identity', Authorization: config.headers.Authorization } }, upstreamResponse => {
                    if (operation.terminal || response.writableEnded || response.destroyed) { upstreamResponse.destroy(); return; }
                    const status = upstreamResponse.statusCode || 502;
                    if (entry) { entry.status = status; if (status >= 400) entry.error = `GOOGLE_HTTP_ERROR: HTTP ${status}`; }
                    if (status >= 300 && status < 400) { upstreamResponse.destroy(); fail(502, 'GOOGLE_REDIRECT_REJECTED', 'Google returned a redirect.'); return; }
                    const headers = { 'Cache-Control': 'no-store' };
                    for (const name of PASS_HEADERS) if (upstreamResponse.headers?.[name]) headers[name] = upstreamResponse.headers[name];
                    response.writeHead(status, headers);
                    upstreamResponse.once('error', () => { if (entry) entry.error = 'GOOGLE_UPSTREAM_FAILED: The Google response was interrupted.'; response.destroy(); });
                    upstreamResponse.pipe(response);
                });
                operation.upstream = upstream;
                upstream.once('error', () => fail(502, 'GOOGLE_UPSTREAM_FAILED', 'The Google connection failed.'));
                upstream.end(body);
            } catch (cause) {
                if (cause.retryAfter && !response.headersSent && !operation.terminal) response.setHeader('Retry-After', cause.retryAfter);
                fail(cause.status || 500, cause.code || 'BRIDGE_FAILED', cause.status ? cause.message : 'The bridge request failed.');
            }
        })();
        return true;
    }
    return {
        setBaseUrl(value) { baseUrl = value; },
        route,
        get(request, response) { try { response.set?.('Cache-Control', 'no-store'); return response.json(view(states.get(userId(request)))); } catch (cause) { return sendExpressError(response, cause); } },
        async getLogs(request, response) {
            try { userId(request); response.set?.('Cache-Control', 'no-store'); if (!bridgeLogStore) throw new PluginError(503, 'BRIDGE_LOGS_UNAVAILABLE', 'Bridge logs are unavailable.'); return response.json({ ok: true, entries: await bridgeLogStore.read(request.user.directories) }); } catch (cause) { return sendExpressError(response, cause); }
        },
        async clearLogs(request, response) {
            try { userId(request); response.set?.('Cache-Control', 'no-store'); if (!bridgeLogStore) throw new PluginError(503, 'BRIDGE_LOGS_UNAVAILABLE', 'Bridge logs are unavailable.'); await bridgeLogStore.clear(request.user.directories); return response.json({ ok: true, entries: [] }); } catch (cause) { return sendExpressError(response, cause); }
        },
        async update(request, response) {
            try {
                response.set?.('Cache-Control', 'no-store');
                const id = userId(request);
                const revision = (revisions.get(id) || 0) + 1;
                revisions.set(id, revision);
                const body = request.body;
                if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => !['enabled', 'connection', 'rotateKey', 'debugLocalAccess'].includes(key)) || (body.rotateKey !== undefined && typeof body.rotateKey !== 'boolean') || (body.debugLocalAccess !== undefined && typeof body.debugLocalAccess !== 'boolean')) throw new PluginError(400, 'INVALID_BRIDGE_CONFIG', 'The bridge configuration is invalid.');
                const previous = states.get(id);
                if (!body.enabled) { revoke(previous); states.delete(id); return response.json(view(null)); }
                if (!baseUrl) throw new PluginError(503, 'BRIDGE_LISTENER_UNAVAILABLE', 'The bridge listener is unavailable. Check whether its fixed port is occupied and verify the listener configuration.');
                let connection = body.connection === undefined ? previous?.connection : validateConnection(body.connection);
                if (!connection) throw new PluginError(400, 'INVALID_CONNECTION', 'A Google connection is required.');
                const directories = { ...request.user.directories };
                const resolved = body.connection === undefined && previous
                    ? { connection, credentialSnapshot: previous.credentialSnapshot }
                    : stRuntime.resolveOpenAIConnection({ user: { directories } }, connection);
                connection = resolved.connection;
                const checkedConfig = await stRuntime.getOpenAIConfig({ user: { directories } }, connection, false, resolved.credentialSnapshot);
                if (closed || revisions.get(id) !== revision) throw new PluginError(409, 'BRIDGE_UPDATE_SUPERSEDED', 'A newer bridge update replaced this request.');
                const key = previous && !body.rotateKey ? previous.key : randomBytes(32).toString('base64url');
                if (previous) revoke(previous);
                const state = { key, connection, directories, logSecrets: [...credentialValues(resolved.credentialSnapshot), checkedConfig?.headers?.Authorization, checkedConfig?.headers?.Authorization?.replace(/^Bearer /u, '')], credentialSnapshot: resolved.credentialSnapshot, debugLocalAccess: body.debugLocalAccess ?? previous?.debugLocalAccess ?? false };
                states.set(id, state); keys.set(key, state);
                response.set?.('Cache-Control', 'no-store');
                return response.json(view(state));
            } catch (cause) { return sendExpressError(response, cause); }
        },
        close() { closed = true; for (const state of states.values()) revoke(state); states.clear(); keys.clear(); },
    };
}

module.exports = { createOpenAIBridge, validateConnection };
