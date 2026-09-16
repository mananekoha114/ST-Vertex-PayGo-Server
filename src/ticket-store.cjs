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
        maxEntriesPerUser = 32,
        maxIssuesPerWindow = 30,
        issueWindowMs = 60_000,
        now = Date.now,
        randomBytes = crypto.randomBytes,
        cleanupIntervalMs = Math.min(ttlMs, 10_000),
    } = {}) {
        if (!Number.isSafeInteger(ttlMs) || ttlMs < 1
            || !Number.isSafeInteger(maxEntries) || maxEntries < 1
            || !Number.isSafeInteger(maxEntriesPerUser) || maxEntriesPerUser < 1
            || !Number.isSafeInteger(maxIssuesPerWindow) || maxIssuesPerWindow < 1
            || !Number.isSafeInteger(issueWindowMs) || issueWindowMs < 1) {
            throw new TypeError('Invalid ticket store limits.');
        }
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.maxEntriesPerUser = maxEntriesPerUser;
        this.maxIssuesPerWindow = maxIssuesPerWindow;
        this.issueWindowMs = issueWindowMs;
        this.now = now;
        this.randomBytes = randomBytes;
        this.entries = new Map();
        this.reservations = new Map();
        this.userEntries = new Map();
        this.issueTimes = new Map();
        this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
        this.cleanupTimer.unref?.();
    }

    create(data, ownerKey = 'anonymous') {
        const reservation = this.reserve(ownerKey);
        try {
            return this.commit(reservation, data);
        } catch (error) {
            this.release(reservation);
            throw error;
        }
    }

    reserve(ownerKey = 'anonymous') {
        this.cleanup();
        const normalizedOwnerKey = normalizeOwnerKey(ownerKey);
        const ownedCount = this.userEntries.get(normalizedOwnerKey) || 0;
        if (this.entries.size + this.reservations.size >= this.maxEntries) {
            throw new PluginError(503, 'TICKET_CAPACITY_EXCEEDED', 'The proxy ticket capacity is temporarily exhausted.');
        }
        if (ownedCount >= this.maxEntriesPerUser) {
            throw new PluginError(429, 'USER_TICKET_CAPACITY_EXCEEDED', 'This user has too many pending proxy tickets.');
        }

        const currentTime = this.now();
        const recentIssues = (this.issueTimes.get(normalizedOwnerKey) || [])
            .filter(timestamp => timestamp > currentTime - this.issueWindowMs);
        if (recentIssues.length >= this.maxIssuesPerWindow) {
            this.issueTimes.set(normalizedOwnerKey, recentIssues);
            throw new PluginError(429, 'TICKET_ISSUE_RATE_EXCEEDED', 'Proxy ticket issuance is temporarily rate limited.');
        }
        recentIssues.push(currentTime);
        this.issueTimes.set(normalizedOwnerKey, recentIssues);

        const reservationWithExpiry = Object.freeze({
            ownerKey: normalizedOwnerKey,
            expiresAt: currentTime + this.ttlMs,
        });
        this.reservations.set(reservationWithExpiry, reservationWithExpiry);
        this.userEntries.set(normalizedOwnerKey, ownedCount + 1);
        return reservationWithExpiry;
    }

    commit(reservation, data) {
        const storedReservation = this.reservations.get(reservation);
        if (!storedReservation) {
            throw new PluginError(409, 'TICKET_RESERVATION_INVALID', 'The proxy ticket reservation is invalid or has expired.');
        }
        if (storedReservation.expiresAt <= this.now()) {
            this.release(reservation);
            throw new PluginError(409, 'TICKET_RESERVATION_EXPIRED', 'The proxy ticket reservation has expired.');
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
        this.reservations.delete(reservation);
        this.entries.set(ticket, Object.freeze({
            data: Object.freeze({ ...data }),
            proxySecret,
            expiresAt,
            ownerKey: storedReservation.ownerKey,
        }));
        return Object.freeze({ ticket, proxySecret, expiresAt });
    }

    release(reservation) {
        const storedReservation = this.reservations.get(reservation);
        if (!storedReservation) return false;
        this.reservations.delete(reservation);
        this.#decrementUser(storedReservation.ownerKey);
        return true;
    }

    consume(ticket, suppliedSecret, validator = undefined) {
        const entry = this.entries.get(ticket);
        if (!entry) {
            throw new PluginError(404, 'INVALID_PROXY_TICKET', 'The proxy ticket is invalid or has already been used.');
        }
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(ticket);
            this.#decrementUser(entry.ownerKey);
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
        this.#decrementUser(entry.ownerKey);
        return entry.data;
    }

    cleanup() {
        const currentTime = this.now();
        for (const [ticket, entry] of this.entries) {
            if (entry.expiresAt <= currentTime) {
                this.entries.delete(ticket);
                this.#decrementUser(entry.ownerKey);
            }
        }
        for (const [reservation, entry] of this.reservations) {
            if (entry.expiresAt <= currentTime) {
                this.reservations.delete(reservation);
                this.#decrementUser(entry.ownerKey);
            }
        }
        for (const [ownerKey, timestamps] of this.issueTimes) {
            const recent = timestamps.filter(timestamp => timestamp > currentTime - this.issueWindowMs);
            if (recent.length > 0) this.issueTimes.set(ownerKey, recent);
            else this.issueTimes.delete(ownerKey);
        }
    }

    close() {
        clearInterval(this.cleanupTimer);
        this.entries.clear();
        this.reservations.clear();
        this.userEntries.clear();
        this.issueTimes.clear();
    }

    get size() {
        return this.entries.size;
    }

    get pendingSize() {
        return this.entries.size + this.reservations.size;
    }

    #decrementUser(ownerKey) {
        const count = this.userEntries.get(ownerKey) || 0;
        if (count <= 1) this.userEntries.delete(ownerKey);
        else this.userEntries.set(ownerKey, count - 1);
    }
}

function normalizeOwnerKey(ownerKey) {
    if (typeof ownerKey !== 'string' || ownerKey.length === 0 || ownerKey.length > 512) {
        throw new TypeError('Invalid ticket owner key.');
    }
    return ownerKey;
}

module.exports = { TicketStore };
