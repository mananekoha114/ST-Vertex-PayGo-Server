/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createDataBackups, FILES } = require('../src/data-backups.cjs');
const { registerDataBackupRoutes } = require('../src/data-backup-routes.cjs');

function fixture(t, retention = 2) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-data-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const request = handle => {
        const directory = path.join(root, handle);
        fs.mkdirSync(directory, { recursive: true });
        return { user: { profile: { handle }, directories: { root: directory, backups: path.join(directory, 'backups') } } };
    };
    const alice = request('alice'), bob = request('bob');
    let tick = Date.now();
    const logs = [];
    const context = { users: [alice, bob], retention };
    const runtime = { dataBackupContext: async () => context };
    const make = () => createDataBackups({ runtime, now: () => new Date(++tick), logStore: { server(...args) { logs.push(args); } } });
    const file = (user, name) => path.join(user.user.directories.root, 'vertex-paygo', name);
    const put = (user, text) => {
        fs.mkdirSync(path.dirname(file(user, FILES[0])), { recursive: true });
        fs.writeFileSync(file(user, FILES[0]), JSON.stringify({ id: text, status: 'complete', chatId: 'test' }) + '\n');
        fs.writeFileSync(file(user, FILES[1]), JSON.stringify({ schema: 1, enabled: false }));
    };
    return { root, alice, bob, make, file, put, context, logs };
}

test('startup snapshots are private, deduplicated and metadata-only; empty users need no archive', async t => {
    const f = fixture(t); f.put(f.alice, 'first');
    const state = { schema: 1, enabled: true, key: 'A'.repeat(43), connection: { source: 'makersuite', model: 'gemini', secretId: 'test-id' },
        mode: 'openai', tierSource: 'independent', tier: 'standard', debugLocalAccess: false };
    fs.writeFileSync(f.file(f.alice, FILES[1]), JSON.stringify(state));
    const service = f.make(); await service.initialize();
    const report = service.list(f.alice);
    assert.equal(report.entries.length, 1); assert.equal(report.entries[0].restorable, true);
    assert.deepEqual(report.entries[0].files, FILES);
    assert.equal(JSON.stringify(report).includes(state.key), false);
    assert.equal(JSON.stringify(report).includes(f.root), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.alice.user.directories.backups, report.entries[0].id)).mode & 0o777, 0o600);
    await service.beforeUpdate(); await f.make().initialize();
    assert.equal(service.list(f.alice).entries.length, 1);
    assert.equal(service.list(f.bob).entries.length, 0);
});

test('rotation keeps the configured number and never touches unrelated or foreign-owner files', async t => {
    const f = fixture(t); f.put(f.alice, '1'); f.put(f.bob, 'b');
    const service = f.make(); await service.initialize();
    const directory = f.alice.user.directories.backups;
    const foreign = service.list(f.bob).entries[0].id;
    fs.copyFileSync(path.join(f.bob.user.directories.backups, foreign), path.join(directory, foreign));
    fs.writeFileSync(path.join(directory, 'settings_alice_test.json'), 'unrelated');
    for (const value of ['2', '3', '4']) { f.put(f.alice, value); await service.beforeUpdate(); }
    const entries = service.list(f.alice).entries;
    assert.equal(entries.filter(entry => entry.restorable).length, 2);
    assert.equal(fs.readFileSync(path.join(directory, 'settings_alice_test.json'), 'utf8'), 'unrelated');
    assert.equal(fs.existsSync(path.join(directory, foreign)), true);
});

test('restore is queued and cancellable, and applies exact bytes only after restart', async t => {
    const f = fixture(t); f.put(f.alice, 'old');
    const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id;
    const old = FILES.map(name => fs.readFileSync(f.file(f.alice, name)));
    f.put(f.alice, 'new');
    assert.equal(service.schedule(f.alice, id).restartRequired, true);
    assert.equal(service.schedule(f.alice, id).restartRequired, true);
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /new/u);
    service.cancel(f.alice); assert.equal(service.list(f.alice).pending, null);
    service.schedule(f.alice, id);
    const restarted = f.make(); await restarted.initialize();
    for (const [index, name] of FILES.entries()) assert.deepEqual(fs.readFileSync(f.file(f.alice, name)), old[index]);
    assert.equal(restarted.list(f.alice).pending.status, 'restored');
    const undo = restarted.list(f.alice).entries.find(entry => entry.id !== id);
    assert.ok(undo);
    restarted.schedule(f.alice, undo.id); await f.make().initialize();
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /new/u);
});

test('queued restore remains protected during later backups and conflicts require cancellation', async t => {
    const f = fixture(t, 1); f.put(f.alice, 'old');
    const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id; service.schedule(f.alice, id);
    f.put(f.alice, 'next'); await service.beforeUpdate();
    const other = service.list(f.alice).entries.find(entry => entry.id !== id).id;
    assert.throws(() => service.schedule(f.alice, other), { code: 'DATA_RESTORE_PENDING' });
    f.put(f.alice, 'newest'); await service.beforeUpdate();
    assert.ok(service.list(f.alice).entries.some(entry => entry.id === id));
    await f.make().initialize();
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /old/u);
    assert.equal(service.list(f.alice).entries.length, 1);
});

test('valid backups can restore damaged current files while preserving raw undo material', async t => {
    const f = fixture(t); f.put(f.alice, 'valid');
    const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id;
    fs.writeFileSync(f.file(f.alice, FILES[0]), '{broken');
    await assert.rejects(service.beforeUpdate(), { code: 'DATA_BACKUP_INVALID_DATA' });
    service.schedule(f.alice, id); await f.make().initialize();
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /valid/u);
    assert.ok(service.list(f.alice).entries.some(entry => !entry.restorable));
});

test('restore into an empty installation has a valid journal and no fake rollback snapshot', async t => {
    const f = fixture(t); f.put(f.alice, 'saved');
    const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id;
    for (const name of FILES) fs.unlinkSync(f.file(f.alice, name));
    service.schedule(f.alice, id); await f.make().initialize();
    assert.equal(service.list(f.alice).pending.status, 'restored');
    await f.make().initialize();
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /saved/u);
});

test('damaged archives fail explicitly and a fresh snapshot replaces a corrupt duplicate', async t => {
    const f = fixture(t, 1); f.put(f.alice, 'original');
    const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id;
    const filename = path.join(f.alice.user.directories.backups, id);
    fs.truncateSync(filename, fs.statSync(filename).size - 5);
    assert.throws(() => service.schedule(f.alice, id), { code: 'DATA_BACKUP_INVALID' });
    await service.beforeUpdate();
    const replacement = service.list(f.alice).entries[0].id;
    assert.notEqual(replacement, id); service.schedule(f.alice, replacement);
});

test('disabled backup configuration reports failure and preserves previous backups', async t => {
    const f = fixture(t); f.put(f.alice, 'original');
    const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id;
    f.context.retention = 0; f.put(f.alice, 'changed');
    await assert.rejects(service.beforeUpdate(), { code: 'DATA_BACKUP_DISABLED' });
    const restarted = f.make(); await restarted.initialize();
    assert.equal(restarted.list(f.alice).errorCode, 'DATA_BACKUP_DISABLED');
    assert.equal(restarted.list(f.alice).entries[0].id, id);
});

test('untrusted paths, other users and malformed paging are refused', async t => {
    const f = fixture(t); f.put(f.alice, 'private');
    const service = f.make(); await service.initialize(); const id = service.list(f.alice).entries[0].id;
    assert.throws(() => service.list({}), { code: 'DATA_BACKUP_AUTH_REQUIRED' });
    assert.throws(() => service.schedule(f.bob, id), { code: 'DATA_BACKUP_INVALID' });
    assert.throws(() => service.schedule(f.alice, '../secrets.json'), { code: 'DATA_BACKUP_INVALID' });
    assert.throws(() => service.list(f.alice, { limit: 0 }), { code: 'DATA_BACKUP_INVALID_PAGE' });
});

test('file symlinks cannot redirect backup reads outside the user data', async t => {
    const f = fixture(t); f.put(f.alice, 'private');
    const outside = path.join(f.root, 'external'); fs.writeFileSync(outside, 'untouched');
    const file = f.file(f.alice, FILES[0]); fs.unlinkSync(file);
    try { fs.symlinkSync(outside, file, 'file'); } catch (error) {
        if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) { t.skip('File symlink creation is unavailable: ' + error.code); return; }
        throw error;
    }
    await assert.rejects(f.make().beforeUpdate(), { code: 'DATA_BACKUP_UNSAFE_PATH' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('hardlinked data files are refused on filesystems that support creating hardlinks', async t => {
    const f = fixture(t); f.put(f.alice, 'private');
    const source = path.join(f.root, 'external'); fs.writeFileSync(source, 'untouched');
    const file = f.file(f.alice, FILES[0]); fs.unlinkSync(file);
    try { fs.linkSync(source, file); } catch (error) {
        if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) { t.skip('Hardlink creation is unavailable: ' + error.code); return; }
        throw error;
    }
    await assert.rejects(f.make().beforeUpdate(), { code: 'DATA_BACKUP_UNSAFE_PATH' });
});

test('a replacement error rolls back both files and remains visibly failed', async t => {
    const f = fixture(t); f.put(f.alice, 'old'); const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id; f.put(f.alice, 'current'); service.schedule(f.alice, id);
    const original = fs.renameSync; let failed = false;
    fs.renameSync = (from, to) => {
        if (!failed && to === f.file(f.alice, FILES[1])) { failed = true; throw Object.assign(new Error('injected'), { code: 'EACCES' }); }
        return original(from, to);
    };
    try { await f.make().initialize(); } finally { fs.renameSync = original; }
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /current/u);
    assert.equal(service.list(f.alice).pending.status, 'failed');
});

test('a process killed between replacements rolls back on the next startup', async t => {
    const f = fixture(t); f.put(f.alice, 'old'); const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id; f.put(f.alice, 'current'); service.schedule(f.alice, id);
    const source = `const fs=require('node:fs');const real=fs.renameSync;fs.renameSync=(a,b)=>{real(a,b);if(b===${JSON.stringify(f.file(f.alice, FILES[0]))})process.kill(process.pid,'SIGKILL')};require(${JSON.stringify(require.resolve('../src/data-backups.cjs'))}).createDataBackups({runtime:{dataBackupContext:async()=>(${JSON.stringify(f.context)})}}).initialize();`;
    const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.error, undefined, child.stderr);
    // Windows reports a forced termination as exit code 1 rather than a signal.
    assert.equal(child.status, process.platform === 'win32' ? 1 : null, child.stderr);
    assert.equal(child.signal, process.platform === 'win32' ? null : 'SIGKILL');
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /old/u);
    assert.equal(JSON.parse(fs.readFileSync(f.file(f.alice, '.data-restore.json'), 'utf8')).status, 'applying');
    await f.make().initialize();
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /current/u);
    assert.equal(service.list(f.alice).pending.status, 'failed');
});

test('routes inherit authentication and expose only scoped data operations', async t => {
    const f = fixture(t); f.put(f.alice, 'data'); const service = f.make(); await service.initialize();
    const handlers = new Map();
    registerDataBackupRoutes({ get: (p, h) => handlers.set('GET ' + p, h), post: (p, h) => handlers.set('POST ' + p, h) }, service);
    function response() { return { statusCode: 200, set() {}, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } }; }
    const denied = response(); handlers.get('GET /data-backups')({}, denied); assert.equal(denied.statusCode, 401);
    const page = response(); handlers.get('GET /data-backups')({ ...f.alice, query: { limit: '1' } }, page); assert.equal(page.body.entries.length, 1);
    const bad = response(); handlers.get('POST /data-restore')({ ...f.alice, body: { backupId: page.body.entries[0].id, user: 'bob' } }, bad); assert.equal(bad.statusCode, 400);
});

test('a failed snapshot write leaves the prior valid snapshot available', async t => {
    const f = fixture(t, 1); f.put(f.alice, 'old'); const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id; f.put(f.alice, 'new');
    const original = fs.writeFileSync;
    fs.writeFileSync = () => { throw Object.assign(new Error('injected disk error'), { code: 'ENOSPC' }); };
    try { await assert.rejects(service.beforeUpdate(), { code: 'ENOSPC' }); } finally { fs.writeFileSync = original; }
    assert.equal(service.list(f.alice).entries[0].id, id);
    service.schedule(f.alice, id);
});

test('a damaged pending record is reported and can be cancelled without deleting data', async t => {
    const f = fixture(t); f.put(f.alice, 'current'); const service = f.make(); await service.initialize();
    fs.writeFileSync(f.file(f.alice, '.data-restore.json'), '{broken');
    const state = service.list(f.alice);
    assert.equal(state.pending.status, 'failed'); assert.equal(state.pending.code, 'DATA_RESTORE_INVALID');
    service.cancel(f.alice); assert.equal(service.list(f.alice).pending, null);
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /current/u);
});

test('failure to commit the restored journal rolls back data instead of publishing false completion', async t => {
    const f = fixture(t); f.put(f.alice, 'old'); const service = f.make(); await service.initialize();
    const id = service.list(f.alice).entries[0].id; f.put(f.alice, 'current'); service.schedule(f.alice, id);
    const original = fs.writeFileSync; let failed = false;
    fs.writeFileSync = (file, bytes, ...rest) => {
        if (!failed && String(bytes).includes('"status":"restored"')) { failed = true; throw new Error('journal commit failed'); }
        return original(file, bytes, ...rest);
    };
    try { await f.make().initialize(); } finally { fs.writeFileSync = original; }
    assert.equal(failed, true);
    assert.match(fs.readFileSync(f.file(f.alice, FILES[0]), 'utf8'), /current/u);
    assert.equal(service.list(f.alice).pending.status, 'failed');
});
