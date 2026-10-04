/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. https://mozilla.org/MPL/2.0/.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { toGeminiRequest, createGeminiResponseTransform, MAX_JSON_BYTES, MAX_FRAME_BYTES } = require('../src/gemini-openai.cjs');
const request = extra => ({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hello' }], ...extra });
async function convert(chunks, options = {}) {
    const output = [];
    await pipeline(Readable.from(chunks), createGeminiResponseTransform({ model: 'gemini-2.5-flash', ...options }), new Writable({ write(chunk, _encoding, next) { output.push(chunk); next(); } }));
    return Buffer.concat(output).toString('utf8');
}
const event = value => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
const candidate = (parts, finishReason = undefined, index = 0) => ({ candidates: [{ index, content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });

test('request maps ordered roles, base64 images, controls and generation settings without mutating input', () => {
    const original = request({ messages: [
        { role: 'system', content: 'system' }, { role: 'developer', content: [{ type: 'text', text: 'developer' }] },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'auto' } }] },
        { role: 'assistant', content: 'yes' }, { role: 'user', content: 'continue' },
    ], temperature: 0, top_p: 0.9, top_k: 10, max_completion_tokens: 123, stop: ['end'], seed: -5, n: 2, frequency_penalty: 0.3, presence_penalty: 0.2 });
    const copy = JSON.stringify(original);
    const mapped = toGeminiRequest(original);
    assert.deepEqual(mapped.systemInstruction.parts, [{ text: 'system' }, { text: 'developer' }]);
    assert.equal(mapped.contents[1].role, 'model');
    assert.deepEqual(mapped.contents[0].parts[1].inlineData, { mimeType: 'image/png', data: 'YWJj' });
    assert.deepEqual(mapped.generationConfig, { temperature: 0, topP: 0.9, topK: 10, seed: -5, candidateCount: 2, frequencyPenalty: 0.3, presencePenalty: 0.2, maxOutputTokens: 123, stopSequences: ['end'] });
    assert.equal(JSON.stringify(original), copy);
});
test('parallel tools, signatures, tool results and declarations round trip', async () => {
    const google = candidate([{ functionCall: { name: 'weather', args: { city: 'Tokyo' }, id: 'first' }, thoughtSignature: 'opaque-signature' }, { functionCall: { name: 'clock', args: {} }, thoughtSignature: 'second-signature' }], 'STOP');
    const completion = JSON.parse(await convert([Buffer.from(JSON.stringify(google))]));
    assert.equal(completion.choices[0].finish_reason, 'tool_calls');
    const calls = completion.choices[0].message.tool_calls;
    assert.equal(calls[0].extra_content.google.thought_signature, 'opaque-signature');
    const mapped = toGeminiRequest(request({ messages: [{ role: 'user', content: 'weather?' }, completion.choices[0].message, ...calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' }))], tools: [{ type: 'function', function: { name: 'weather', description: 'weather', parameters: { type: 'object' }, strict: false } }, { type: 'function', function: { name: 'clock' } }], tool_choice: { type: 'function', function: { name: 'weather' } }, parallel_tool_calls: true }));
    assert.equal(mapped.contents[1].parts[0].thoughtSignature, 'opaque-signature');
    assert.equal(mapped.contents[2].parts.length, 2);
    assert.equal(mapped.contents[2].parts[0].functionResponse.name, 'weather');
    assert.deepEqual(mapped.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['weather'] });
    assert.deepEqual(mapped.tools[0].functionDeclarations[0].parametersJsonSchema, { type: 'object' });
});
test('reasoning mapping respects model budgets, levels and explicit Google thinking config', () => {
    assert.deepEqual(toGeminiRequest(request({ reasoning_effort: 'high' })).generationConfig.thinkingConfig, { thinkingBudget: 24576 });
    assert.deepEqual(toGeminiRequest(request({ model: 'google/gemini-3.1-pro', reasoning_effort: 'minimal' })).generationConfig.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.deepEqual(toGeminiRequest(request({ extra_body: { google: { thinking_config: { thinking_budget: -1, include_thoughts: true } } } })).generationConfig.thinkingConfig, { thinkingBudget: -1, includeThoughts: true });
    assert.throws(() => toGeminiRequest(request({ model: 'gemini-2.5-pro', reasoning_effort: 'none' })), /cannot disable/);
    assert.throws(() => toGeminiRequest(request({ reasoning_effort: 'low', extra_body: { google: { thinking_config: {} } } })), /mutually exclusive/);
});
test('JSON schema is preserved and ambiguous unsupported semantic controls are rejected', () => {
    const schema = { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'], additionalProperties: false };
    assert.deepEqual(toGeminiRequest(request({ response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } } })).generationConfig.responseJsonSchema, schema);
    for (const extra of [{ logit_bias: {} }, { parallel_tool_calls: false }, { max_tokens: 1, max_completion_tokens: 2 }, { tools: [{ type: 'function', function: { name: 'f', strict: true } }] }, { tool_choice: 'required' }, { temperature: Infinity }]) assert.throws(() => toGeminiRequest(request(extra)));
    assert.throws(() => toGeminiRequest(request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] })), /not fetched/);
    assert.throws(() => toGeminiRequest(request({ messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'result' }] })), /preceding/);
    assert.throws(() => toGeminiRequest(request({ messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'late' }] })), /precede/);
});
test('nonstream output maps text, reasoning, finish reasons and usage including thought tokens', async () => {
    const google = { ...candidate([{ text: 'reason', thought: true }, { text: '猫', thoughtSignature: 'text-signature' }], 'MAX_TOKENS'), usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 5, thoughtsTokenCount: 6, cachedContentTokenCount: 2, totalTokenCount: 15 } };
    const bytes = Buffer.from(JSON.stringify(google));
    const result = JSON.parse(await convert(Array.from(bytes, byte => Buffer.from([byte]))));
    assert.equal(result.choices[0].message.content, '猫');
    assert.equal(result.choices[0].message.reasoning_content, 'reason');
    assert.equal(result.choices[0].message.extra_content.google.gemini_parts[1].thoughtSignature, 'text-signature');
    assert.equal(result.choices[0].finish_reason, 'length');
    assert.equal(result.usage.completion_tokens, 11);
    assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 6);
});
test('SSE conversion preserves UTF-8 and parallel call signatures across every byte boundary', async () => {
    const bytes = Buffer.concat([event(candidate([{ text: '猫' }])), event(candidate([{ functionCall: { name: 'f', args: { x: 1 } }, thoughtSignature: 'sig' }, { functionCall: { name: 'g', args: {} } }], 'STOP')), event({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } })]);
    const result = await convert(Array.from(bytes, byte => Buffer.from([byte])), { stream: true, includeUsage: true });
    assert.ok(result.endsWith('data: [DONE]\n\n'));
    const frames = result.split('\n\n').filter(Boolean).slice(0, -1).map(frame => JSON.parse(frame.slice(6)));
    assert.equal(frames[0].choices[0].delta.role, 'assistant');
    assert.equal(frames[1].choices[0].delta.content, '猫');
    assert.deepEqual(frames[2].choices[0].delta.tool_calls.map(call => call.index), [0, 1]);
    assert.equal(frames[2].choices[0].delta.tool_calls[0].extra_content.google.thought_signature, 'sig');
    assert.equal(frames.at(-1).usage.total_tokens, 3);
});
test('safety blocking yields content_filter; errors and incomplete streams never masquerade as success', async () => {
    const blocked = JSON.parse(await convert([Buffer.from('{"promptFeedback":{"blockReason":"SAFETY"}}')]));
    assert.equal(blocked.choices[0].finish_reason, 'content_filter');
    for (const body of ['{"error":{"message":"secret"}}', '{', JSON.stringify(candidate([{ text: 'unfinished' }])), JSON.stringify(candidate([{ inlineData: { data: 'abc' } }], 'STOP'))]) await assert.rejects(convert([Buffer.from(body)]));
    for (const chunks of [[event(candidate([{ text: 'partial' }]))], [Buffer.from('data: {}')], [event({ error: { message: 'private upstream detail' } })]]) await assert.rejects(convert(chunks, { stream: true }));
});
test('response and frame byte limits fail closed', async () => {
    await assert.rejects(convert([Buffer.alloc(MAX_JSON_BYTES + 1, 32)]), /limit/);
    await assert.rejects(convert([Buffer.alloc(MAX_FRAME_BYTES + 1, 32)], { stream: true }), /limit/);
});
test('SSE transform preserves backpressure for many frames in one upstream chunk', async () => {
    const chunks = [];
    for (let index = 0; index < 300; index++) chunks.push(event(candidate([{ text: 'x'.repeat(1000) }])));
    chunks.push(event(candidate([], 'STOP')));
    const transform = createGeminiResponseTransform({ stream: true, model: 'gemini-2.5-flash' });
    let writeFinished = false;
    transform.write(Buffer.concat(chunks), () => { writeFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writeFinished, false);
    assert.ok(transform.readableLength < 100000);
    let frames = '';
    transform.on('data', chunk => { frames += chunk.toString(); });
    transform.end();
    await new Promise((resolve, reject) => { transform.on('end', resolve); transform.on('error', reject); });
    assert.ok(frames.endsWith('data: [DONE]\n\n'));
});
test('empty final signed text, CRLF frames and multiple candidates retain signatures and finish boundaries', async () => {
    const bytes = Buffer.from('data: ' + JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: 'answer' }] } }, { index: 1, content: { parts: [{ text: 'alternative' }] } }] }) + '\r\n\r\n' + 'data: ' + JSON.stringify({ candidates: [{ index: 0, content: { parts: [{ text: '', thoughtSignature: 'last-signature' }] }, finishReason: 'STOP' }, { index: 1, content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }) + '\r\n\r\n');
    const output = await convert([bytes], { stream: true });
    assert.match(output, /last-signature/u);
    assert.match(output, /"finish_reason":"length"/u);
    assert.equal(output.match(/data: \[DONE\]/gu).length, 1);
    assert.ok(!output.includes('"usage"'));
    await assert.rejects(convert([event({ candidates: [{ index: 0, content: { parts: [] }, finishReason: 'STOP' }, { index: 1, content: { parts: [{ text: 'unfinished' }] } }] })], { stream: true }), /before completion/);
});
test('many tiny content parts produce bounded SSE output instead of repeated envelopes', async () => {
    const output = await convert([event(candidate(Array.from({ length: 20000 }, () => ({ text: 'a' })), 'STOP'))], { stream: true });
    assert.ok(output.length < 25000);
    assert.equal(output.split('data: ').length - 1, 4);
});
test('tools validate matching names, modes and malformed argument semantics', () => {
    const messages = [{ role: 'user', content: 'tool' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', name: 'f', tool_call_id: 'call1', content: 'plain result' }];
    assert.deepEqual(toGeminiRequest(request({ messages })).contents[2].parts[0].functionResponse.response, { result: 'plain result' });
    assert.throws(() => toGeminiRequest(request({ messages: [...messages.slice(0, 2), { ...messages[2], name: 'other' }] })), /must match/);
    const tools = [{ type: 'function', function: { name: 'f' } }];
    for (const [choice, mode] of [['auto', 'AUTO'], ['none', 'NONE'], ['required', 'ANY']]) assert.equal(toGeminiRequest(request({ tools, tool_choice: choice })).toolConfig.functionCallingConfig.mode, mode);
    assert.throws(() => toGeminiRequest(request({ messages: [messages[0], { ...messages[1], tool_calls: [{ ...messages[1].tool_calls[0], function: { name: 'f', arguments: '[]' } }] }] })), /JSON object/);
});
test('candidate arrays obey count and unique-index protocol bounds', async () => {
    for (const candidates of [
        Array.from({ length: 9 }, (_, index) => ({ index, content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' })),
        [{ index: 0, content: { parts: [{ text: 'x' }] } }, { index: 0, content: { parts: [{ text: 'y' }] } }],
    ]) {
        await assert.rejects(convert([Buffer.from(JSON.stringify({ candidates }))]), /candidates|repeated/u);
        await assert.rejects(convert([event({ candidates })], { stream: true }), /candidates|repeated/u);
    }
});
function historyFor(message) {
    return request({ messages: [{ role: 'user', content: 'start' }, message, ...(message.tool_calls || []).map(call => ({ role: 'tool', tool_call_id: call.id, content: '{"result":"done"}' })), { role: 'user', content: 'continue' }] });
}
test('complex signed native parts round trip exactly with generated matching call IDs', async () => {
    const native = [{ text: 'first', thoughtSignature: 'sig-one' }, { text: 'reason', thought: true, thoughtSignature: 'sig-thought' }, { functionCall: { name: 'f', args: { x: 1 } }, thoughtSignature: 'sig-tool' }, { text: 'second', thoughtSignature: 'sig-two' }];
    const result = JSON.parse(await convert([Buffer.from(JSON.stringify(candidate(native, 'STOP')))]));
    const message = result.choices[0].message;
    assert.equal(message.content, 'firstsecond');
    assert.equal(message.reasoning_content, 'reason');
    assert.equal(message.extra_content.google.thought_signature, undefined);
    const expected = structuredClone(native);
    expected[2].functionCall.id = message.tool_calls[0].id;
    assert.deepEqual(message.extra_content.google.gemini_parts, expected);
    assert.deepEqual(toGeminiRequest(historyFor(message)).contents[1].parts, expected);
    for (const modify of [
        copy => { copy.content += 'edited'; },
        copy => { copy.reasoning_content = 'edited'; },
        copy => { copy.tool_calls[0].function.arguments = '{"x":2}'; },
        copy => { copy.tool_calls[0].extra_content.google.thought_signature = 'different'; },
        copy => { copy.extra_content.google.gemini_parts[0].url = 'https://untrusted'; },
    ]) {
        const modified = structuredClone(message);
        modify(modified);
        assert.throws(() => toGeminiRequest(historyFor(modified)), /match|cannot be converted/u);
    }
});
test('stream final metadata preserves signed thought and text boundaries and unsigned text coalesces', async () => {
    const output = await convert([
        event(candidate([{ text: 'a' }, { text: 'b' }])),
        event(candidate([{ text: 'thought', thought: true, thoughtSignature: 'thought-sig' }])),
        event(candidate([{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'tool-sig' }, { text: 'c', thoughtSignature: 'text-sig' }], 'STOP')),
    ], { stream: true });
    const message = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
    for (const frame of output.split('\n\n').filter(Boolean)) {
        if (frame === 'data: [DONE]') continue;
        const delta = JSON.parse(frame.slice(6)).choices[0]?.delta;
        if (!delta) continue;
        message.content += delta.content || '';
        message.reasoning_content += delta.reasoning_content || '';
        for (const call of delta.tool_calls || []) { const { index, ...tool } = call; message.tool_calls[index] = tool; }
        if (delta.extra_content) message.extra_content = delta.extra_content;
    }
    assert.equal(message.content, 'abc');
    const native = message.extra_content.google.gemini_parts;
    assert.deepEqual(native.map(part => part.thoughtSignature), [undefined, 'thought-sig', 'tool-sig', 'text-sig']);
    assert.equal(native[0].text, 'ab');
    assert.deepEqual(toGeminiRequest(historyFor(message)).contents[1].parts, native);
});
test('official message signatures cannot be misassociated with reasoning or multiple parts', () => {
    const extra_content = { google: { thought_signature: 'signature' } };
    const valid = { role: 'assistant', content: 'plain', extra_content };
    assert.equal(toGeminiRequest(historyFor(valid)).contents[1].parts[0].thoughtSignature, 'signature');
    assert.throws(() => toGeminiRequest(historyFor({ ...valid, reasoning_content: 'thought' })), /one non-thought/u);
    assert.throws(() => toGeminiRequest(historyFor({ ...valid, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })), /one non-thought/u);
});
test('metadata uses a transform-wide byte bound across candidates and a part-count bound', async () => {
    const transforms = [];
    for (let index = 0; index < 8; index++) transforms.push(event(candidate([{ text: 'x'.repeat(600000) }], undefined, index)));
    for (let index = 0; index < 8; index++) transforms.push(event(candidate([{ text: 'x'.repeat(600000) }], undefined, index)));
    await assert.rejects(convert(transforms, { stream: true }), /metadata exceeded/u);
    await assert.rejects(convert([event(candidate(Array.from({ length: 8193 }, () => ({ text: '', thoughtSignature: 's' })), 'STOP'))], { stream: true }), /part limit/u);
});
test('unsigned output omits native metadata and duplicate provider call IDs fail closed', async () => {
    const unsigned = JSON.parse(await convert([Buffer.from(JSON.stringify(candidate([{ text: 'plain' }], 'STOP')))]));
    assert.equal(unsigned.choices[0].message.extra_content, undefined);
    const call = { functionCall: { name: 'f', id: 'duplicate', args: {} }, thoughtSignature: 's' };
    await assert.rejects(convert([Buffer.from(JSON.stringify(candidate([call, call], 'STOP')))]), /duplicate function/u);
    await assert.rejects(convert([event(candidate([call])), event(candidate([call], 'STOP'))], { stream: true }), /duplicate function/u);
});
