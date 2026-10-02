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
const { redact } = require('../src/bridge-log-store.cjs');
test('redaction handles unicode, nested JSON, partial escapes and linear credential suffix matching', () => {
    const secret = 'fake-google-key-1234';
    const unicode = '{"content":"\\u0066ake-google-key-1234"}';
    assert.equal(redact(unicode, [secret]), '[omitted: credential in escaped body]');
    const key = '-----BEGIN PRIVATE KEY-----\nFAKE-PRIVATE-KEY\n-----END PRIVATE KEY-----\n';
    const nested = JSON.stringify({
        content: JSON.stringify({
            private_key: key
        })
    });
    assert.equal(redact(nested, [key]), '[omitted: credential in escaped body]');
    assert.equal(redact('prefix \\u0066ake-google-key-', [secret]), '[omitted: credential in escaped body]');
    assert.equal(redact('prefix \\u00', [secret]), '[omitted: incomplete escaped body]');
    assert.equal(redact('body fake-google-key-', [secret]), 'body [redacted]');
    assert.equal(redact('{"content":"hello\\nworld"}', [secret]), '{"content":"hello\\nworld"}');
    assert.equal(redact('a'.repeat(1024 * 1024), ['a'.repeat(2048) + 'b']).endsWith('[redacted]'), true);
});
test('named Vertex private keys are redacted on early failures without exposing credential material', async t => {
    const http = require('node:http');
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
    const { BridgeLogStore } = require('../src/bridge-log-store.cjs');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-named-redact-'));
    t.after(() => fs.rm(root, {
        recursive: true, force: true
    }));
    const key = '-----BEGIN PRIVATE KEY-----\nFAKE-PRIVATE-KEY\n-----END PRIVATE KEY-----\n';
    const credential = JSON.stringify({
        project_id: 'fake-project', private_key: key
    });
    const store = new BridgeLogStore();
    let configured;
    const bridge = createOpenAIBridge({
        bridgeLogStore: store, stRuntime: {
            resolveOpenAIConnection(_r, c) {
                return {
                    connection: {
                        ...c, secretId: 'named-id'
                    },
                    credentialSnapshot: undefined, logCredential: credential
                }
            }, async getOpenAIConfig() {
                return {
                    target: 'https://us-central1-aiplatform.googleapis.com/v1/projects/fake-project/locations/us-central1/endpoints/openapi/chat/completions', logCredential: credential
                }
            }
        }
    });
    bridge.setBaseUrl('http://127.0.0.1:18443');
    await bridge.update({
        user: {
            directories: {
                root
            }
        },
        body: {
            enabled: true, connection: {
                source: 'vertexai', model: 'gemini-2.5-flash', authMode: 'full', region: 'us-central1'
            }
        }
    }, {
        set() {
        },
        status() {
            return this
        },
        json(v) {
            configured = v;
        }
    });
    assert.equal(configured.connection.secretId, 'named-id');
    assert.ok(!JSON.stringify(configured).includes('FAKE-PRIVATE-KEY'));
    const server = http.createServer((q, r) => bridge.route(q, r));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => {
        bridge.close();
        server.close();
    });
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/openai/v1/chat/completions', {
        method: 'POST', headers: {
            Authorization: 'Bearer ' + configured.apiKey, 'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messages: [{
                role: 'user', content: credential
            }], headers: {
            }
        })
    });
    assert.equal(response.status, 400);
    await response.text();
    let entries = [];
    for (let i = 0; i < 100 && !entries.length; i++) {
        await new Promise(r => setTimeout(r, 5));
        entries = await store.read({
            root
        })
    }
    assert.equal(entries.length, 1);
    assert.ok(!JSON.stringify(entries).includes('FAKE-PRIVATE-KEY'));
    assert.match(entries[0].requestBody, /omitted/);
});
