/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_CAPTURE_BYTES = 1024 * 1024;
function redact(value, secrets) {
    let text = String(value ?? '');
    for (const secret of secrets.filter(value => typeof value === 'string' && value.length)) {
        text = text.split(secret).join('[redacted]');
        // Capture may stop in the middle of a known credential. Remove its partial suffix too.
        for (let length = Math.min(secret.length - 1, text.length); length >= 4; length--) {
            if (text.endsWith(secret.slice(0, length))) { text = text.slice(0, -length) + '[redacted]'; break; }
        }
    }
    return text;
}
// Dedicated per-user JSON store. Writes and clears are serialized, atomic and bounded.
class BridgeLogStore {
    constructor({ maxEntries = 50, maxBytes = 20 * 1024 * 1024 } = {}) {
        this.maxEntries = Math.max(1, Math.min(50, maxEntries));
        this.maxBytes = Math.max(1024, Math.min(20 * 1024 * 1024, maxBytes));
        this.queues = new Map();
        this.pendingWrites = 0;
        this.pendingUsers = new Map();
    }
    file(directories) {
        if (typeof directories?.root !== 'string' || !directories.root) throw new Error('Authenticated user root required');
        return path.join(directories.root, 'vertex-paygo', 'openai-bridge-logs.json');
    }
    async locked(file, action) {
        const prior = this.queues.get(file) || Promise.resolve();
        const next = prior.catch(() => {}).then(action);
        this.queues.set(file, next);
        try {
            return await next;
        } finally {
            if (this.queues.get(file) === next) this.queues.delete(file);
        }
    }
    async load(file) {
        try {
            if ((await fs.stat(file)).size > this.maxBytes) return [];
            const value = JSON.parse(await fs.readFile(file, 'utf8'));
            return Array.isArray(value) ? value.slice(0, this.maxEntries) : [];
        } catch (cause) {
            if (cause.code === 'ENOENT' || cause instanceof SyntaxError) return [];
            throw cause;
        }
    }
    async read(directories) {
        const file = this.file(directories);
        return this.locked(file, () => this.load(file));
    }
    async save(file, entries) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
            await fs.rename(temporary, file);
        } finally {
            await fs.unlink(temporary).catch(() => {});
        }
    }
    async append(directories, entry, secrets = []) {
        const file = this.file(directories);
        // Drop excess pending log writes rather than queue unbounded request bodies during slow disk I/O.
        const pendingUser = this.pendingUsers.get(file) || 0;
        if (this.pendingWrites >= 16 || pendingUser >= 4) return;
        this.pendingWrites++;
        this.pendingUsers.set(file, pendingUser + 1);
        try {
            return await this.locked(file, async () => {
                const safe = { ...entry };
                for (const field of ['path', 'requestBody', 'forwardedBody', 'responseBody', 'upstreamResponseBody', 'error']) {
                    if (safe[field] === null || safe[field] === undefined) continue;
                    const text = redact(safe[field], secrets);
                    const bytes = Buffer.from(text);
                    if (bytes.length > MAX_CAPTURE_BYTES) safe.truncated = true;
                    safe[field] = bytes.subarray(0, MAX_CAPTURE_BYTES).toString('utf8');
                }
                const entries = [safe, ...await this.load(file)].slice(0, this.maxEntries);
                while (entries.length && Buffer.byteLength(JSON.stringify(entries)) > this.maxBytes) entries.pop();
                await this.save(file, entries);
            });
        } finally {
            this.pendingWrites--;
            const remaining = this.pendingUsers.get(file) - 1;
            if (remaining) this.pendingUsers.set(file, remaining); else this.pendingUsers.delete(file);
        }
    }
    async clear(directories) {
        const file = this.file(directories);
        return this.locked(file, async () => {
            await this.save(file, []);
            return [];
        });
    }
}
module.exports = { BridgeLogStore, MAX_CAPTURE_BYTES, redact };
