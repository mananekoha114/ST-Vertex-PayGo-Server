'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { PassThrough } = require('node:stream');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const { TicketStore } = require('../src/ticket-store.cjs');
const { createNativeGeminiHandler, buildNativeGeminiBody } = require('../src/native-gemini.cjs');

const workspace = path.resolve(__dirname, '../..');
const hostRoot = path.join(workspace, 'SillyTavern-1.18.0');
const frontEntry = path.join(workspace, 'ST-Vertex-PayGo/src/request-transport.js');
const available = fs.existsSync(frontEntry) && fs.existsSync(path.join(hostRoot, 'src/prompt-converters.js'));
function extract(source, name) {
    const start = source.indexOf(`export function ${name}(`);
    assert(start >= 0, name);
    return source.slice(start).match(/^[\s\S]*?^}\r?$/m)[0].replace('export ', '');
}
function nativeHost() {
    const converter = fs.readFileSync(path.join(hostRoot, 'src/prompt-converters.js'), 'utf8');
    const openai = fs.readFileSync(path.join(hostRoot, 'public/scripts/openai.js'), 'utf8');
    const reasoning = fs.readFileSync(path.join(hostRoot, 'public/scripts/reasoning.js'), 'utf8');
    const sandbox = vm.createContext({ enableThoughtSignatures: true, GEMINI_MEDIA_RESOLUTION: {},
        tryParse: text => { try { return JSON.parse(text); } catch { return null; } },
        chat_completion_sources: new Proxy({}, { get: (_, key) => key }), oai_settings: { show_thoughts: true } });
    vm.runInContext([extract(converter, 'convertGooglePrompt'), extract(openai, 'getStreamingReply'),
        extract(reasoning, 'extractReasoningFromData')].join('\n'), sandbox);
    return { sandbox, runtime: { getNativeGeminiHelpers: async () => ({
        convertGooglePrompt: sandbox.convertGooglePrompt, GEMINI_SAFETY: [], VERTEX_SAFETY: [],
    }) } };
}

for (const source of ['makersuite', 'vertexai']) for (const stream of [false, true]) {
    test(`native Argon full flow: frontend -> authenticated route -> ticket -> two mock hops -> ST parser (${source}, stream=${stream})`, { skip: !available }, async () => {
        const { installRequestTransport } = await import(pathToFileURL(frontEntry));
        const { sandbox, runtime } = nativeHost();
        const store = new TicketStore();
        const upstreamCalls = [];
        const ledger = [];
        const transport = createLoopbackTransport({ ticketStore: store,
            usageStore: { update: (_reference, update) => ledger.push(update) },
            upstreamRequest(target, options, callback) {
                const outgoing = new PassThrough();
                const chunks = [];
                outgoing.on('data', chunk => chunks.push(chunk));
                outgoing.on('finish', () => {
                    const hop = upstreamCalls.length;
                    upstreamCalls.push({ target: target.toString(), options, body: JSON.parse(Buffer.concat(chunks).toString()) });
                    const thoughtParts = hop ? [] : [{ thought: true, text: 'think1' }, { thought: true, text: 'think2' }];
                    const value = { candidates: [{ content: { role: 'model', parts: [...thoughtParts,
                        { text: hop ? 'B' : 'A', thoughtSignature: hop ? 'sig-B' : 'sig-A' }] },
                        finishReason: hop ? 'STOP' : 'CONTINUATION', ...(hop ? {} : { continuationToken: 'next-hop' }) }],
                    usageMetadata: { promptTokenCount: 10 + hop, candidatesTokenCount: 1, thoughtsTokenCount: hop ? 0 : 2, totalTokenCount: 13 } };
                    const incoming = new PassThrough();
                    incoming.statusCode = 200;
                    incoming.headers = { 'content-type': stream ? 'text/event-stream' : 'application/json' };
                    callback(incoming);
                    incoming.end(stream ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value));
                });
                return outgoing;
            },
        });
        await transport.start();
        const handler = createNativeGeminiHandler({ runtime, loopbackTransport: transport });
        const server = http.createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            request.body = JSON.parse(Buffer.concat(chunks).toString());
            request.user = { directories: { root: 'test-user' } };
            response.status = code => { response.statusCode = code; return response; };
            response.json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
            await handler(request, response);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        try {
            const model = 'gemini-4-argon';
            const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
            const targetUrl = source === 'vertexai'
                ? `https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/${model}:${endpoint}${stream ? '?alt=sse' : ''}`
                : `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}${stream ? '?alt=sse' : ''}`;
            const ticket = store.create({ source, model, stream, endpoint, tier: 'flex', region: source === 'vertexai' ? 'global' : undefined,
                targetUrl, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer mock-google-only' }, usageReference: { file: 'fixture', id: 'usage' } });
            const target = { location: { origin }, fetch: globalThis.fetch };
            installRequestTransport({ target, context: {}, origin, stateProvider: () => ({ tier: 'flex', paygoOnly: false }),
                serverClient: { prepare: async () => ({ proxyUrl: `${transport.baseUrl}/proxy/${ticket.ticket}`,
                    proxySecret: ticket.proxySecret, nativeGemini4: true, nativeGeminiApiVersion: 'v1beta' }) } });
            const response = await target.fetch(`${origin}/api/backends/chat-completions/generate`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream, chat_completion_source: source,
                    vertexai_auth_mode: 'express', vertexai_region: 'global', max_tokens: 64, include_reasoning: true,
                    reasoning_effort: 'medium', messages: [{ role: 'user', content: 'Question' }] }) });
            assert.equal(response.status, 200);
            let answer, signature;
            if (stream) {
                const state = { reasoning: '', images: [] };
                answer = '';
                for (const frame of (await response.text()).trim().split(/\r?\n\r?\n/u)) {
                    const value = JSON.parse(frame.slice(frame.indexOf('data:') + 5).trim());
                    answer += sandbox.getStreamingReply(value, state, { chatCompletionSource: source.toUpperCase(), overrideShowThoughts: true });
                }
                assert.equal(state.reasoning, 'think1think2');
                signature = state.signature;
            } else {
                const value = await response.json();
                answer = value.choices[0].message.content;
                assert.equal(sandbox.extractReasoningFromData(value, { mainApi: 'openai', chatCompletionSource: source.toUpperCase(), ignoreShowThoughts: true }), 'think1\n\nthink2');
                signature = value.nativeGeminiSignature;
            }
            assert.equal(answer, 'AB');
            assert.match(signature, /^st-vertex-paygo-text:v1:/u);
            const followup = await buildNativeGeminiBody({ model, chat_completion_source: source, max_tokens: 64,
                messages: [{ role: 'assistant', content: answer, signature }, { role: 'user', content: 'Next' }] }, runtime);
            const signedParts = followup.contents[0].parts.filter(part => part.thoughtSignature);
            assert.deepEqual(JSON.parse(JSON.stringify(signedParts)), [{ text: 'A', thoughtSignature: 'sig-A' }, { text: 'B', thoughtSignature: 'sig-B' }]);
            assert.equal(upstreamCalls.length, 2);
            assert.equal(upstreamCalls[1].body.continuationToken, 'next-hop');
            assert.equal(upstreamCalls[1].body.generationConfig.maxOutputTokens, 64);
            assert.deepEqual(upstreamCalls[0].body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'MEDIUM' });
            assert.equal(upstreamCalls[0].body.generationConfig.candidateCount, undefined);
            if (source === 'vertexai') assert.match(upstreamCalls[0].target, /\/v1beta1\//u);
            else assert.equal(upstreamCalls[0].body.service_tier, 'flex');
            assert.equal(ledger.at(-1).status, 'complete');
            assert.equal(ledger.at(-1).usage.promptTokenCount, 21);
            assert.equal(ledger.at(-1).usage.thoughtsTokenCount, 2);
        } finally {
            store.close();
            await transport.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
}
