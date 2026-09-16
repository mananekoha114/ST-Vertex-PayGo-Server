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

test('reservations enforce total and per-user capacity before tickets are committed', () => {
    const store = new TicketStore({ maxEntries: 2, maxEntriesPerUser: 1 });
    try {
        const firstReservation = store.reserve('user-a');
        assert.equal(store.pendingSize, 1);
        assert.throws(() => store.reserve('user-a'), { code: 'USER_TICKET_CAPACITY_EXCEEDED' });
        const secondReservation = store.reserve('user-b');
        assert.equal(store.pendingSize, 2);
        assert.throws(() => store.reserve('user-c'), { code: 'TICKET_CAPACITY_EXCEEDED' });

        const first = store.commit(firstReservation, { sequence: 1 });
        store.release(secondReservation);
        assert.equal(store.pendingSize, 1);
        assert.deepEqual(store.consume(first.ticket, first.proxySecret), { sequence: 1 });
        assert.equal(store.pendingSize, 0);
    } finally {
        store.close();
    }
});

test('ticket issuance is rate limited per user and the window expires', () => {
    let now = 1_000;
    const store = new TicketStore({ maxIssuesPerWindow: 2, issueWindowMs: 100, now: () => now });
    try {
        const first = store.create({ sequence: 1 }, 'user-a');
        const second = store.create({ sequence: 2 }, 'user-a');
        assert.throws(() => store.create({ sequence: 3 }, 'user-a'), { code: 'TICKET_ISSUE_RATE_EXCEEDED' });
        // A different user has an independent issuance budget.
        assert.doesNotThrow(() => store.create({ sequence: 4 }, 'user-b'));
        now = 1_101;
        assert.doesNotThrow(() => store.create({ sequence: 5 }, 'user-a'));
        store.consume(first.ticket, first.proxySecret);
        store.consume(second.ticket, second.proxySecret);
    } finally {
        store.close();
    }
});

test('expired tickets and hung reservations release the user quota', () => {
    let now = 1_000;
    const store = new TicketStore({ ttlMs: 10, maxEntriesPerUser: 1, now: () => now });
    try {
        const issued = store.create({ sequence: 1 }, 'user-a');
        now = 1_010;
        assert.throws(() => store.consume(issued.ticket, issued.proxySecret), { code: 'EXPIRED_PROXY_TICKET' });
        assert.doesNotThrow(() => store.create({ sequence: 2 }, 'user-a'));

        const reservation = store.reserve('user-b');
        now = 1_021;
        store.cleanup();
        assert.equal(store.pendingSize, 0);
        assert.throws(() => store.commit(reservation, { sequence: 3 }), { code: 'TICKET_RESERVATION_INVALID' });
        assert.doesNotThrow(() => store.create({ sequence: 4 }, 'user-b'));
    } finally {
        store.close();
    }
});
