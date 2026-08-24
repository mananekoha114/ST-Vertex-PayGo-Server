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
const { TicketStore } = require('../src/ticket-store.cjs');

test('tickets require their random secret and are consumed exactly once', () => {
    const store = new TicketStore();
    try {
        const issued = store.create({ model: 'gemini-2.5-pro' });
        assert.throws(() => store.consume(issued.ticket, 'wrong'), { code: 'INVALID_PROXY_SECRET' });
        assert.equal(store.size, 1);
        assert.deepEqual(store.consume(issued.ticket, issued.proxySecret), { model: 'gemini-2.5-pro' });
        assert.equal(store.size, 0);
        assert.throws(() => store.consume(issued.ticket, issued.proxySecret), { code: 'INVALID_PROXY_TICKET' });
    } finally {
        store.close();
    }
});

test('expired tickets are rejected and removed', () => {
    let now = 1_000;
    const store = new TicketStore({ ttlMs: 10, now: () => now });
    try {
        const issued = store.create({});
        now = 1_010;
        assert.throws(() => store.consume(issued.ticket, issued.proxySecret), { code: 'EXPIRED_PROXY_TICKET' });
        assert.equal(store.size, 0);
    } finally {
        store.close();
    }
});

test('capacity never evicts a still-valid ticket', () => {
    const store = new TicketStore({ maxEntries: 1 });
    try {
        const first = store.create({ sequence: 1 });
        assert.throws(() => store.create({ sequence: 2 }), { code: 'TICKET_CAPACITY_EXCEEDED' });
        assert.deepEqual(store.consume(first.ticket, first.proxySecret), { sequence: 1 });
    } finally {
        store.close();
    }
});

test('synchronous validation happens before atomic consumption', () => {
    const store = new TicketStore();
    try {
        const issued = store.create({ model: 'gemini-2.5-pro' });
        assert.throws(() => store.consume(issued.ticket, issued.proxySecret, () => {
            const error = new Error('suffix mismatch');
            error.code = 'SUFFIX_MISMATCH';
            throw error;
        }), { code: 'SUFFIX_MISMATCH' });
        assert.equal(store.size, 1);
        assert.deepEqual(store.consume(issued.ticket, issued.proxySecret, data => {
            assert.equal(data.model, 'gemini-2.5-pro');
        }), { model: 'gemini-2.5-pro' });
    } finally {
        store.close();
    }
});

test('default ticket lifetime is five minutes', () => {
    const now = 50_000;
    const store = new TicketStore({ now: () => now });
    try {
        const issued = store.create({});
        assert.equal(issued.expiresAt - now, 5 * 60_000);
    } finally {
        store.close();
    }
});
