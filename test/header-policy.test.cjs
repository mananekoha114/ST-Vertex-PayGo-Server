'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    REQUEST_TYPE_HEADER,
    SERVER_TIMEOUT_HEADER,
    SHARED_REQUEST_TYPE_HEADER,
    buildPayGoHeaders,
} = require('../src/header-policy.cjs');

test('buildPayGoHeaders maps all supported tier and PayGo-only combinations', () => {
    assert.deepEqual(buildPayGoHeaders({ tier: 'standard', paygoOnly: false }), {});
    assert.deepEqual(buildPayGoHeaders({ tier: 'standard', paygoOnly: true }), {
        [REQUEST_TYPE_HEADER]: 'shared',
    });
    assert.deepEqual(buildPayGoHeaders({ tier: 'priority', paygoOnly: false }), {
        [SHARED_REQUEST_TYPE_HEADER]: 'priority',
    });
    assert.deepEqual(buildPayGoHeaders({ tier: 'priority', paygoOnly: true }), {
        [REQUEST_TYPE_HEADER]: 'shared',
        [SHARED_REQUEST_TYPE_HEADER]: 'priority',
    });
    assert.deepEqual(buildPayGoHeaders({ tier: 'flex', paygoOnly: false }), {
        [SHARED_REQUEST_TYPE_HEADER]: 'flex',
        [SERVER_TIMEOUT_HEADER]: '1800',
    });
    assert.deepEqual(buildPayGoHeaders({ tier: 'flex', paygoOnly: true }), {
        [REQUEST_TYPE_HEADER]: 'shared',
        [SHARED_REQUEST_TYPE_HEADER]: 'flex',
        [SERVER_TIMEOUT_HEADER]: '1800',
    });
});

test('buildPayGoHeaders rejects invalid internal state', () => {
    assert.throws(() => buildPayGoHeaders({ tier: 'turbo', paygoOnly: false }), { code: 'INVALID_HEADER_POLICY' });
    assert.throws(() => buildPayGoHeaders({ tier: 'standard', paygoOnly: 'yes' }), { code: 'INVALID_HEADER_POLICY' });
});
