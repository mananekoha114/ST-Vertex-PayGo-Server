/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/.
 */
'use strict';
const { Transform } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { BoundedBuffer } = require('./bounded-buffer.cjs');
const { PluginError } = require('./errors.cjs');
const { isDeepStrictEqual } = require('node:util');
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PARTS = 8192;
const fail = message => { throw new PluginError(400, 'GEMINI_GATEWAY_UNSUPPORTED', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, label) {
    if (!object(value)) fail(`${label} must be an object.`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}.${key} cannot be converted to Gemini.`);
}
function signature(extra) {
    if (extra === undefined) return undefined;
    fields(extra, ['google'], 'extra_content');
    fields(extra.google, ['thought_signature'], 'extra_content.google');
    const value = extra.google.thought_signature;
    if (typeof value !== 'string' || !value) fail('A thought signature must be a nonempty string.');
    return value;
}
function restoreParts(message) {
    fields(message.extra_content, ['google'], 'extra_content');
    fields(message.extra_content.google, ['gemini_parts', 'thought_signature'], 'extra_content.google');
    const native = message.extra_content.google.gemini_parts;
    if (!Array.isArray(native) || !native.length || native.length > MAX_PARTS || Buffer.byteLength(JSON.stringify(native)) > MAX_JSON_BYTES) fail('Gemini part metadata exceeds its bounds or is invalid.');
    let text = '';
    let reasoning = '';
    const projectedCalls = [];
    const textSignatures = [];
    for (const part of native) {
        fields(part, ['text', 'thought', 'thoughtSignature', 'functionCall'], 'gemini_parts');
        if (part.thought !== undefined && typeof part.thought !== 'boolean') fail('Invalid part thought marker.');
        if (part.thoughtSignature !== undefined && (typeof part.thoughtSignature !== 'string' || !part.thoughtSignature)) fail('Invalid part thought signature.');
        if (typeof part.text === 'string' && part.functionCall === undefined) {
            if (part.thought) reasoning += part.text;
            else text += part.text;
            if (part.thoughtSignature) textSignatures.push(part);
        } else if (part.text === undefined && object(part.functionCall)) {
            fields(part.functionCall, ['name', 'id', 'args'], 'gemini_parts.functionCall');
            const call = part.functionCall;
            if (typeof call.name !== 'string' || !call.name || typeof call.id !== 'string' || !call.id || !object(call.args)) fail('Invalid native function metadata.');
            projectedCalls.push({ id: call.id, name: call.name, args: call.args, signature: part.thoughtSignature });
        } else fail('Unsupported Gemini part metadata.');
    }
    if ((message.content ?? '') !== text || (message.reasoning_content ?? '') !== reasoning) fail('Gemini metadata does not match message text or reasoning.');
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length !== projectedCalls.length) fail('Gemini metadata does not match tool calls.');
    for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        fields(call, ['id', 'type', 'function', 'extra_content'], 'tool_call');
        fields(call.function, ['name', 'arguments'], 'tool_call.function');
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { fail('Invalid tool arguments.'); }
        const projected = projectedCalls[index];
        if (call.type !== 'function' || call.id !== projected.id || call.function.name !== projected.name || !isDeepStrictEqual(args, projected.args) || signature(call.extra_content) !== projected.signature) fail('Gemini metadata does not match tool calls.');
    }
    if (message.extra_content.google.thought_signature !== undefined) {
        if (textSignatures.length !== 1 || textSignatures[0].thought || native.length !== 1 || message.extra_content.google.thought_signature !== textSignatures[0].thoughtSignature) fail('Message-level signature cannot represent these Gemini parts.');
    }
    return native;
}
function parts(content, textOnly = false) {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content)) fail('Message content must be text or a content array.');
    return content.map(part => {
        if (part?.type === 'text') {
            fields(part, ['type', 'text', 'extra_content'], 'content');
            if (typeof part.text !== 'string') fail('Text content must be a string.');
            const thoughtSignature = signature(part.extra_content);
            if (textOnly && thoughtSignature) fail('System instructions cannot contain thought signatures.');
            return { text: part.text, ...(thoughtSignature ? { thoughtSignature } : {}) };
        }
        if (!textOnly && part?.type === 'image_url') {
            fields(part, ['type', 'image_url'], 'content');
            fields(part.image_url, ['url', 'detail'], 'image_url');
            if (part.image_url.detail !== undefined && part.image_url.detail !== 'auto') fail('Explicit image detail cannot be converted.');
            const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(part.image_url.url);
            if (!match || match[2].length % 4 !== 0 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) fail('Only valid base64 inline images are supported; remote URLs are not fetched.');
            return { inlineData: { mimeType: match[1], data: match[2] } };
        }
        fail('This content part cannot be converted to Gemini.');
    });
}
function toGeminiRequest(payload) {
    fields(payload, ['messages', 'model', 'stream', 'stream_options', 'temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'stop', 'seed', 'n', 'frequency_penalty', 'presence_penalty', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort', 'extra_body', 'logprobs'], 'request');
    if (!Array.isArray(payload.messages) || !payload.messages.length) fail('A nonempty messages array is required.');
    if (payload.stream !== undefined && typeof payload.stream !== 'boolean') fail('stream must be boolean.');
    if (payload.stream_options !== undefined) {
        fields(payload.stream_options, ['include_usage'], 'stream_options');
        if (typeof payload.stream_options.include_usage !== 'boolean') fail('include_usage must be boolean.');
        if (!payload.stream) fail('stream_options requires streaming.');
    }
    if (payload.logprobs !== undefined && payload.logprobs !== false) fail('Log probabilities cannot be converted.');
    if (payload.parallel_tool_calls !== undefined && payload.parallel_tool_calls !== true) fail('Disabling parallel tool calls cannot be represented by Gemini.');
    const result = { contents: [] };
    const systemParts = [];
    const calls = new Map();
    let conversationStarted = false;
    for (const message of payload.messages) {
        fields(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'extra_content', 'reasoning_content', 'name'], 'message');
        if (['system', 'developer'].includes(message.role)) {
            if (conversationStarted || message.tool_calls || message.tool_call_id || message.extra_content || message.reasoning_content || message.name !== undefined) fail('System/developer instructions must precede conversation messages and contain only text.');
            systemParts.push(...parts(message.content, true));
            continue;
        }
        conversationStarted = true;
        if (!['user', 'assistant', 'tool'].includes(message.role)) fail('Unsupported message role.');
        if (message.role !== 'tool' && calls.size) fail('All parallel tool results must precede the next conversation message.');
        const converted = { role: message.role === 'assistant' ? 'model' : 'user', parts: [] };
        if (message.role === 'tool') {
            if (message.tool_calls || message.extra_content || message.reasoning_content) fail('Tool messages cannot contain assistant metadata.');
            const call = calls.get(message.tool_call_id);
            if (!call) fail('Tool result must reference a preceding unconsumed tool call.');
            if (message.name !== undefined && message.name !== call.name) fail('Tool result name must match its call.');
            calls.delete(message.tool_call_id);
            let response;
            if (typeof message.content !== 'string') fail('Tool result content must be a string.');
            try { response = JSON.parse(message.content); } catch { response = { result: message.content }; }
            if (!object(response)) response = { result: response };
            converted.parts.push({ functionResponse: { name: call.name, id: message.tool_call_id, response } });
        } else {
            if (message.name !== undefined) fail('Speaker names cannot be converted without changing prompt semantics.');
            if (message.tool_call_id !== undefined) fail('tool_call_id is only valid on tool messages.');
            if (message.extra_content?.google?.gemini_parts !== undefined) {
                if (message.role !== 'assistant') fail('Gemini part metadata requires an assistant message.');
                converted.parts = restoreParts(message);
                for (const part of converted.parts) if (part.functionCall) {
                    if (calls.has(part.functionCall.id)) fail('Duplicate native tool call ID.');
                    calls.set(part.functionCall.id, { name: part.functionCall.name });
                }
            } else {
                if (message.content !== null && message.content !== undefined) converted.parts.push(...parts(message.content));
                if (message.reasoning_content !== undefined) {
                    if (message.role !== 'assistant' || typeof message.reasoning_content !== 'string') fail('reasoning_content requires assistant text.');
                    converted.parts.unshift({ text: message.reasoning_content, thought: true });
                }
                if (message.extra_content !== undefined) {
                    if (message.role !== 'assistant' || !converted.parts.length) fail('Message thought signatures require assistant content.');
                    if (converted.parts.length !== 1 || converted.parts[0].thought || typeof converted.parts[0].text !== 'string' || message.tool_calls !== undefined) fail('Message-level signatures require one non-thought text part; preserve gemini_parts for complex responses.');
                    converted.parts[converted.parts.length - 1].thoughtSignature = signature(message.extra_content);
                }
                if (message.tool_calls !== undefined) {
                    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) fail('tool_calls requires a nonempty assistant array.');
                    for (const call of message.tool_calls) {
                        fields(call, ['id', 'type', 'function', 'extra_content'], 'tool_call');
                        fields(call.function, ['name', 'arguments'], 'tool_call.function');
                        if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || calls.has(call.id) || typeof call.function.name !== 'string' || !call.function.name || typeof call.function.arguments !== 'string') fail('Invalid function call.');
                        let args;
                        try { args = JSON.parse(call.function.arguments); } catch { fail('Function arguments must contain valid JSON.'); }
                        if (!object(args)) fail('Function arguments must be a JSON object.');
                        const thoughtSignature = signature(call.extra_content);
                        converted.parts.push({ functionCall: { name: call.function.name, args, id: call.id }, ...(thoughtSignature ? { thoughtSignature } : {}) });
                        calls.set(call.id, call.function);
                    }
                }
            }
        }
        if (!converted.parts.length) fail('Conversation messages must contain content or tool calls.');
        const last = result.contents.at(-1);
        if (last?.role === converted.role) last.parts.push(...converted.parts);
        else result.contents.push(converted);
    }
    if (!result.contents.length) fail('At least one conversation message is required.');
    if (calls.size) fail('All tool calls require corresponding tool results.');
    if (systemParts.length) result.systemInstruction = { parts: systemParts };
    const generation = {};
    for (const [source, target, min, max, integer] of [
        ['temperature', 'temperature', 0, 2, false], ['top_p', 'topP', 0, 1, false], ['top_k', 'topK', 1, Infinity, true],
        ['seed', 'seed', -2147483648, 2147483647, true], ['n', 'candidateCount', 1, 8, true],
        ['frequency_penalty', 'frequencyPenalty', -2, 2, false], ['presence_penalty', 'presencePenalty', -2, 2, false],
    ]) {
        if (payload[source] === undefined) continue;
        const value = payload[source];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`Invalid ${source}.`);
        generation[target] = value;
    }
    if (payload.max_tokens !== undefined && payload.max_completion_tokens !== undefined) fail('Specify only one output token limit.');
    const maxTokens = payload.max_completion_tokens ?? payload.max_tokens;
    if (maxTokens !== undefined) {
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) fail('Invalid output token limit.');
        generation.maxOutputTokens = maxTokens;
    }
    if (payload.stop !== undefined && payload.stop !== null) {
        const stop = typeof payload.stop === 'string' ? [payload.stop] : payload.stop;
        if (!Array.isArray(stop) || stop.length > 5 || stop.some(value => typeof value !== 'string' || !value)) fail('Invalid stop sequences.');
        generation.stopSequences = stop;
    }
    if (payload.response_format !== undefined) {
        fields(payload.response_format, ['type', 'json_schema'], 'response_format');
        const format = payload.response_format;
        if (format.type === 'json_object') {
            if (format.json_schema !== undefined) fail('json_object cannot contain json_schema.');
            generation.responseMimeType = 'application/json';
        } else if (format.type === 'json_schema') {
            fields(format.json_schema, ['name', 'description', 'schema', 'strict'], 'json_schema');
            if (!object(format.json_schema.schema)) fail('A JSON schema object is required.');
            if (format.json_schema.strict !== undefined && format.json_schema.strict !== true) fail('Non-strict JSON schema cannot be represented.');
            generation.responseMimeType = 'application/json';
            generation.responseJsonSchema = format.json_schema.schema;
        } else if (format.type !== 'text' || format.json_schema !== undefined) fail('Unsupported response_format.');
    }
    if (payload.reasoning_effort !== undefined) {
        const effort = payload.reasoning_effort;
        if (!['none', 'minimal', 'low', 'medium', 'high'].includes(effort)) fail('Unsupported reasoning_effort.');
        const model = String(payload.model || '').replace(/^google\//u, '');
        if (model.startsWith('gemini-2.5')) {
            if (effort === 'none' && model.includes('pro')) fail('Gemini 2.5 Pro cannot disable thinking.');
            generation.thinkingConfig = { thinkingBudget: { none: 0, minimal: 1024, low: 1024, medium: 8192, high: 24576 }[effort] };
        } else if (/^gemini-3(?:\.|-)/u.test(model)) {
            if (effort === 'none') fail('Gemini 3 cannot disable thinking.');
            generation.thinkingConfig = { thinkingLevel: (effort === 'minimal' && model.includes('pro') ? 'low' : effort).toUpperCase() };
        } else fail('reasoning_effort requires a supported thinking model.');
    }
    if (payload.extra_body !== undefined) {
        fields(payload.extra_body, ['google'], 'extra_body');
        fields(payload.extra_body.google, ['thinking_config', 'safety_settings'], 'extra_body.google');
        const google = payload.extra_body.google;
        if (google.thinking_config !== undefined) {
            if (generation.thinkingConfig) fail('reasoning_effort and thinking_config are mutually exclusive.');
            fields(google.thinking_config, ['thinking_budget', 'thinking_level', 'include_thoughts'], 'thinking_config');
            const config = google.thinking_config;
            if (config.thinking_budget !== undefined && (!Number.isInteger(config.thinking_budget) || config.thinking_budget < -1)) fail('Invalid thinking_budget.');
            if (config.thinking_level !== undefined && !['minimal', 'low', 'medium', 'high'].includes(config.thinking_level)) fail('Invalid thinking_level.');
            if (config.thinking_level !== undefined && config.thinking_budget !== undefined) fail('Specify thinking_level or thinking_budget.');
            if (config.include_thoughts !== undefined && typeof config.include_thoughts !== 'boolean') fail('Invalid include_thoughts.');
            generation.thinkingConfig = {};
            for (const [source, target] of [['thinking_budget', 'thinkingBudget'], ['thinking_level', 'thinkingLevel'], ['include_thoughts', 'includeThoughts']]) if (config[source] !== undefined) generation.thinkingConfig[target] = source === 'thinking_level' ? config[source].toUpperCase() : config[source];
        }
        if (google.safety_settings !== undefined) {
            if (!Array.isArray(google.safety_settings)) fail('safety_settings must be an array.');
            result.safetySettings = google.safety_settings.map(setting => {
                fields(setting, ['category', 'threshold'], 'safety setting');
                if (typeof setting.category !== 'string' || typeof setting.threshold !== 'string') fail('Invalid safety setting.');
                return { ...setting };
            });
        }
    }
    if (payload.tools !== undefined) {
        if (!Array.isArray(payload.tools)) fail('tools must be an array.');
        const names = new Set();
        const declarations = payload.tools.map(tool => {
            fields(tool, ['type', 'function'], 'tool');
            fields(tool.function, ['name', 'description', 'parameters', 'strict'], 'tool.function');
            const fn = tool.function;
            if (tool.type !== 'function' || typeof fn.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(fn.name) || names.has(fn.name)) fail('Invalid or duplicate function declaration.');
            names.add(fn.name);
            if (fn.strict !== undefined && fn.strict !== false) fail('Strict OpenAI function validation cannot be represented.');
            if (fn.description !== undefined && typeof fn.description !== 'string') fail('Invalid function description.');
            if (fn.parameters !== undefined && !object(fn.parameters)) fail('Function parameters must be an object schema.');
            return { name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), ...(fn.parameters !== undefined ? { parametersJsonSchema: fn.parameters } : {}) };
        });
        if (declarations.length) result.tools = [{ functionDeclarations: declarations }];
    }
    if (payload.tool_choice !== undefined) {
        const choice = payload.tool_choice;
        const config = {};
        if (['auto', 'none', 'required'].includes(choice)) config.mode = { auto: 'AUTO', none: 'NONE', required: 'ANY' }[choice];
        else {
            fields(choice, ['type', 'function'], 'tool_choice');
            fields(choice.function, ['name'], 'tool_choice.function');
            if (choice.type !== 'function' || typeof choice.function.name !== 'string') fail('Invalid tool_choice.');
            config.mode = 'ANY';
            config.allowedFunctionNames = [choice.function.name];
        }
        const declared = result.tools?.[0]?.functionDeclarations || [];
        if (config.mode === 'ANY' && (!declared.length || config.allowedFunctionNames?.some(name => !declared.some(fn => fn.name === name)))) fail('tool_choice must reference declared functions.');
        result.toolConfig = { functionCallingConfig: config };
    }
    if (Object.keys(generation).length) result.generationConfig = generation;
    return result;
}
function usage(metadata) {
    if (!metadata) return undefined;
    if (!object(metadata)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned invalid usage metadata.');
    for (const field of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount', 'totalTokenCount']) if (metadata[field] !== undefined && (!Number.isSafeInteger(metadata[field]) || metadata[field] < 0)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned invalid token counts.');
    const prompt = metadata.promptTokenCount || 0;
    const completion = (metadata.candidatesTokenCount || 0) + (metadata.thoughtsTokenCount || 0);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: metadata.totalTokenCount ?? prompt + completion, prompt_tokens_details: { cached_tokens: metadata.cachedContentTokenCount || 0 }, completion_tokens_details: { reasoning_tokens: metadata.thoughtsTokenCount || 0 } };
}
function finish(reason, tools) {
    if (reason === 'STOP') return tools ? 'tool_calls' : 'stop';
    if (reason === 'MAX_TOKENS') return 'length';
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'].includes(reason)) return 'content_filter';
    throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an unsupported or missing finish reason.');
}
class GeminiResponseTransform extends Transform {
    constructor({ stream = false, model, includeUsage = false } = {}) {
        super();
        this.streaming = stream;
        this.model = model;
        this.includeUsage = includeUsage;
        this.id = `chatcmpl-${randomUUID()}`;
        this.created = Math.floor(Date.now() / 1000);
        this.buffer = new BoundedBuffer(stream ? MAX_FRAME_BYTES : MAX_JSON_BYTES);
        this.line = new BoundedBuffer(MAX_FRAME_BYTES);
        this.input = null;
        this.offset = 0;
        this.callback = null;
        this.outputs = [];
        this.states = new Map();
        this.lastUsage = undefined;
        this.metadataBytes = 0;
        this.metadataParts = 0;
    }
    retainPart(state, part) {
        // Include array punctuation conservatively so emitted metadata also fits
        // the request-side limit when the client returns it on the next turn.
        this.metadataBytes += Buffer.byteLength(JSON.stringify(part)) + 1;
        if (this.metadataBytes > MAX_JSON_BYTES) throw new PluginError(502, 'GEMINI_RESPONSE_TOO_LARGE', 'Google conversation metadata exceeded the response limit.');
        const mergeable = this.streaming && typeof part.text === 'string' && !part.thoughtSignature;
        if (state.pendingText && (!mergeable || state.pendingThought !== part.thought)) this.finishText(state);
        if (mergeable) {
            if (!state.pendingText) {
                state.pendingText = new BoundedBuffer(MAX_JSON_BYTES);
                state.pendingThought = part.thought;
            }
            state.pendingText.append(Buffer.from(part.text));
        } else {
            this.addPart(state, part);
        }
        state.hasSignature ||= Boolean(part.thoughtSignature);
    }
    addPart(state, part) {
        if (++this.metadataParts > MAX_PARTS) throw new PluginError(502, 'GEMINI_RESPONSE_TOO_LARGE', 'Google conversation metadata exceeded the part limit.');
        state.parts.push(part);
    }
    finishText(state) {
        if (!state.pendingText) return;
        this.addPart(state, { text: state.pendingText.toBuffer().toString('utf8'), ...(state.pendingThought !== undefined ? { thought: state.pendingThought } : {}) });
        state.pendingText = null;
    }
    envelope(choices, streaming = this.streaming) {
        return { id: this.id, object: streaming ? 'chat.completion.chunk' : 'chat.completion', created: this.created, model: this.model, choices };
    }
    emitJSON(value) {
        if (this.includeUsage && value.choices.length && value.usage === undefined) value.usage = null;
        this.outputs.push(Buffer.from(`data: ${JSON.stringify(value)}\n\n`));
    }
    parse(buffer) {
        let value;
        try { value = JSON.parse(buffer.toString('utf8')); } catch { throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned invalid JSON.'); }
        if (!object(value) || value.error) throw new PluginError(502, 'GEMINI_UPSTREAM_ERROR', 'Google returned an error response.');
        return value;
    }
    convert(value) {
        if (value.usageMetadata) this.lastUsage = usage(value.usageMetadata);
        if (value.promptFeedback?.blockReason && !value.candidates?.length) value = { ...value, candidates: [{ index: 0, finishReason: 'SAFETY', content: { parts: [] } }] };
        if (value.candidates !== undefined && !Array.isArray(value.candidates)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google candidates must be an array.');
        if (value.candidates?.length > 8) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned too many candidates.');
        const choices = [];
        const frameIndices = new Set();
        for (const candidate of value.candidates || []) {
            if (!object(candidate)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an invalid candidate.');
            const index = candidate.index ?? 0;
            if (!Number.isInteger(index) || index < 0 || index > 7) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an invalid candidate index.');
            if (frameIndices.has(index)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google repeated a candidate index in one response event.');
            frameIndices.add(index);
        }
        for (const candidate of value.candidates || []) {
            const index = candidate.index ?? 0;
            let state = this.states.get(index);
            if (state?.finished) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned content after a finished candidate.');
            if (!state) {
                this.metadataBytes += 2;
                if (this.metadataBytes > MAX_JSON_BYTES) throw new PluginError(502, 'GEMINI_RESPONSE_TOO_LARGE', 'Google conversation metadata exceeded the response limit.');
                state = { tools: 0, toolIds: new Set(), finished: false, parts: [], hasSignature: false, pendingText: null };
                this.states.set(index, state);
                if (this.streaming) this.emitJSON(this.envelope([{ index, delta: { role: 'assistant' }, finish_reason: null }]));
            }
            const message = { role: 'assistant', content: '' };
            const combinedDelta = {};
            if (candidate.content?.parts !== undefined && !Array.isArray(candidate.content.parts)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google content parts must be an array.');
            for (const part of candidate.content?.parts || []) {
                const delta = {};
                if (!object(part) || Object.keys(part).some(key => !['text', 'functionCall', 'thought', 'thoughtSignature'].includes(key)) || (part.text !== undefined && part.functionCall !== undefined) || (part.thought !== undefined && typeof part.thought !== 'boolean') || (part.thoughtSignature !== undefined && (typeof part.thoughtSignature !== 'string' || !part.thoughtSignature))) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an invalid or unsupported content part.');
                if (typeof part.text === 'string') {
                    if (part.thought) {
                        delta.reasoning_content = part.text;
                        message.reasoning_content = (message.reasoning_content || '') + part.text;
                    } else {
                        delta.content = part.text;
                        message.content += part.text;
                    }
                    this.retainPart(state, part);
                } else if (part.functionCall) {
                    const call = part.functionCall;
                    if (!object(call) || Object.keys(call).some(key => !['name', 'id', 'args'].includes(key)) || typeof call.name !== 'string' || !call.name || (call.id !== undefined && typeof call.id !== 'string') || !object(call.args ?? {})) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an invalid or unsupported function call.');
                    const tool = { id: call.id || `call_${randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}) };
                    if (state.toolIds.has(tool.id)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned duplicate function call IDs.');
                    state.toolIds.add(tool.id);
                    delta.tool_calls = [{ index: state.tools++, ...tool }];
                    (message.tool_calls ||= []).push(tool);
                    this.retainPart(state, { ...part, functionCall: { ...call, id: tool.id, args: call.args ?? {} } });
                } else throw new PluginError(502, 'GEMINI_UNSUPPORTED_RESPONSE', 'Google returned an unsupported output modality.');
                // One bounded delta per candidate/event avoids multiplying a large
                // array of tiny parts into thousands of repeated SSE envelopes.
                for (const field of ['content', 'reasoning_content']) if (delta[field] !== undefined) combinedDelta[field] = (combinedDelta[field] || '') + delta[field];
                if (delta.tool_calls) (combinedDelta.tool_calls ||= []).push(...delta.tool_calls);
                if (delta.extra_content) combinedDelta.extra_content = delta.extra_content;
            }
            if (this.streaming && Object.keys(combinedDelta).length) this.emitJSON(this.envelope([{ index, delta: combinedDelta, finish_reason: null }]));
            let finishReason = null;
            if (candidate.finishReason) {
                finishReason = finish(candidate.finishReason, state.tools > 0);
                state.finished = true;
                this.finishText(state);
                if (this.streaming) this.emitJSON(this.envelope([{ index, delta: state.hasSignature ? { extra_content: { google: { gemini_parts: state.parts } } } : {}, finish_reason: finishReason }]));
            }
            if (!this.streaming) {
                if (!finishReason) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an incomplete completion.');
                if (message.tool_calls && !message.content) message.content = null;
                if (state.hasSignature) {
                    message.extra_content = { google: { gemini_parts: state.parts } };
                    if (state.parts.length === 1 && typeof state.parts[0].text === 'string' && !state.parts[0].thought && state.parts[0].thoughtSignature) message.extra_content.google.thought_signature = state.parts[0].thoughtSignature;
                }
                choices.push({ index, message, finish_reason: finishReason });
            }
        }
        return choices;
    }
    frame() {
        const text = this.buffer.toBuffer().toString('utf8');
        this.buffer = new BoundedBuffer(MAX_FRAME_BYTES);
        const data = text.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
        if (!data) return;
        if (data === '[DONE]') throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned an unexpected OpenAI terminator.');
        this.convert(this.parse(Buffer.from(data)));
    }
    drain() {
        try {
            while (this.outputs.length) if (!this.push(this.outputs.shift())) return;
            while (this.input && this.offset < this.input.length) {
                const newline = this.input.indexOf(10, this.offset);
                const end = newline === -1 ? this.input.length : newline + 1;
                if (!this.line.append(this.input.subarray(this.offset, end))) throw new PluginError(502, 'GEMINI_RESPONSE_TOO_LARGE', 'Google SSE line exceeded the response limit.');
                this.offset = end;
                if (newline !== -1) {
                    const line = this.line.toBuffer();
                    this.line = new BoundedBuffer(MAX_FRAME_BYTES);
                    if (line.length === 1 || (line.length === 2 && line[0] === 13)) this.frame();
                    else if (!this.buffer.append(line)) throw new PluginError(502, 'GEMINI_RESPONSE_TOO_LARGE', 'Google SSE event exceeded the response limit.');
                    while (this.outputs.length) if (!this.push(this.outputs.shift())) return;
                }
            }
            if (this.callback) {
                const callback = this.callback;
                this.callback = null;
                this.input = null;
                callback();
            }
        } catch (cause) {
            const callback = this.callback;
            this.callback = null;
            this.input = null;
            if (callback) callback(cause);
            else this.destroy(cause);
        }
    }
    _read(size) {
        if (this.callback || this.outputs.length) this.drain();
        super._read(size);
    }
    _transform(chunk, encoding, callback) {
        if (!this.streaming) {
            if (!this.buffer.append(chunk)) return callback(new PluginError(502, 'GEMINI_RESPONSE_TOO_LARGE', 'Google JSON exceeded the response limit.'));
            callback();
            return;
        }
        this.input = chunk;
        this.offset = 0;
        this.callback = callback;
        this.drain();
    }
    _flush(callback) {
        try {
            if (!this.streaming) {
                const value = this.parse(this.buffer.toBuffer());
                const choices = this.convert(value);
                if (!choices.length) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google returned no candidates.');
                this.push(Buffer.from(JSON.stringify({ ...this.envelope(choices, false), ...(this.lastUsage ? { usage: this.lastUsage } : {}) })));
            } else {
                if (this.line.size || this.buffer.size) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google SSE ended in an incomplete event.');
                if (!this.states.size || [...this.states.values()].some(state => !state.finished)) throw new PluginError(502, 'GEMINI_INVALID_RESPONSE', 'Google SSE ended before completion.');
                if (this.includeUsage && this.lastUsage) this.push(Buffer.from(`data: ${JSON.stringify({ ...this.envelope([]), usage: this.lastUsage })}\n\n`));
                this.push(Buffer.from('data: [DONE]\n\n'));
            }
            callback();
        } catch (cause) { callback(cause); }
    }
}
function createGeminiResponseTransform(options) { return new GeminiResponseTransform(options); }
module.exports = { toGeminiRequest, createGeminiResponseTransform, MAX_JSON_BYTES, MAX_FRAME_BYTES };
