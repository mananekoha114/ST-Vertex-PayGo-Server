/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');
const { BoundedBuffer } = require('./bounded-buffer.cjs');
const MODEL = /^gemini-[a-z0-9][a-z0-9._-]*$/u;
function normalizeModel(value, source) {
    if (typeof value !== 'string') return null;
    const name = value.replace(/^(?:publishers\/google\/models\/|models\/|google\/)/u, '');
    if (!MODEL.test(name) || /(?:^|-)(?:embedding|live|native-audio|tts)(?:-|$)/u.test(name)) return null;
    return source === 'vertexai' ? `google/${name}` : name;
}
function validatedTarget(config, connection) {
    const target = new URL(config.target);
    const host = connection.region === 'global' ? 'aiplatform.googleapis.com' : `${connection.region}-aiplatform.googleapis.com`;
    if (target.protocol !== 'https:' || target.username || target.password || target.port || target.search || target.hash || (connection.source === 'makersuite' ? target.hostname !== 'generativelanguage.googleapis.com' || target.pathname !== '/v1beta/openai/chat/completions' : target.hostname !== host || !new RegExp(`^/v1/projects/[a-z][a-z0-9-]{4,62}/locations/${connection.region}/endpoints/openapi/chat/completions$`, 'u').test(target.pathname))) throw new PluginError(500, 'INVALID_GOOGLE_TARGET', 'The Google target is invalid.');
    return target;
}
async function discoverModels({ config, connection, upstreamRequest, operation }) {
    const target = validatedTarget(config, connection);
    target.pathname = connection.source === 'makersuite' ? '/v1beta/openai/models' : '/v1beta1/publishers/google/models';
    if (connection.source === 'vertexai') target.search = new URLSearchParams({ view: 'PUBLISHER_MODEL_VIEW_FULL', listAllVersions: 'true', pageSize: '100' }).toString();
    const ids = new Set(['st-current', normalizeModel(connection.model, connection.source)]);
    const tokens = new Set();
    let bytes = 0;
    for (let page = 0; page < 100; page++) {
        if (operation.terminal) return null;
        const data = await new Promise((resolve, reject) => {
            operation.rejectBody = reject;
            const upstream = upstreamRequest(target, { method: 'GET', headers: { Authorization: config.headers.Authorization, 'Accept-Encoding': 'identity', Accept: 'application/json' } }, response => {
                if (operation.terminal) { response.destroy(); return; }
                const status = response.statusCode || 502;
                if (status >= 300 && status < 400) { response.destroy(); reject(new PluginError(502, 'GOOGLE_MODEL_DISCOVERY_FAILED', 'Google model discovery returned a redirect.')); return; }
                const chunks = new BoundedBuffer(8 * 1024 * 1024 - bytes);
                response.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > 8 * 1024 * 1024) { response.destroy(); reject(new PluginError(502, 'GOOGLE_MODEL_RESPONSE_TOO_LARGE', 'Google model discovery exceeded the response limit.')); return; }
                    chunks.append(chunk);
                });
                response.once('error', () => reject(new PluginError(502, 'GOOGLE_UPSTREAM_FAILED', 'The Google connection failed.')));
                response.once('end', () => {
                    const body = chunks.toBuffer().toString('utf8');
                    let data;
                    try { data = JSON.parse(body); } catch { if (status >= 200 && status < 300) { reject(new PluginError(502, 'INVALID_GOOGLE_MODELS', 'Google returned an invalid model catalog.')); return; } }
                    if (status < 200 || status >= 300) {
                        let message = typeof data?.error?.message === 'string' ? data.error.message : 'Google model discovery failed.';
                        const credential = config.headers.Authorization.replace(/^Bearer /u, '');
                        if (credential) message = message.split(credential).join('[redacted]');
                        const cause = new PluginError(status, 'GOOGLE_MODEL_DISCOVERY_FAILED', message.slice(0, 2048));
                        const retry = response.headers?.['retry-after'];
                        if (typeof retry === 'string' && retry.length <= 128 && /^[\x20-\x7e]+$/u.test(retry)) cause.retryAfter = retry;
                        reject(cause); return;
                    }
                    resolve(data);
                });
            });
            operation.upstream = upstream;
            upstream.once('error', () => reject(new PluginError(502, 'GOOGLE_UPSTREAM_FAILED', 'The Google connection failed.')));
            upstream.end();
        });
        operation.rejectBody = null;
        if (operation.terminal) return null;
        const entries = connection.source === 'makersuite' ? data?.data : data?.publisherModels;
        if (!Array.isArray(entries)) throw new PluginError(502, 'INVALID_GOOGLE_MODELS', 'Google returned an invalid model catalog.');
        for (const entry of entries) { const id = normalizeModel(connection.source === 'makersuite' ? entry?.id : entry?.name, connection.source); if (id) ids.add(id); }
        const token = connection.source === 'vertexai' ? data.nextPageToken : undefined;
        if (token === undefined || token === null || token === '') return { object: 'list', data: [...ids].filter(Boolean).map(id => ({ id, object: 'model', owned_by: 'google' })) };
        if (typeof token !== 'string' || token.length > 16384 || tokens.has(token)) throw new PluginError(502, 'INVALID_GOOGLE_PAGINATION', 'Google returned invalid model pagination.');
        tokens.add(token); target.searchParams.set('pageToken', token);
    }
    throw new PluginError(502, 'GOOGLE_MODEL_PAGE_LIMIT', 'Google model discovery exceeded the page limit.');
}
module.exports = { discoverModels, validatedTarget, normalizeModel };
