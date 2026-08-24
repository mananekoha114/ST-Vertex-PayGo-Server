/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const crypto = require('node:crypto');
const { PluginError } = require('./errors.cjs');

class TicketStore {
    constructor({
        ttlMs = 5 * 60_000,
        maxEntries = 256,
        now = Date.now,
        randomBytes = crypto.randomBytes,
        cleanupIntervalMs = Math.min(ttlMs, 10_000),
    } = {}) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
            throw new TypeError('Invalid ticket store limits.');
        }
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.now = now;
        this.randomBytes = randomBytes;
        this.entries = new Map();
        this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
        this.cleanupTimer.unref?.();
    }

    create(data) {
        this.cleanup();
        if (this.entries.size >= this.maxEntries) {
            throw new PluginError(503, 'TICKET_CAPACITY_EXCEEDED', 'The proxy ticket capacity is temporarily exhausted.');
        }

        let ticket;
        for (let attempt = 0; attempt < 8; attempt++) {
            ticket = this.randomBytes(24).toString('base64url');
            if (!this.entries.has(ticket)) break;
            ticket = undefined;
        }
        if (!ticket) {
            throw new PluginError(503, 'TICKET_GENERATION_FAILED', 'Could not allocate a proxy ticket.');
        }

        const proxySecret = this.randomBytes(32).toString('base64url');
        const expiresAt = this.now() + this.ttlMs;
        this.entries.set(ticket, Object.freeze({
            data: Object.freeze({ ...data }),
            proxySecret,
            expiresAt,
        }));
        return Object.freeze({ ticket, proxySecret, expiresAt });
    }

    consume(ticket, suppliedSecret, validator = undefined) {
        const entry = this.entries.get(ticket);
        if (!entry) {
            throw new PluginError(404, 'INVALID_PROXY_TICKET', 'The proxy ticket is invalid or has already been used.');
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(ticket);
            throw new PluginError(410, 'EXPIRED_PROXY_TICKET', 'The proxy ticket has expired.');
        }
        if (typeof suppliedSecret !== 'string') {
            throw new PluginError(401, 'INVALID_PROXY_SECRET', 'The proxy credential is invalid.');
        }

        const expected = Buffer.from(entry.proxySecret, 'utf8');
        const supplied = Buffer.from(suppliedSecret, 'utf8');
        if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
            throw new PluginError(401, 'INVALID_PROXY_SECRET', 'The proxy credential is invalid.');
        }

        if (validator !== undefined) {
            if (typeof validator !== 'function') throw new TypeError('Ticket validator must be a function.');
            const result = validator(entry.data);
            if (result && typeof result.then === 'function') {
                throw new TypeError('Ticket validator must be synchronous.');
            }
        }

        // JavaScript executes validation and deletion synchronously, so only one caller
        // can successfully consume a ticket even under concurrent requests. A malformed
        // suffix does not burn an otherwise valid ticket.
        this.entries.delete(ticket);
        return entry.data;
    }

    cleanup() {
        const currentTime = this.now();
        for (const [ticket, entry] of this.entries) {
            if (entry.expiresAt <= currentTime) {
                this.entries.delete(ticket);
            }
        }
    }

    close() {
        clearInterval(this.cleanupTimer);
        this.entries.clear();
    }

    get size() {
        return this.entries.size;
    }
}

module.exports = { TicketStore };
