'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { PluginError, sendExpressError } = require('./errors.cjs');
const TOOL_PREFIX = 'st-vertex-paygo-tool:v1:';
function unpackToolSignature(value) {
    if (typeof value !== 'string' || !value.startsWith(TOOL_PREFIX)) return null;
    try {
        const data = JSON.parse(Buffer.from(value.slice(TOOL_PREFIX.length), 'base64url').toString());
        if (typeof data.id !== 'string' || data.id.length > 1024 || (data.signature !== undefined && typeof data.signature !== 'string')) return null;
        return data;
    } catch { return null; }
}
function wrapToolMetadata(data) {
    for (const candidate of data?.candidates ?? []) for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall && typeof part.functionCall.id === 'string') {
            part.thoughtSignature = TOOL_PREFIX + Buffer.from(JSON.stringify({ id: part.functionCall.id, ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) })).toString('base64url');
        }
    }
    return data;
}
const TEXT_PREFIX = 'st-vertex-paygo-text:v1:';
const MAX_TEXT_METADATA_BYTES = 32 * 1024 * 1024;
function unpackTextSignature(value) {
    if (typeof value !== 'string' || !value.startsWith(TEXT_PREFIX) || value.length > MAX_TEXT_METADATA_BYTES * 1.4) return null;
    try {
        const data = JSON.parse(Buffer.from(value.slice(TEXT_PREFIX.length), 'base64url').toString('utf8'));
        if (typeof data.text !== 'string' || !Array.isArray(data.parts) || data.parts.some(part => typeof part.text !== 'string' || (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string')) || data.parts.map(part => part.text).join('') !== data.text) return null;
        return data;
    } catch { return null; }
}
function collectTextParts(parts) {
    return (parts ?? []).filter(part => !part.thought && typeof part.text === 'string').map(part => ({ text: part.text, ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}) }));
}
function packTextSignature(parts) {
    if (!parts.length || !parts.some(part => part.thoughtSignature)) return undefined;
    const json = JSON.stringify({ parts, text: parts.map(part => part.text).join('') });
    if (Buffer.byteLength(json) > MAX_TEXT_METADATA_BYTES) return undefined;
    return TEXT_PREFIX + Buffer.from(json).toString('base64url');
}
async function buildNativeGeminiBody(input, runtime) {
    if (!/^gemini-4-argon(?:-cyber-permissive)?$/u.test(input.model ?? '')) throw new PluginError(400, 'NATIVE_GEMINI_MODEL_UNSUPPORTED', 'Native Gemini generation requires a Gemini 4 Argon model.');
    if (!['makersuite', 'vertexai'].includes(input.chat_completion_source)) throw new PluginError(400, 'NATIVE_GEMINI_SOURCE_UNSUPPORTED', 'Native Gemini generation requires a Google source.');
    if (!Array.isArray(input.messages) || !input.messages.length) throw new PluginError(400, 'INVALID_REQUEST', 'Messages are required.');
    if (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 1048576) throw new PluginError(400, 'INVALID_REQUEST', 'The output token limit must be between 1 and 1048576.');
    const helpers = await runtime.getNativeGeminiHelpers();
    let messages = structuredClone(input.messages);
    const calls = [], responses = [], signatures = new Map(), idMap = new Map();
    const marker = `STPG${randomUUID().replaceAll('-', '')}`;
    for (const message of messages) {
        if (message.role === 'assistant' && typeof message.signature === 'string' && message.signature) {
            const envelope = unpackTextSignature(message.signature);
            const envelopeLike = message.signature.startsWith(TEXT_PREFIX);
            const mark = (text, signature) => { const id = signatures.size; signatures.set(String(id), signature); return `${marker}S${id}S${text}${marker}E`; };
            const plainText = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : null;
            if (envelope && envelope.text === plainText) {
                const restored = envelope.parts.map(part => ({ type: 'text', text: mark(part.text, part.thoughtSignature) }));
                if (Array.isArray(message.content)) message.content = [...restored, ...message.content.filter(part => part.type !== 'text')];
                else message.content = restored;
            } else if (!envelopeLike) {
                if (typeof message.content === 'string') message.content = mark(message.content, message.signature);
                else if (Array.isArray(message.content)) for (const part of message.content) if (part.type === 'text' && typeof part.text === 'string') part.text = mark(part.text, message.signature);
            }
            delete message.signature;
        }
        for (const call of message.tool_calls ?? []) {
            const metadata = unpackToolSignature(call.signature);
            if (metadata) {
                idMap.set(call.id, metadata.id);
                call.signature = metadata.signature;
            }
            calls.push({ id: metadata?.id ?? call.id, signature: call.signature });
        }
        if (message.tool_call_id) responses.push(message.tool_call_id);
    }
    const names = { charName: String(input.char_name || ''), userName: String(input.user_name || ''), groupNames: Array.isArray(input.group_names) ? input.group_names.map(String) : [], startsWithGroupName(text) { return this.groupNames.some(name => text.startsWith(`${name}: `)); } };
    if (input.custom_prompt_post_processing) {
        if (typeof helpers.postProcessPrompt !== 'function') throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'The host prompt post-processor is unavailable.');
        messages = helpers.postProcessPrompt(messages, input.custom_prompt_post_processing, names);
    }
    const prompt = helpers.convertGooglePrompt(messages, input.model, Boolean(input.use_sysprompt), names);
    for (const content of prompt.contents) for (const part of content.parts ?? []) {
        if (part.functionCall) {
            const call = calls.shift();
            if (typeof call?.id === 'string') part.functionCall.id = call.id;
            if (call?.signature) part.thoughtSignature = call.signature;
            else delete part.thoughtSignature;
        }
        if (part.functionResponse) {
            const localId = responses.shift();
            if (typeof localId === 'string') part.functionResponse.id = idMap.get(localId) ?? localId;
        }
    }
    const signedText = new RegExp(`${marker}S(\\d+)S([\\s\\S]*?)${marker}E`, 'gu');
    for (const content of prompt.contents) content.parts = (content.parts ?? []).flatMap(part => {
        if (typeof part.text !== 'string' || !part.text.includes(marker)) return [part];
        const result = []; let offset = 0;
        for (const match of part.text.matchAll(signedText)) {
            if (match.index > offset) result.push({ text: part.text.slice(offset, match.index) });
            result.push({ text: match[2], ...(content.role === 'model' && signatures.get(match[1]) ? { thoughtSignature: signatures.get(match[1]) } : {}) });
            offset = match.index + match[0].length;
        }
        if (offset < part.text.length) result.push({ text: part.text.slice(offset) });
        return result;
    });
    if (input.continue_prefill || prompt.contents.at(-1)?.role === 'model') prompt.contents.push({ role: 'user', parts: [{ text: 'Continue the previous assistant response from where it stopped, without repeating previous content.' }] });
    const thinkingConfig = { includeThoughts: Boolean(input.include_reasoning) };
    const level = { min: 'LOW', minimal: 'LOW', low: 'LOW', medium: 'MEDIUM', high: 'HIGH', max: 'HIGH' }[String(input.reasoning_effort).toLowerCase()];
    if (level) thinkingConfig.thinkingLevel = level;
    const generationConfig = { maxOutputTokens: input.max_tokens, thinkingConfig };
    if (Array.isArray(input.stop) && input.stop.length) generationConfig.stopSequences = input.stop;
    if (input.seed !== undefined) generationConfig.seed = input.seed;
    if (input.responseMimeType || input.json_schema) generationConfig.responseMimeType = input.responseMimeType ?? 'application/json';
    if (input.responseSchema || input.json_schema?.value) generationConfig.responseSchema = input.responseSchema ?? input.json_schema.value;
    const body = { contents: prompt.contents, generationConfig, safetySettings: structuredClone([...helpers.GEMINI_SAFETY, ...((input.chat_completion_source) === 'vertexai' ? helpers.VERTEX_SAFETY : [])]) };
    if (input.use_sysprompt && prompt.system_instruction?.parts?.length) body.systemInstruction = prompt.system_instruction;
    const declarations = [], custom = [];
    for (const tool of structuredClone(input.tools ?? [])) {
        if (tool.type === 'function' && tool.function) {
            if (tool.function.parameters) { delete tool.function.parameters.$schema; if (tool.function.parameters.properties && !Object.keys(tool.function.parameters.properties).length) delete tool.function.parameters; }
            declarations.push(tool.function);
        } else if (tool[tool.type]) custom.push({ [tool.type]: tool[tool.type] });
    }
    if (declarations.length) body.tools = [{ function_declarations: declarations }];
    else if (custom.length) body.tools = custom;
    if (input.enable_web_search && !declarations.length) (body.tools ??= []).push({ google_search: {} });
    if (body.tools) {
        const mode = { none: 'NONE', required: 'ANY', auto: 'AUTO' }[input.tool_choice];
        const config = mode ? { mode } : input.tool_choice?.function?.name ? { mode: 'ANY', allowedFunctionNames: [input.tool_choice.function.name] } : null;
        if (config) body.toolConfig = { functionCallingConfig: config };
    }
    return body;
}
// Native HTTP has no implicit response-header deadline; Argon may think for many minutes.
function requestLoopback(url, { method, headers, body, signal, timeoutMs = 31 * 60 * 1000 }) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request(url, { method, headers, signal }, incoming => {
            incoming.once('error', reject);
            resolve({
                ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
                status: incoming.statusCode,
                get body() { return this._body ??= Readable.toWeb(incoming); },
                async json() {
                    const chunks = []; let size = 0;
                    for await (const chunk of incoming) {
                        size += chunk.length;
                        if (size > 512 * 1024 * 1024) { incoming.destroy(); throw new Error('Response too large'); }
                        chunks.push(chunk);
                    }
                    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
                },
            });
        });
        outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('Local generation timed out')));
        outgoing.once('error', reject);
        outgoing.end(body);
    });
}
function createNativeGeminiHandler({ runtime, loopbackTransport, fetchImpl = requestLoopback, upstreamTimeoutMs = 31 * 60 * 1000 }) {
    return async (request, response) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const close = () => { if (!response.writableEnded) abort(); };
        request.once('aborted', abort); response.once('close', close);
        try {
            if (!request.user?.directories?.root) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated user is required.');
            const input = request.body ?? {};
            const base = loopbackTransport.baseUrl;
            const prefix = `${base}/proxy/`;
            if (typeof base !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(base) || typeof input.reverse_proxy !== 'string' || !input.reverse_proxy.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/u.test(input.reverse_proxy.slice(prefix.length))) throw new PluginError(400, 'INVALID_PROXY_TARGET', 'The prepared local proxy target is invalid.');
            if (typeof input.proxy_password !== 'string' || !input.proxy_password || /[\r\n]/u.test(input.proxy_password)) throw new PluginError(400, 'INVALID_REQUEST', 'A prepared proxy credential is required.');
            const body = await buildNativeGeminiBody(input, runtime);
            const endpoint = input.stream ? 'streamGenerateContent' : 'generateContent';
            const source = input.chat_completion_source;
            const apiVersion = input.native_gemini_api_version ?? 'v1beta';
            if (!['v1', 'v1beta', 'v1alpha'].includes(apiVersion)) throw new PluginError(400, 'INVALID_REQUEST', 'The native Gemini API version is unsupported.');
            const suffix = source === 'vertexai' ? `/v1/publishers/google/models/${input.model}:${endpoint}` : `/${apiVersion}/models/${input.model}:${endpoint}`;
            const url = new URL(input.reverse_proxy + suffix);
            if (input.stream) url.searchParams.set('alt', 'sse');
            const headers = { 'Content-Type': 'application/json' };
            if (source === 'vertexai') headers.Authorization = `Bearer ${input.proxy_password}`;
            else url.searchParams.set('key', input.proxy_password);
            const upstream = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error', timeoutMs: upstreamTimeoutMs });
            if (!upstream.ok) { await upstream.body?.cancel().catch(() => {}); throw new PluginError(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, 'NATIVE_GEMINI_UPSTREAM_FAILED', 'Native Gemini generation failed.'); }
            response.setHeader('Cache-Control', 'no-store');
            if (input.stream) {
                response.setHeader('Content-Type', 'text/event-stream');
                let buffer = '';
                const maxEventCharacters = 32 * 1024 * 1024;
                const decoder = new TextDecoder();
                const textParts = [];
                const transformNativeFrame = frame => transformFrame(frame, textParts);
                const transform = new Transform({ transform(chunk, encoding, done) { buffer += decoder.decode(chunk, { stream: true }); const frames = buffer.split(/\r?\n\r?\n/u); buffer = frames.pop(); try { if (buffer.length > maxEventCharacters || frames.some(frame => frame.length > maxEventCharacters)) throw new Error('Stream event too large'); for (const frame of frames) this.push(transformNativeFrame(frame)); done(); } catch (error) { done(error); } }, flush(done) { try { buffer += decoder.decode(); if (buffer.length > maxEventCharacters) throw new Error('Stream event too large'); if (buffer) this.push(transformNativeFrame(buffer)); done(); } catch (error) { done(error); } } });
                await pipeline(Readable.fromWeb(upstream.body), transform, response, { signal: controller.signal });
            } else {
                const data = wrapToolMetadata(await upstream.json());
                const content = data.candidates?.[0]?.content;
                if (!Array.isArray(content?.parts) || !content.parts.length) { const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason; const safeReason = typeof reason === 'string' && /^[A-Z_]{1,80}$/u.test(reason) ? ` (${reason})` : ''; throw new PluginError(502, 'NATIVE_GEMINI_EMPTY_RESPONSE', `Native Gemini returned no candidate content${safeReason}.`); }
                const nativeGeminiSignature = packTextSignature(collectTextParts(content.parts));
                if (nativeGeminiSignature) content.parts.push({ text: '', thoughtSignature: nativeGeminiSignature });
                response.json({ ...data, nativeGeminiSignature, choices: [{ message: { content: (content?.parts ?? []).filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('') } }], responseContent: content });
            }
        } catch (error) {
            if (response.headersSent) response.destroy();
            else if (!controller.signal.aborted) sendExpressError(response, error instanceof PluginError ? error : new PluginError(502, 'NATIVE_GEMINI_FAILED', 'Native Gemini generation could not be completed.'));
        } finally { request.removeListener('aborted', abort); response.removeListener('close', close); }
    };
}
function transformFrame(frame, textParts) {
    const lines = frame.split(/\r?\n/u), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return frame + '\n\n';
    try {
        const parsed = wrapToolMetadata(JSON.parse(data));
        const candidate = parsed.candidates?.[0];
        if (candidate) {
            textParts.push(...collectTextParts(candidate.content?.parts));
            if (candidate.finishReason) {
                const signature = packTextSignature(textParts);
                if (signature) { candidate.content ??= { role: 'model', parts: [] }; candidate.content.parts ??= []; candidate.content.parts.push({ text: '', thoughtSignature: signature }); }
            }
        }
        return lines.filter(line => !line.startsWith('data:')).concat(`data: ${JSON.stringify(parsed)}`).join('\n') + '\n\n';
    } catch { throw new PluginError(502, 'NATIVE_GEMINI_INVALID_RESPONSE', 'Native Gemini returned an invalid stream.'); }
}
module.exports = { createNativeGeminiHandler, buildNativeGeminiBody, wrapToolMetadata, unpackToolSignature, requestLoopback, unpackTextSignature, packTextSignature };
