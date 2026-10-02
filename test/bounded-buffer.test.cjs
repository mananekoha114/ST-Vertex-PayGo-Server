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
const { BoundedBuffer } = require('../src/bounded-buffer.cjs');
test('one-byte chunks retain fixed block counts, preserve bytes and cannot exceed their bound', () => {
    const size = 128 * 1024;
    const old = [];
    const bounded = new BoundedBuffer(size);
    for (let i = 0; i < size; i++) {
        const byte = Buffer.from([i % 256]);
        old.push(byte);
        assert.equal(bounded.append(byte), true);
    }
    assert.equal(old.length, 131072);
    assert.equal(bounded.blocks.length, 2);
    assert.equal(bounded.size, size);
    assert.deepEqual(bounded.toBuffer(), Buffer.concat(old));
    assert.equal(bounded.append(Buffer.from('overflow')), false);
    assert.equal(bounded.size, size);
    assert.equal(bounded.blocks.length, 2);
});
test('partial last block and oversized chunks never return uninitialized bytes', () => {
    const bounded = new BoundedBuffer(9, 4);
    assert.equal(bounded.append(Buffer.from('abc')), true);
    assert.equal(bounded.toBuffer().toString(), 'abc');
    assert.equal(bounded.append(Buffer.from('defghijkl')), false);
    assert.equal(bounded.toBuffer().toString(), 'abcdefghi');
    assert.equal(bounded.blocks.length, 3);
    assert.equal(new BoundedBuffer(0).append(Buffer.from('x')), false);
    assert.equal(new BoundedBuffer(0).toBuffer().length, 0);
});
test('bridge preserves raw tiny-chunk UTF-8 responses, captures and forwarded request JSON', async t => {
    const http = require('node:http');
    const { PassThrough } = require('node:stream');
    const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
    let recorded;
    let forwarded;
    const raw = 'data: ' + JSON.stringify({
        content: '猫'.repeat(24000)
    }) + '\n\ndata: [DONE]\n\n';
    const expected = Buffer.from(raw);
    const bridge = createOpenAIBridge({
        bridgeLogStore: {
            append(_d, e) {
                recorded = e;
            }
        },
        stRuntime: {
            resolveOpenAIConnection(_r, c) {
                return {
                    connection: c
                }
            }, async getOpenAIConfig() {
                return {
                    target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: {
                        Authorization: 'Bearer fake-key'
                    }
                }
            }
        },
        upstreamRequest(_url, _opts, callback) {
            const sink = new PassThrough();
            const chunks = [];
            sink.on('data', c => chunks.push(c));
            sink.on('finish', () => {
                forwarded = JSON.parse(Buffer.concat(chunks));
                const source = new PassThrough();
                source.statusCode = 200;
                source.headers = {
                    'content-type': 'text/event-stream'
                };
                callback(source);
                for (let i = 0; i < expected.length; i++) {
                    source.write(expected.subarray(i, i + 1));
                }
                source.end();
            });
            return sink;
        }
    });
    const server = http.createServer((q, r) => bridge.route(q, r));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => {
        bridge.close();
        server.close();
    });
    bridge.setBaseUrl('http://127.0.0.1:' + server.address().port);
    let config;
    await bridge.update({
        user: {
            directories: {
                root: 'tiny-test'
            }
        },
        body: {
            enabled: true, connection: {
                source: 'makersuite', model: 'gemini-2.5-flash'
            }
        }
    }, {
        set() {
        },
        json(v) {
            config = v;
        }
    });
    const body = ' {"messages":[{"role":"user","content":"猫"}],"model":"st-current"} ';
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/openai/v1/chat/completions', {
        method: 'POST', headers: {
            Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json'
        }, body
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    for (let i = 0; i < 100 && !recorded; i++) {
        await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(recorded.responseBody, raw);
    assert.equal(recorded.requestBody, body);
    assert.equal(recorded.truncated, false);
    assert.equal(forwarded.messages[0].content, '猫');
});
test('model discovery reconstructs one-byte catalogs across UTF-8 boundaries', async () => {
    const { PassThrough } = require('node:stream');
    const { discoverModels } = require('../src/openai-models.cjs');
    const body = Buffer.from(JSON.stringify({
        data: [{
            id: 'gemini-2.5-flash', description: '猫'
        }]
    }));
    const catalog = await discoverModels({
        config: {
            target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: {
                Authorization: 'Bearer fake-key'
            }
        },
        connection: {
            source: 'makersuite', model: 'gemini-2.5-flash'
        },
        operation: {
            terminal: false
        },
        upstreamRequest(_url, _options, callback) {
            const request = new PassThrough();
            request.on('finish', () => {
                const response = new PassThrough();
                response.statusCode = 200;
                response.headers = {
                };
                callback(response);
                for (let i = 0; i < body.length; i++) {
                    response.write(body.subarray(i, i + 1));
                }
                response.end();
            });
            return request;
        }
    });
    assert.ok(catalog.data.some(item => item.id === 'gemini-2.5-flash'));
});
