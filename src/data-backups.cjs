/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { PluginError } = require('./errors.cjs');
const { validateSavedState } = require('./bridge-state-store.cjs');

const FILES = Object.freeze(['usage-ledger.jsonl', 'openai-bridge-state.json']);
const PREFIX = 'vertex-paygo-data_';
const ID = /^vertex-paygo-data_[0-9T-]+_[0-9a-f-]{36}\.pgbak$/u;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE = 96 * 1024 * 1024;
const HEADER_BYTES = 8192;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status = 409) => { throw new PluginError(status, code, message); };

// Resolve every child against the authenticated host directory. Existing links
// and hardlinked files are refused before any read, overwrite or deletion.
function safe(root, target) {
    const relative = path.relative(root, path.resolve(target));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('DATA_BACKUP_UNSAFE_PATH', 'The data backup path is unsafe.');
    let current = root;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
            fail('DATA_BACKUP_UNSAFE_PATH', 'The data backup path contains an unsupported link or file.');
        }
    }
    return target;
}

function owner(request) {
    const { directories, profile } = request?.user ?? {};
    if (typeof profile?.handle !== 'string' || !profile.handle || typeof directories?.root !== 'string' || !path.isAbsolute(directories.root)) {
        fail('DATA_BACKUP_AUTH_REQUIRED', 'An authenticated user is required.', 401);
    }
    const configuredRoot = path.resolve(directories.root);
    const configuredBackups = path.resolve(directories.backups ?? path.join(configuredRoot, 'backups'));
    const relativeBackups = path.relative(configuredRoot, configuredBackups);
    if (!relativeBackups || relativeBackups.startsWith('..') || path.isAbsolute(relativeBackups)) fail('DATA_BACKUP_UNSAFE_PATH', 'The host backup directory is outside the user directory.');
    const root = fs.realpathSync(configuredRoot);
    const backups = path.join(root, relativeBackups);
    safe(root, backups);
    const directory = safe(root, path.join(root, 'vertex-paygo'));
    return { root, backups, directory, handle: profile.handle, journal: path.join(directory, '.data-restore.json') };
}

function read(root, file, limit = MAX_ARCHIVE) {
    safe(root, file);
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) fail('DATA_BACKUP_TOO_LARGE', 'The data file exceeds the supported backup size.');
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count) fail('DATA_BACKUP_CHANGED', 'The data file changed while it was being read.');
            offset += count;
        }
        const after = fs.fstatSync(fd);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('DATA_BACKUP_CHANGED', 'The data file changed while it was being read.');
        return bytes;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function write(root, file, bytes) {
    safe(root, file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    safe(root, file);
    const temporary = path.join(path.dirname(file), `.paygo-data-${randomUUID()}.tmp`);
    let fd;
    try {
        fd = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(temporary, file);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function validateFiles(files) {
    if (files[0] !== null) {
        for (const line of files[0].toString('utf8').split('\n')) {
            if (!line) continue;
            const record = JSON.parse(line);
            if (!record || typeof record.id !== 'string') throw new Error('Invalid ledger record');
        }
    }
    if (files[1] !== null) {
        if (files[1].length > 16 * 1024) throw new Error('Invalid bridge state size');
        validateSavedState(JSON.parse(files[1].toString('utf8')));
    }
}

function descriptors(files) { return files.map((bytes, index) => ({ name: FILES[index], size: bytes?.length ?? null, sha256: bytes === null ? null : hash(bytes) })); }

// A small JSON header keeps listing cheap; the gzip body is read and checked
// only when creating, deduplicating or restoring a snapshot. No keys reach the UI.
function metadata(user, id) {
    if (!ID.test(id)) fail('DATA_BACKUP_INVALID_ID', 'The data backup identifier is invalid.', 400);
    const file = safe(user.root, path.join(user.backups, id));
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARCHIVE) throw new Error('Invalid backup file');
        const buffer = Buffer.alloc(HEADER_BYTES);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const end = buffer.subarray(0, count).indexOf(10);
        if (end < 0) throw new Error('Invalid header');
        const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        if (header.kind !== 'vertex-paygo-user-data' || header.schema !== 1 || header.owner !== user.handle
            || !Number.isFinite(Date.parse(header.createdAt)) || !['startup', 'update', 'before-restore'].includes(header.reason) || typeof header.restorable !== 'boolean'
            || !Array.isArray(header.files) || header.files.length !== FILES.length
            || header.files.some((entry, index) => entry.name !== FILES[index] || !(entry.size === null && entry.sha256 === null
                || Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_BYTES && /^[a-f0-9]{64}$/u.test(entry.sha256)))) throw new Error('Invalid header');
        return { id, header, offset: end + 1, size: stat.size };
    } finally { fs.closeSync(fd); }
}

function load(user, id, raw = false) {
    try {
        const info = metadata(user, id);
        const bytes = read(user.root, path.join(user.backups, id));
        const body = JSON.parse(gunzipSync(bytes.subarray(info.offset), { maxOutputLength: MAX_ARCHIVE }).toString('utf8'));
        if (!Array.isArray(body) || body.length !== FILES.length || body.some(item => item !== null && typeof item !== 'string')) throw new Error('Invalid payload');
        const files = body.map(item => item === null ? null : Buffer.from(item, 'base64'));
        if (JSON.stringify(descriptors(files)) !== JSON.stringify(info.header.files)) throw new Error('Checksum mismatch');
        if (!raw) validateFiles(files);
        return { ...info, files };
    } catch (cause) {
        if (cause instanceof PluginError && cause.code === 'DATA_BACKUP_UNSAFE_PATH') throw cause;
        fail('DATA_BACKUP_INVALID', 'The data backup is missing, damaged, incompatible, or belongs to another user.');
    }
}

function journal(user) {
    const bytes = read(user.root, user.journal, HEADER_BYTES);
    if (bytes === null) return null;
    try {
        const record = JSON.parse(bytes.toString('utf8'));
        if (!record || Object.keys(record).some(key => !['id', 'status', 'beforeId', 'beforeEmpty', 'code'].includes(key))
            || !['queued', 'applying', 'restored', 'failed'].includes(record.status) || !ID.test(record.id)
            || record.beforeId !== undefined && !ID.test(record.beforeId)
            || record.beforeEmpty !== undefined && typeof record.beforeEmpty !== 'boolean'
            || record.code !== undefined && !/^[A-Z_]{1,80}$/u.test(record.code)) throw new Error('Invalid restore record');
        return record;
    } catch { fail('DATA_RESTORE_INVALID', 'The pending data restore record is invalid.'); }
}

function entries(user) {
    if (!fs.existsSync(user.backups)) return [];
    safe(user.root, user.backups);
    return fs.readdirSync(user.backups).filter(id => ID.test(id)).map(id => {
        try { return metadata(user, id); } catch { return { id, invalid: true }; }
    }).sort((a, b) => (b.header?.createdAt ?? '').localeCompare(a.header?.createdAt ?? '') || b.id.localeCompare(a.id));
}

function rotate(user, retention, protectedIds = []) {
    const all = entries(user);
    let remaining = Math.max(0, retention - all.filter(entry => !entry.invalid && protectedIds.includes(entry.id)).length);
    for (const entry of all) {
        if (entry.invalid) continue;
        if (protectedIds.includes(entry.id) || remaining-- > 0) continue;
        // metadata establishes kind, schema and owner; safe rechecks the target.
        fs.unlinkSync(safe(user.root, path.join(user.backups, entry.id)));
    }
}

function snapshot(user, retention, reason, now, raw = false, protectedIds = []) {
    if (!Number.isSafeInteger(retention) || retention < 1) fail('DATA_BACKUP_DISABLED', 'Data backups require a positive host backup retention count.');
    const files = FILES.map(name => read(user.root, path.join(user.directory, name), MAX_BYTES));
    if (files.every(value => value === null)) return null;
    let restorable = true;
    try { validateFiles(files); } catch { restorable = false; }
    if (!raw && !restorable) fail('DATA_BACKUP_INVALID_DATA', 'The current PayGo data is damaged; existing backups were kept.');
    const description = descriptors(files);
    const latest = entries(user).find(entry => !entry.invalid);
    if (latest && JSON.stringify(latest.header.files) === JSON.stringify(description)) {
        let intact = false;
        try { load(user, latest.id, raw); intact = true; } catch (error) {
            if (error.code !== 'DATA_BACKUP_INVALID') throw error;
        }
        if (intact) {
            rotate(user, retention, protectedIds);
            return latest.id;
        }
    }
    const createdAt = now().toISOString();
    const id = `${PREFIX}${createdAt.replace(/[:.Z]/gu, '-')}_${randomUUID()}.pgbak`;
    const header = { kind: 'vertex-paygo-user-data', schema: 1, owner: user.handle, createdAt, reason, restorable, files: description };
    const bytes = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), gzipSync(Buffer.from(JSON.stringify(files.map(value => value?.toString('base64') ?? null))))]);
    if (bytes.length > MAX_ARCHIVE) fail('DATA_BACKUP_TOO_LARGE', 'The data snapshot exceeds the supported backup size.');
    write(user.root, path.join(user.backups, id), bytes);
    load(user, id, raw);
    rotate(user, retention, [...protectedIds, id]);
    return id;
}

function applyFiles(user, files) {
    for (const [index, name] of FILES.entries()) {
        const target = safe(user.root, path.join(user.directory, name));
        if (files[index] !== null) write(user.root, target, files[index]);
        else if (fs.existsSync(target)) fs.unlinkSync(target);
    }
}

function restorePending(user, retention, now) {
    const pending = journal(user);
    if (!pending || !['queued', 'applying'].includes(pending.status)) return false;
    try {
        if (pending.status === 'applying') throw new Error('Interrupted restore');
        const selected = load(user, pending.id);
        // Raw captures preserve even corrupt current files for undo and rollback.
        const beforeId = snapshot(user, retention, 'before-restore', now, true, [pending.id]);
        // An empty installation still needs an explicit rollback record.
        if (beforeId) pending.beforeId = beforeId;
        else {
            pending.beforeEmpty = true;
        }
        pending.status = 'applying';
        write(user.root, user.journal, JSON.stringify(pending));
        applyFiles(user, selected.files);
        write(user.root, user.journal, JSON.stringify({ ...pending, status: 'restored' }));
        pending.status = 'restored';
        return true;
    } catch (cause) {
        if (pending.status === 'applying') {
            try {
                if (pending.beforeId) applyFiles(user, load(user, pending.beforeId, true).files);
                else if (pending.beforeEmpty === true) applyFiles(user, [null, null]);
                else throw new Error('Missing rollback snapshot');
            } catch {
                fail('DATA_RESTORE_ROLLBACK_INCOMPLETE', 'The data restore was interrupted and rollback could not finish. Keep the backup files for recovery.', 500);
            }
        }
        pending.status = 'failed';
        pending.code = cause instanceof PluginError ? cause.code : 'DATA_RESTORE_INTERRUPTED';
        write(user.root, user.journal, JSON.stringify(pending));
        return false;
    }
}

function createDataBackups({ runtime, logStore, now = () => new Date() }) {
    const failures = new Map();
    const note = (handle, error) => {
        const code = error instanceof PluginError ? error.code : 'DATA_BACKUP_FAILED';
        failures.set(handle, code);
        try { logStore?.server('warn', 'data_backup_failed', { errorCode: code }); }
        catch { /* The original failure remains visible in the recovery report. */ }
    };
    async function captureAll(startup = false) {
        const { users, retention } = await runtime.dataBackupContext();
        failures.delete('*');
        for (const request of users) {
            try {
                const user = owner(request);
                if (startup && restorePending(user, retention, now)) {
                    const applied = journal(user);
                    try { rotate(user, retention, applied.beforeId ? [applied.beforeId] : []); }
                    catch (error) { note(user.handle, error); }
                    continue;
                }
                const pending = journal(user);
                snapshot(user, retention, startup ? 'startup' : 'update', now, false,
                    pending?.status === 'queued' ? [pending.id] : []);
                failures.delete(user.handle);
            } catch (error) {
                note(request.user.profile.handle, error);
                if (!startup || error.code === 'DATA_RESTORE_ROLLBACK_INCOMPLETE') throw error;
            }
        }
    }
    return {
        async initialize() {
            try { await captureAll(true); } catch (error) {
                if (error.code === 'DATA_RESTORE_ROLLBACK_INCOMPLETE') throw error;
                note('*', error);
            }
        },
        beforeUpdate: () => captureAll(),
        list(request, { limit = 20, cursor = null } = {}) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor !== null && !ID.test(cursor)) fail('DATA_BACKUP_INVALID_PAGE', 'The backup page is invalid.', 400);
            const user = owner(request);
            const all = entries(user);
            const offset = cursor === null ? 0 : all.findIndex(entry => entry.id === cursor) + 1;
            if (cursor !== null && offset === 0) fail('DATA_BACKUP_INVALID_PAGE', 'The backup page is no longer available.', 400);
            const page = all.slice(offset, offset + limit);
            let pending;
            try { pending = journal(user); } catch (error) {
                if (error.code !== 'DATA_RESTORE_INVALID') throw error;
                pending = { status: 'failed', code: 'DATA_RESTORE_INVALID' };
            }
            return { ok: true, entries: page.map(entry => ({ id: entry.id, createdAt: entry.header?.createdAt ?? null,
                reason: entry.header?.reason ?? null,
                restorable: !entry.invalid && entry.header.restorable, files: entry.header?.files.map(file => file.name).filter((_, index) => entry.header.files[index].size !== null) ?? [],
                size: entry.size ?? 0 })), pending,
                errorCode: failures.get(user.handle) ?? failures.get('*') ?? null,
                nextCursor: offset + page.length < all.length ? page.at(-1).id : null };
        },
        schedule(request, id) {
            const user = owner(request);
            load(user, id);
            const pending = journal(user);
            if (pending?.status === 'queued') {
                if (pending.id !== id) fail('DATA_RESTORE_PENDING', 'Cancel the pending restore before choosing another backup.');
                return { ok: true, restartRequired: true };
            }
            write(user.root, user.journal, JSON.stringify({ id, status: 'queued' }));
            return { ok: true, restartRequired: true };
        },
        cancel(request) {
            const user = owner(request);
            let pending;
            try { pending = journal(user); } catch (error) {
                if (error.code !== 'DATA_RESTORE_INVALID') throw error;
                pending = { status: 'failed' };
            }
            if (pending?.status === 'applying') fail('DATA_RESTORE_PENDING', 'The data restore is already being applied.');
            if (pending) fs.unlinkSync(safe(user.root, user.journal));
            return { ok: true };
        },
    };
}

module.exports = { createDataBackups, FILES };
