'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STORE_DIRECTORY = 'vertex-paygo';
const STORE_FILE = 'usage-ledger.jsonl';

function ledgerPathForUser(user) {
    const root = user?.directories?.root;
    if (typeof root !== 'string' || root.length === 0) return null;
    return path.join(path.resolve(root), STORE_DIRECTORY, STORE_FILE);
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseLimit(value) {
    if (value === undefined || value === null || value === '') return 200;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null;
}

function decodeCursor(value) {
    if (value === undefined || value === null || value === '') return { offset: 0, snapshot: undefined };
    try {
        const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !Number.isSafeInteger(parsed.snapshot) || parsed.snapshot < 0) return null;
        return parsed;
    } catch { return null; }
}

function encodeCursor(offset, snapshot) {
    return Buffer.from(JSON.stringify({ offset, snapshot })).toString('base64url');
}

class UsageStore {
    constructor({ fsModule = fs, now = () => Date.now(), pendingTimeoutMs = 35 * 60_000 } = {}) {
        this.fs = fsModule;
        this.now = now;
        this.pendingTimeoutMs = pendingTimeoutMs;
        this.activeIds = new Set();
        this.recoveredFiles = new Set();
        this.indexes = new Map();
    }

    #append(file, record) {
        this.fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    #read(file) {
        const cached = this.indexes.get(file);
        if (cached) return [...cached.values()];
        let text;
        try { text = this.fs.readFileSync(file, 'utf8'); }
        catch (error) {
            if (error?.code === 'ENOENT') {
                this.indexes.set(file, new Map());
                return [];
            }
            throw error;
        }
        const records = new Map();
        for (const line of text.split('\n')) {
            if (!line) continue;
            try {
                const record = JSON.parse(line);
                if (record && typeof record.id === 'string') records.set(record.id, record);
            } catch { /* Ignore a partial final append after an interrupted write. */ }
        }
        this.indexes.set(file, records);
        return [...records.values()];
    }

    #recover(file, records) {
        const firstAccess = !this.recoveredFiles.has(file);
        this.recoveredFiles.add(file);
        const cutoff = this.now() - this.pendingTimeoutMs;
        for (const record of records) {
            if (record.status === 'pending' && (firstAccess && !this.activeIds.has(record.id)
                || this.activeIds.has(record.id) && Date.parse(record.createdAt) <= cutoff)) {
                const timedOut = this.activeIds.has(record.id);
                const recovered = { ...record, status: 'incomplete', errorCode: timedOut ? 'USAGE_CAPTURE_TIMEOUT' : 'PROCESS_RESTARTED' };
                this.#append(file, recovered);
                Object.assign(record, recovered);
                this.indexes.get(file)?.set(record.id, recovered);
                this.activeIds.delete(record.id);
            }
        }
        return records;
    }

    create(user, details) {
        const file = ledgerPathForUser(user);
        if (!file || !details.chatId) return null;
        this.#recover(file, this.#read(file));
        const record = {
            id: randomUUID(), chatId: details.chatId, createdAt: new Date(this.now()).toISOString(),
            model: details.model, source: details.source, tier: details.tier, region: details.region,
            stream: details.stream, status: 'pending', usage: null, price: clone(details.price),
        };
        this.#append(file, record);
        this.indexes.get(file)?.set(record.id, record);
        this.activeIds.add(record.id);
        return { file, id: record.id, record: clone(record) };
    }

    update(reference, patch) {
        if (!reference?.file || !reference?.id) return;
        const record = this.#recover(reference.file, this.#read(reference.file)).find(candidate => candidate.id === reference.id);
        if (!record || record.status !== 'pending' || !this.activeIds.has(record.id)) return;
        const updated = { ...record };
        if (patch.usage !== undefined) updated.usage = clone(patch.usage);
        if (patch.status) updated.status = patch.status;
        if (patch.errorCode) updated.errorCode = patch.errorCode;
        else if (patch.status === 'complete') delete updated.errorCode;
        this.#append(reference.file, updated);
        this.indexes.get(reference.file)?.set(updated.id, updated);
        if (updated.status !== 'pending') this.activeIds.delete(updated.id);
    }

    list(user, chatId, options = undefined) {
        const file = ledgerPathForUser(user);
        if (!file) return null;
        const all = this.#recover(file, this.#read(file)).filter(record => record.chatId === chatId);
        if (options === undefined) return clone(all);
        const { cursor, limit } = options;
        const pageSize = parseLimit(limit);
        const position = decodeCursor(cursor);
        if (pageSize === null || !position) return null;
        const snapshot = position.snapshot === undefined ? all.length : Math.min(position.snapshot, all.length);
        const records = all.slice(0, snapshot);
        const page = records.slice(position.offset, position.offset + pageSize);
        const nextOffset = position.offset + page.length;
        const truncated = nextOffset < records.length;
        return {
            records: clone(page),
            ...(truncated ? { nextCursor: encodeCursor(nextOffset, snapshot), truncated: true } : {}),
        };
    }
}

module.exports = { STORE_DIRECTORY, STORE_FILE, UsageStore, ledgerPathForUser };
