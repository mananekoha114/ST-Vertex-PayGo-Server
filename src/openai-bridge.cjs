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
const { BoundedBuffer } = require('./bounded-buffer.cjs');
const { PluginError, sendExpressError } = require('./errors.cjs');
const { discoverModels, validatedTarget } = require('./openai-models.cjs');
const { buildPayGoHeaders } = require('./header-policy.cjs');
const { validateBridgePolicy, effectiveBridgeTier } = require('./bridge-tier.cjs');

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

function createOpenAIBridge({ stRuntime, upstreamRequest = https.request, maxBodyBytes = MAX_BODY, timeoutMs, maxGlobal = 16, maxPerUser = 4, bridgeLogStore } = {}) {
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
    async function policyView(state) {
        const result = view(state);
        if (state?.connection.source === 'vertexai') {
            Object.assign(result, { mode: state.mode, tierSource: state.tierSource, tier: state.tier, effectiveTier: null, tierError: null });
            try { result.effectiveTier = (await effectiveBridgeTier(state, stRuntime)).tier; } catch (cause) { result.tierError = cause.message; }
        }
        return result;
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
            const current = captures.get(field) || new BoundedBuffer(MAX_CAPTURE_BYTES);
            if (!current.append(bytes)) entry.truncated = true;
            captures.set(field, current);
        };
        if (bridgeLogStore && logState) {
            // A named credential can change while the bridge remains enabled. Refresh
            // only redaction material, including for requests rejected before OAuth.
            try {
                const current = stRuntime.resolveOpenAIConnection({ user: { directories: logState.directories } }, logState.connection);
                secrets.push(...credentialValues(current.logCredential));
            } catch { /* Credential resolution errors must not affect request logging. */ }
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
                for (const [field, value] of captures) entry[field] = value.toBuffer().toString('utf8');
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
        const ownerId = userId({ user: { directories: state.directories } });
        if (active.size >= maxGlobal || [...active].filter(item => item.ownerId === ownerId).length >= maxPerUser) { early(429, 'BRIDGE_BUSY', 'The bridge concurrency limit was reached.'); return true; }
        const operation = { state, ownerId, terminal: false, authPending: false, upstream: null, timer: null, rejectBody: null, cleanupBody: null };
        active.add(operation);
        const done = () => {
            if (operation.terminal) return false;
            operation.terminal = true;
            clearTimeout(operation.timer);
            operation.cleanupBody?.();
            if (!operation.authPending) active.delete(operation);
            return true;
        };
        const authenticate = async () => {
            // The host OAuth helper cannot be cancelled. Keep its lease until it
            // settles even when the client deadline or key revocation ends work.
            operation.authPending = true;
            try {
                return await stRuntime.getOpenAIConfig({ user: { directories: state.directories } }, state.connection, true, state.credentialSnapshot);
            } finally {
                operation.authPending = false;
                if (operation.terminal) active.delete(operation);
            }
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
        const startedAt = Date.now();
        const deadline = duration => { clearTimeout(operation.timer); operation.timer = setTimeout(() => fail(504, 'GOOGLE_TIMEOUT', 'The bridge request timed out.'), Math.max(1, duration - (Date.now() - startedAt))); };
        deadline(timeoutMs ?? 180_000);
        response.once('close', () => { if (!response.writableEnded) cancel(); else { done(); operation.upstream?.destroy(); } });
        request.once('aborted', cancel);
        (async () => {
            try {
                if (modelsRequest) {
                    const config = await authenticate();
                    secrets.push(...credentialValues(config.logCredential), config.headers?.Authorization, config.headers?.Authorization?.replace(/^Bearer /u, ''));
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
                const chunks = new BoundedBuffer(maxBodyBytes); let bytes = 0;
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
                        chunks.append(chunk);
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
                try { payload = JSON.parse(chunks.toBuffer().toString('utf8')); } catch { throw new PluginError(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
                if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.some(message => !message || typeof message !== 'object' || typeof message.role !== 'string')) throw new PluginError(400, 'INVALID_MESSAGES', 'A nonempty messages array is required.');
                if (Object.keys(payload).some(key => FORBIDDEN.test(key))) throw new PluginError(400, 'FORBIDDEN_FIELD', 'The request contains an internal routing or credential field.');
                if (state.connection.source === 'vertexai' && Object.keys(payload).some(key => /^(?:service_tier|serviceTier)$/iu.test(key))) throw new PluginError(400, 'FORBIDDEN_FIELD', 'The bridge tier is controlled by its server policy.');
                const model = payload.model ?? 'st-current';
                if (model !== 'st-current' && (typeof model !== 'string' || !modelPattern.test(model))) throw new PluginError(400, 'INVALID_MODEL', 'The model is invalid.');
                payload.model = model === 'st-current' ? state.connection.model : model;
                if (state.connection.source === 'vertexai' && !payload.model.startsWith('google/')) payload.model = `google/${payload.model}`;
                if (state.connection.source === 'makersuite' && payload.model.startsWith('google/')) payload.model = payload.model.slice(7);
                const tierPolicy = await effectiveBridgeTier(state, stRuntime);
                if (operation.terminal || keys.get(state.key) !== state) return;
                if (tierPolicy.tier === 'flex') deadline(timeoutMs ?? 1_800_000);
                const config = await authenticate();
                secrets.push(...credentialValues(config.logCredential), config.headers?.Authorization, config.headers?.Authorization?.replace(/^Bearer /u, ''));
                if (operation.terminal || keys.get(state.key) !== state || response.writableEnded) return;
                const target = validatedTarget(config, state.connection);
                const gateway = state.connection.source === 'vertexai' && state.mode === 'gemini';
                let forwarded = payload;
                if (gateway) {
                    const { toGeminiRequest } = require('./gemini-openai.cjs');
                    forwarded = toGeminiRequest(payload);
                    target.pathname = target.pathname.replace(/\/endpoints\/openapi\/chat\/completions$/u, `/publishers/google/models/${payload.model.replace(/^google\//u, '')}:${payload.stream === true ? 'streamGenerateContent' : 'generateContent'}`);
                    if (payload.stream === true) target.search = 'alt=sse';
                }
                const body = Buffer.from(JSON.stringify(forwarded));
                capture('forwardedBody', body);
                const policyHeaders = state.connection.source === 'vertexai' ? buildPayGoHeaders({ source: 'vertexai', ...tierPolicy }) : {};
                const upstream = upstreamRequest(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Accept-Encoding': 'identity', Authorization: config.headers.Authorization, ...policyHeaders } }, upstreamResponse => {
                    if (operation.terminal || response.writableEnded || response.destroyed) { upstreamResponse.destroy(); return; }
                    const status = upstreamResponse.statusCode || 502;
                    if (entry) { entry.status = status; if (status >= 400) entry.error = `GOOGLE_HTTP_ERROR: HTTP ${status}`; }
                    if (status >= 300 && status < 400) { upstreamResponse.destroy(); fail(502, 'GOOGLE_REDIRECT_REJECTED', 'Google returned a redirect.'); return; }
                    if (gateway) {
                        const tap = new Transform({ transform(chunk, _encoding, next) { capture('upstreamResponseBody', chunk); next(null, chunk); } });
                        const broken = () => { tap.destroy(); if (operation.terminal) return; if (entry) entry.error = 'GOOGLE_UPSTREAM_FAILED: The Google response was interrupted.'; response.destroy(); };
                        upstreamResponse.once('error', broken); upstreamResponse.once('aborted', broken);
                        upstreamResponse.once('close', () => { if (!upstreamResponse.readableEnded) broken(); });
                        tap.once('close', () => upstreamResponse.destroy());
                        if (status < 200 || status >= 300) {
                            const captured = new BoundedBuffer(1024 * 1024);
                            tap.on('data', chunk => { if (!captured.append(chunk)) { fail(status, 'GOOGLE_HTTP_ERROR', 'Google rejected the gateway request.'); } });
                            tap.once('end', () => {
                                if (operation.terminal) return;
                                let message = 'Google rejected the gateway request.';
                                try { const parsed = JSON.parse(captured.toBuffer().toString('utf8')); if (typeof parsed?.error?.message === 'string') message = parsed.error.message.slice(0, 2048); } catch {}
                                for (const secret of secrets) if (typeof secret === 'string' && secret) message = message.split(secret).join('[redacted]');
                                if (upstreamResponse.headers?.['retry-after']) response.setHeader('Retry-After', upstreamResponse.headers['retry-after']);
                                fail(status, 'GOOGLE_HTTP_ERROR', message);
                            });
                        } else {
                            const { createGeminiResponseTransform } = require('./gemini-openai.cjs');
                            const converted = createGeminiResponseTransform({ stream: payload.stream === true, model: payload.model, includeUsage: payload.stream_options?.include_usage === true });
                            converted.once('error', cause => { fail(cause.status || 502, cause.code || 'INVALID_GOOGLE_RESPONSE', 'Google returned an invalid gateway response.'); });
                            converted.once('close', () => tap.destroy());
                            // Delay sending headers until the converter produces its
                            // first valid chunk, so pre-output failures remain JSON errors.
                            response.statusCode = status;
                            response.setHeader('Cache-Control', 'no-store');
                            response.setHeader('Content-Type', payload.stream === true ? 'text/event-stream' : 'application/json');
                            tap.pipe(converted).pipe(response);
                        }
                        upstreamResponse.pipe(tap); return;
                    }
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
        get(request, response) { try { response.set?.('Cache-Control', 'no-store'); const state = states.get(userId(request)); return state?.connection.source === 'vertexai' ? policyView(state).then(value => response.json(value), cause => sendExpressError(response, cause)) : response.json(view(state)); } catch (cause) { return sendExpressError(response, cause); } },
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
                if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean' || Object.keys(body).some(key => !['enabled', 'connection', 'rotateKey', 'debugLocalAccess', 'mode', 'tierSource', 'tier'].includes(key)) || (body.rotateKey !== undefined && typeof body.rotateKey !== 'boolean') || (body.debugLocalAccess !== undefined && typeof body.debugLocalAccess !== 'boolean')) throw new PluginError(400, 'INVALID_BRIDGE_CONFIG', 'The bridge configuration is invalid.');
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
                const policy = validateBridgePolicy(body, previous, connection);
                const checkedConfig = await stRuntime.getOpenAIConfig({ user: { directories } }, connection, false, resolved.credentialSnapshot);
                if (closed || revisions.get(id) !== revision) throw new PluginError(409, 'BRIDGE_UPDATE_SUPERSEDED', 'A newer bridge update replaced this request.');
                const key = previous && !body.rotateKey ? previous.key : randomBytes(32).toString('base64url');
                if (previous) revoke(previous);
                const state = { key, connection, directories, logSecrets: [...credentialValues(resolved.logCredential), ...credentialValues(resolved.credentialSnapshot), ...credentialValues(checkedConfig?.logCredential), checkedConfig?.headers?.Authorization, checkedConfig?.headers?.Authorization?.replace(/^Bearer /u, '')], credentialSnapshot: resolved.credentialSnapshot, debugLocalAccess: body.debugLocalAccess ?? previous?.debugLocalAccess ?? false };
                Object.assign(state, policy);
                state.ownerHandle = typeof request.user?.profile?.handle === 'string' ? request.user.profile.handle : previous?.ownerHandle;
                states.set(id, state); keys.set(key, state);
                response.set?.('Cache-Control', 'no-store');
                return response.json(await policyView(state));
            } catch (cause) { return sendExpressError(response, cause); }
        },
        close() { closed = true; for (const state of states.values()) revoke(state); states.clear(); keys.clear(); },
    };
}

module.exports = { createOpenAIBridge, validateConnection };
