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
const { validatePreparePayload } = require('../src/protocol.cjs');
const {
    prepareGoogleHeaders,
    prepareGoogleTarget,
    validatePreparedGoogleTarget,
} = require('../src/target-policy.cjs');

function validBody(overrides = {}) {
    return {
        protocolVersion: 2,
        chat_completion_source: 'vertexai',
        model: 'gemini-2.5-pro',
        stream: true,
        tier: 'flex',
        paygoOnly: false,
        vertexai_auth_mode: 'full',
        vertexai_region: 'global',
        ...overrides,
    };
}

test('prepare protocol accepts a canonical Vertex Gemini request', () => {
    assert.deepEqual(validatePreparePayload(validBody()), {
        protocolVersion: 2,
        source: 'vertexai',
        model: 'gemini-2.5-pro',
        region: 'global',
        authMode: 'full',
        stream: true,
        tier: 'flex',
        paygoOnly: false,
        expressProjectId: undefined,
        secretId: undefined,
        usageChatId: undefined,
        usagePrice: null,
    });
});

test('prepare protocol fails closed on non-Gemini, regional premium tier, and proxy fields', () => {
    assert.throws(() => validatePreparePayload(validBody({ model: 'claude-sonnet-4' })), { code: 'INVALID_PREPARE_REQUEST' });
    assert.throws(() => validatePreparePayload(validBody({ vertexai_region: 'us-central1' })), { code: 'GLOBAL_REGION_REQUIRED' });
    assert.throws(() => validatePreparePayload(validBody({ reverse_proxy: 'https://example.test' })), { code: 'UPSTREAM_PROXY_UNSUPPORTED' });
    assert.equal(validatePreparePayload(validBody({ tier: 'standard', paygoOnly: false })).tier, 'standard');
});

test('target policy allows only the exact region host, model endpoint, and stream query', () => {
    const config = { model: 'gemini-2.5-pro', region: 'global', stream: true };
    const prepared = prepareGoogleTarget(
        'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent',
        config,
    );
    assert.equal(new URL(prepared).search, '?alt=sse');
    assert.equal(validatePreparedGoogleTarget(prepared, config).hostname, 'aiplatform.googleapis.com');
    assert.throws(() => prepareGoogleTarget(
        'https://evil.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent',
        config,
    ), { code: 'UNSAFE_GOOGLE_TARGET' });
    assert.throws(() => prepareGoogleTarget(
        'https://aiplatform.googleapis.com/v1/unexpected/publishers/google/models/gemini-2.5-pro:streamGenerateContent',
        config,
    ), { code: 'UNSAFE_GOOGLE_TARGET' });
    assert.throws(() => validatePreparedGoogleTarget(prepared.replace('alt=sse', 'alt=json'), config), { code: 'UNSAFE_GOOGLE_TARGET' });
});

test('target policy accepts the exact regional Vertex host and rejects a mismatched host', () => {
    const config = { model: 'gemini-2.5-flash', region: 'us-central1', stream: false };
    const prepared = prepareGoogleTarget(
        'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
        config,
    );
    assert.equal(validatePreparedGoogleTarget(prepared, config).hostname, 'us-central1-aiplatform.googleapis.com');
    assert.throws(() => prepareGoogleTarget(
        'https://europe-west4-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent',
        config,
    ), { code: 'UNSAFE_GOOGLE_TARGET' });
});

test('target header policy accepts only ST Vertex authentication headers', () => {
    assert.deepEqual(prepareGoogleHeaders(
        { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        { 'X-Vertex-AI-LLM-Shared-Request-Type': 'priority' },
    ), {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
        'X-Vertex-AI-LLM-Shared-Request-Type': 'priority',
    });
    assert.throws(() => prepareGoogleHeaders({ Authorization: 'Bearer token', Host: 'evil.test' }, {}), { code: 'UNSAFE_GOOGLE_HEADERS' });
    assert.throws(() => prepareGoogleHeaders({ 'Content-Type': 'application/json' }, {}), { code: 'UNSAFE_GOOGLE_HEADERS' });
});
