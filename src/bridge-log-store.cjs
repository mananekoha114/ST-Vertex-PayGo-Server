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
// Match escaped JSON strings without parsing/reformatting whole JSON or SSE documents.
// If decoding reveals a credential, omit the field: source offsets are ambiguous in
// nested strings and truncated captures. Limit decoding passes to bound CPU work.
function redact(value, secrets) {
    let text = String(value ?? '');
    const known = [...new Set(secrets.filter(value => typeof value === 'string' && value.length))];
    const suffixLength = (value, secret) => {
        // KMP computes the longest credential prefix at the capture boundary in linear time.
        const prefix = new Uint32Array(secret.length);
        for (let i = 1, j = 0; i < secret.length; i++) {
            while (j && secret[i] !== secret[j]) j = prefix[j - 1];
            if (secret[i] === secret[j]) j++;
            prefix[i] = j;
        }
        let matched = 0;
        for (let i = Math.max(0, value.length - secret.length); i < value.length; i++) {
            while (matched && value[i] !== secret[matched]) matched = prefix[matched - 1];
            if (value[i] === secret[matched]) matched++;
            if (matched === secret.length && i < value.length - 1) matched = prefix[matched - 1];
        }
        return matched >= 4 ? matched : 0;
    };
    let decoded = text;
    const escape = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/gu;
    const controls = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    for (let pass = 0; known.length && pass < 8; pass++) {
        const next = decoded.replace(escape, match => match[1] === 'u' ? String.fromCharCode(parseInt(match.slice(2), 16)) : (controls[match[1]] ?? match[1]));
        if (next === decoded) break;
        decoded = next;
        if (known.some(secret => decoded.includes(secret) || suffixLength(decoded, secret))) return '[omitted: credential in escaped body]';
        if (pass === 7 && /\\/u.test(decoded)) return '[omitted: deeply escaped body]';
    }
    // An incomplete escape can hide the final character of a credential prefix.
    if (known.length && /\\(?:u[0-9a-fA-F]{0,3})?$/u.test(decoded)) return '[omitted: incomplete escaped body]';
    for (const secret of known) {
        text = text.split(secret).join('[redacted]');
        const length = suffixLength(text, secret);
        if (length) text = text.slice(0, -length) + '[redacted]';
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
