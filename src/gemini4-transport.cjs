'use strict';

const { StringDecoder } = require('node:string_decoder');
const { PluginError } = require('./errors.cjs');
const { sanitizeUsage } = require('./usage-capture.cjs');
const { validatePreparedGoogleTarget } = require('./target-policy.cjs');

const isGemini4Argon = model => /^gemini-4-argon(?:-cyber-permissive)?$/u.test(model);
const protocolError = (code, message) => new PluginError(502, code, message);
function addUsage(total, usage) {
    const result = { ...(total || {}) };
    for (const [key, value] of Object.entries(sanitizeUsage(usage) || {})) {
        if (typeof value === 'number') result[key] = (result[key] || 0) + value;
        else if (Array.isArray(value)) {
            const items = new Map((result[key] || []).map(item => [item.modality, { ...item }]));
            for (const item of value) {
                const old = items.get(item.modality) || { modality: item.modality, tokenCount: 0 };
                old.tokenCount += item.tokenCount || 0;
                items.set(item.modality, old);
            }
            result[key] = [...items.values()];
        } else result[key] = value;
    }
    return Object.keys(result).length ? result : null;
}
async function write(response, data) {
    if (response.destroyed) throw protocolError('CLIENT_DISCONNECTED', 'The client disconnected.');
    if (!response.write(data)) await new Promise((resolve, reject) => {
        const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
        const drained = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(protocolError('CLIENT_DISCONNECTED', 'The client disconnected.')); };
        const failed = error => { cleanup(); reject(error); };
        response.once('drain', drained); response.once('close', closed); response.once('error', failed);
    });
}
async function runGemini4Transport({ request, response, ticketData, target, upstreamRequest,
    maxBodyBytes, upstreamTimeoutMs, onUsage = () => {}, maxHops = 32 }) {
    let active;
    let activeIncoming;
    let gone = false;
    let usage = null;
    const abort = () => { gone = true; activeIncoming?.destroy(); active?.destroy(protocolError('CLIENT_DISCONNECTED', 'The client disconnected.')); };
    const close = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort);
    response.once('close', close);
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > maxBodyBytes) throw new PluginError(413, 'REQUEST_BODY_TOO_LARGE', 'The proxied Google request body is too large.');
            chunks.push(chunk);
        }
        let original;
        try { original = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PluginError(400, 'INVALID_GOOGLE_BODY', 'The Google request must be a JSON object.'); }
        if (!original || typeof original !== 'object' || Array.isArray(original)) throw new PluginError(400, 'INVALID_GOOGLE_BODY', 'The Google request must be a JSON object.');
        const config = { ...(original.generationConfig || {}) };
        for (const key of ['temperature', 'topP', 'topK', 'candidateCount', 'presencePenalty', 'frequencyPenalty']) delete config[key];
        original.generationConfig = config;
        if (ticketData.source === 'makersuite' && ticketData.tier === 'flex') { delete original.serviceTier; original.service_tier = 'flex'; }
        const budget = config.maxOutputTokens;
        const bounded = Number.isSafeInteger(budget) && budget > 0;
        let spent = 0;
        let token;
        const seen = new Set();
        const parts = [];
        let finalValue;
        let retainedBytes = 0;
        const upstreamTarget = new URL(target);
        if (ticketData.source !== 'makersuite') upstreamTarget.pathname = upstreamTarget.pathname.replace(/^\/v1\//u, '/v1beta1/');
        validatePreparedGoogleTarget(upstreamTarget.toString(), ticketData);
        for (let hop = 0; hop < maxHops; hop++) {
            if (gone) throw protocolError('CLIENT_DISCONNECTED', 'The client disconnected.');
            const body = { ...original, generationConfig: { ...config } };
            if (token) body.continuationToken = token;
            const bytes = Buffer.from(JSON.stringify(body));
            const upstreamResponse = await new Promise((resolve, reject) => {
                const headers = Object.fromEntries(Object.entries(ticketData.headers).filter(([name]) => !['content-length', 'accept-encoding'].includes(name.toLowerCase())));
                headers['Content-Length'] = bytes.length;
                active = upstreamRequest(upstreamTarget, { method: 'POST', headers }, resolve);
                active.once('error', reject);
                active.setTimeout?.(upstreamTimeoutMs, () => active.destroy(new PluginError(504, 'VERTEX_UPSTREAM_TIMEOUT', 'The Google upstream request timed out.')));
                active.end(bytes);
            });
            activeIncoming = upstreamResponse;
            if (gone) { upstreamResponse.destroy(); throw protocolError('CLIENT_DISCONNECTED', 'The client disconnected.'); }
            const status = upstreamResponse.statusCode || 502;
            if (status >= 300) { upstreamResponse.destroy(); throw protocolError('GEMINI4_UPSTREAM_HTTP_ERROR', `The Google upstream returned HTTP ${status}.`); }
            const encoding = upstreamResponse.headers?.['content-encoding'];
            if (encoding && encoding !== 'identity') { upstreamResponse.destroy(); throw protocolError('GEMINI4_COMPRESSED_RESPONSE', 'The Google upstream returned unsupported compressed data.'); }
            let latestUsage;
            let latestToken;
            let reason;
            let lastCandidate;
            const accept = async value => {
                if (!value || typeof value !== 'object' || value.error) throw protocolError('GEMINI4_UPSTREAM_ERROR', 'The Google upstream returned an error.');
                if (value.usageMetadata) { latestUsage = value.usageMetadata; onUsage(addUsage(usage, latestUsage), false); }
                if (typeof value.continuationToken === 'string') latestToken = value.continuationToken;
                const candidate = value.candidates?.[0];
                if (candidate) {
                    lastCandidate = { ...(lastCandidate || {}), ...candidate, content: { ...(lastCandidate?.content || {}), ...(candidate.content || {}) } };
                    if (typeof candidate.continuationToken === 'string') latestToken = candidate.continuationToken;
                }
                if (candidate?.finishReason) reason = candidate.finishReason;
                finalValue = value;
                for (const part of candidate?.content?.parts || []) {
                    if (!ticketData.stream) {
                        retainedBytes += Buffer.byteLength(JSON.stringify(part));
                        if (retainedBytes > maxBodyBytes) throw protocolError('GEMINI4_RESPONSE_TOO_LARGE', 'The Google response exceeded the transport limit.');
                        parts.push(part);
                    }
                    else {
                        if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
                        const output = { ...value, candidates: [{ ...candidate, content: { ...candidate.content, parts: [part] } }] };
                        delete output.usageMetadata; delete output.continuationToken; delete output.candidates[0].finishReason; delete output.candidates[0].continuationToken;
                        await write(response, `data: ${JSON.stringify(output)}\n\n`);
                    }
                }
            };
            const decoder = new StringDecoder('utf8');
            let buffer = '';
            for await (const chunk of upstreamResponse) {
                if (gone) { upstreamResponse.destroy(); throw protocolError('CLIENT_DISCONNECTED', 'The client disconnected.'); }
                buffer += decoder.write(chunk);
                if (Buffer.byteLength(buffer) > maxBodyBytes) throw protocolError('GEMINI4_RESPONSE_TOO_LARGE', 'The Google response exceeded the transport limit.');
                if (ticketData.stream) {
                    for (;;) {
                        const match = /\r?\n\r?\n/u.exec(buffer);
                        if (!match) break;
                        const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
                        const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                        if (data && data !== '[DONE]') await accept(JSON.parse(data));
                    }
                }
            }
            buffer += decoder.end();
            if (!ticketData.stream) await accept(JSON.parse(buffer));
            else if (buffer.trim()) {
                const data = buffer.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (data && data !== '[DONE]') await accept(JSON.parse(data));
            }
            if (ticketData.stream && !reason && !finalValue?.promptFeedback?.blockReason) {
                throw protocolError('GEMINI4_INCOMPLETE_RESPONSE', 'The Google stream ended without a terminal finish reason.');
            }
            usage = addUsage(usage, latestUsage);
            onUsage(usage, false);
            const hopCount = latestUsage?.candidatesTokenCount ?? (latestUsage?.thoughtsTokenCount > 0 ? 0 : undefined);
            const thoughtCount = latestUsage?.thoughtsTokenCount || 0;
            const measurable = Number.isSafeInteger(hopCount) && hopCount >= 0 && Number.isSafeInteger(thoughtCount) && thoughtCount >= 0;
            if (measurable) spent += hopCount + thoughtCount;
            // MAX_TOKENS is a user cap, never permission to buy another output budget.
            if (reason === 'CONTINUATION') {
                if (!latestToken) throw protocolError('GEMINI4_CONTINUATION_TOKEN_MISSING', 'The Google continuation response did not include a token.');
                if (!bounded || !measurable) throw protocolError('GEMINI4_CONTINUATION_BUDGET_UNKNOWN', 'The Google continuation cannot proceed without an explicit output budget and output usage.');
                if (spent >= budget) reason = 'MAX_TOKENS';
                else {
                    if (seen.has(latestToken) || hop + 1 === maxHops) throw protocolError('GEMINI4_CONTINUATION_LIMIT', 'The Google continuation limit was reached.');
                    seen.add(latestToken); token = latestToken; continue;
                }
            }
            const result = { ...finalValue, usageMetadata: usage };
            delete result.continuationToken;
            if (latestToken) result.continuationToken = latestToken;
            if (lastCandidate) {
                result.candidates = [{ ...lastCandidate, ...(reason ? { finishReason: reason } : {}), content: { ...(lastCandidate.content || {}), role: 'model', parts: ticketData.stream ? [] : parts } }];
            }
            if (result.candidates?.[0]) {
                delete result.candidates[0].continuationToken;
                if (latestToken) result.candidates[0].continuationToken = latestToken;
            }
            if (!response.headersSent) response.writeHead(200, { 'Content-Type': ticketData.stream ? 'text/event-stream' : 'application/json', 'Cache-Control': 'no-store' });
            if (ticketData.stream) await write(response, `data: ${JSON.stringify(result)}\n\n`);
            else await write(response, JSON.stringify(result));
            onUsage(usage, true);
            response.end();
            return;
        }
    } finally {
        request.off('aborted', abort);
        response.off('close', close);
        activeIncoming?.destroy();
        active?.destroy();
    }
}
module.exports = { isGemini4Argon, addUsage, runGemini4Transport };
