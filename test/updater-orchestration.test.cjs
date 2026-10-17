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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createUpdater } = require('../src/updater/index.cjs');
const { createGitOperations } = require('../src/updater/git-operations.cjs');
const { createDataBackups } = require('../src/data-backups.cjs');

const FRONTEND_REMOTE = 'https://github.com/mananekoha114/ST-Vertex-PayGo.git';
const SERVER_REMOTE = 'https://github.com/mananekoha114/ST-Vertex-PayGo-Server.git';
const FRONTEND_OLD = 'a'.repeat(40);
const SERVER_OLD = 'b'.repeat(40);
const FRONTEND_TIP = 'c'.repeat(40);
const SERVER_TIP = 'd'.repeat(40);

function chain(...oids) {
    return oids.map((oid, index) => ({ oid, parents: oids.slice(index + 1, index + 2), timestamp: oids.length - index }));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

function writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function makeHost() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-orchestration-'));
    writeJson(path.join(root, 'package.json'), { name: 'luker', version: '2.8.0' });
    const frontend = path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo');
    writeJson(path.join(frontend, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers', js: 'index.js', css: 'style.css' });
    writeText(path.join(frontend, 'index.js'), 'old frontend\n');
    writeText(path.join(frontend, 'style.css'), 'old styles\n');
    const server = path.join(root, 'plugins', 'ST-Vertex-PayGo-Server');
    writeJson(path.join(server, 'package.json'), { name: 'st-vertex-paygo-server', main: 'index.cjs' });
    writeText(path.join(server, 'index.cjs'), 'old server\n');
    return { root, frontend, server };
}

// A Git port with no network and no repository: the two things an update must
// learn from Git are supplied directly, and materialize writes the payload a
// real checkout would have produced.
function makeGitOperations({ frontendState, serverState }) {
    const states = new Map([[frontendState.directory, frontendState], [serverState.directory, serverState]]);
    return {
        async listRemoteTags(url) {
            return url === FRONTEND_REMOTE
                ? [{ name: 'v0.5.0', commit: FRONTEND_TIP }]
                : [{ name: 'v0.5.0', commit: SERVER_TIP }];
        },
        async readInstallation(directory) {
            return states.get(directory);
        },
        async stagedClone({ url, directory }) {
            fs.mkdirSync(directory, { recursive: true });
            return url === FRONTEND_REMOTE
                ? { branchHead: FRONTEND_TIP, history: chain(FRONTEND_TIP, FRONTEND_OLD) }
                : { branchHead: SERVER_TIP, history: chain(SERVER_TIP, SERVER_OLD) };
        },
        async materialize({ directory }) {
            if (path.basename(directory) === 'frontend') {
                writeJson(path.join(directory, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers', js: 'index.js', css: 'style.css' });
                writeText(path.join(directory, 'index.js'), 'new frontend\n');
                writeText(path.join(directory, 'style.css'), 'new styles\n');
            } else {
                writeJson(path.join(directory, 'package.json'), { name: 'st-vertex-paygo-server', main: 'index.cjs' });
                writeText(path.join(directory, 'index.cjs'), 'new server\n');
            }
        },
        writeMetadata(directory, record) {
            writeJson(path.join(directory, '.git', 'paygo-updater.json'), { schema: 1, ...record });
        },
        async isAncestor({ older, newer }) {
            if (older === newer) return true;
            return (older === FRONTEND_OLD && newer === FRONTEND_TIP) || (older === SERVER_OLD && newer === SERVER_TIP);
        },
    };
}

function installation(directory, { head, metadata, remote, dirtyTrackedCount = 0, isRepository = true, branch = 'main' }) {
    return { directory, isRepository, head, branch, dirtyTrackedCount, metadata, remoteUrl: remote };
}

function makeUpdater(host, overrides = {}, operations = {}, context = {}) {
    return createUpdater({
        commandLine: { dataRoot: './data', configPath: './config.yaml' },
        rootDir: host.root,
        now: () => new Date('2026-10-15T00:00:00.000Z'),
        gitOperations: { ...makeGitOperations({
            frontendState: installation(host.frontend, { head: FRONTEND_OLD, metadata: null, remote: FRONTEND_REMOTE }),
            serverState: installation(host.server, { head: SERVER_OLD, metadata: null, remote: SERVER_REMOTE }),
            ...overrides,
        }), ...operations },
        ...context,
    });
}

test('data snapshots run only for a real update and before installed files change', async () => {
    const host = makeHost(); let captures = 0;
    try {
        const updater = makeUpdater(host, {}, {}, { dataBackups: { beforeUpdate() {
            captures++;
            assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
            assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
        } } });
        await updater.check(); assert.equal(captures, 0);
        await updater.start(); assert.equal(captures, 1);
        assert.equal(updater.status().lastResult.status, 'updated');
    } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('a failed data snapshot stops code replacement and preserves the installed pair', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {}, {}, { dataBackups: { beforeUpdate() { throw new Error('snapshot write failed'); } } });
        await updater.start();
        assert.equal(updater.status().lastResult.status, 'failed');
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
        assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
        assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
    } finally { fs.rmSync(host.root, { recursive: true, force: true }); }
});

test('an update replaces both components, records the channel, and keeps a usable backup', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host);

        const report = await updater.check();
        assert.equal(report.status, 'update-available');
        assert.deepEqual(report.components.map(component => component.name), ['frontend', 'server']);
        assert.deepEqual(report.components.map(component => component.status), ['update', 'update']);
        assert.equal(report.components[0].target.tag, 'v0.5.0');
        // A check must not touch the installation.
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');

        const result = await updater.start();
        assert.equal(result.status, 'updated');
        assert.equal(result.restartRequired, true);
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'new frontend\n');
        assert.equal(fs.readFileSync(path.join(host.frontend, 'style.css'), 'utf8'), 'new styles\n');
        assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'new server\n');

        const metadata = JSON.parse(fs.readFileSync(path.join(host.frontend, '.git', 'paygo-updater.json'), 'utf8'));
        assert.deepEqual(metadata, { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: FRONTEND_TIP });

        const restore = JSON.parse(fs.readFileSync(path.join(result.backup, 'restore.json'), 'utf8'));
        assert.deepEqual(restore.components.map(component => component.name), ['frontend', 'server']);
        assert.equal(fs.readFileSync(path.join(result.backup, 'frontend', 'index.js'), 'utf8'), 'old frontend\n');

        // No lock or staging directory survives a successful update.
        assert.deepEqual(fs.readdirSync(host.root).filter(name => name.startsWith('.paygo-install')).sort(), ['.paygo-install-backups']);
        assert.equal(updater.status().running, false);
        assert.equal(updater.status().lastResult.status, 'updated');
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('APK updates stage, lock, back up and replace inside external data storage', async t => {
    const host = makeHost();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-apk-storage-'));
    t.after(() => { fs.rmSync(host.root, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); });
    const oldFrontend = host.frontend;
    const oldServer = host.server;
    host.frontend = path.join(data, 'extensions', 'frontend');
    host.server = path.join(data, 'plugins', 'server');
    fs.mkdirSync(path.dirname(host.frontend), { recursive: true });
    fs.mkdirSync(path.dirname(host.server), { recursive: true });
    fs.renameSync(oldFrontend, host.frontend);
    fs.renameSync(oldServer, host.server);
    const values = { dataRoot: data, serverPluginsPath: path.dirname(host.server), globalExtensionsPath: path.dirname(host.frontend) };
    const updater = makeUpdater(host, {}, {
        async listRemoteTags(url) {
            assert.equal(fs.existsSync(path.join(data, '.paygo-install.lock')), true);
            assert.equal(fs.existsSync(path.join(host.root, '.paygo-install.lock')), false);
            return [{ name: 'v0.5.0', commit: url === FRONTEND_REMOTE ? FRONTEND_TIP : SERVER_TIP }];
        },
    }, { commandLine: { ...values, configPath: './external.yaml' }, pluginDirectory: host.server });
    const result = await updater.start();
    assert.equal(result.status, 'updated', result.message);
    assert.equal(path.dirname(path.dirname(result.backup)), data);
    assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'new server\n');
    const restore = JSON.parse(fs.readFileSync(path.join(result.backup, 'restore.json'), 'utf8'));
    assert.equal(restore.host, data);
    assert.ok(restore.components.every(c => c.staged.startsWith(path.join(data, '.paygo-install-stage-'))));
    assert.deepEqual(fs.readdirSync(data).filter(n => n.startsWith('.paygo-install')), ['.paygo-install-backups']);
    assert.deepEqual(fs.readdirSync(host.root).filter(n => n.startsWith('.paygo-install')), []);
});

test('a job keeps one host directory snapshot throughout preparation and activation', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    let reads = 0;
    const commandLine = { dataRoot: './data', configPath: './config.yaml', get serverPluginsPath() {
        reads++;
        return reads === 1 ? './plugins' : './changed-plugins';
    } };
    const result = await makeUpdater(host, {}, {}, { commandLine }).start();
    assert.equal(result.status, 'updated', result.message);
    assert.equal(reads, 1);
});

test('a blocked component stops the whole update instead of shipping half a release', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {
            frontendState: installation(host.frontend, { head: null, metadata: null, remote: null, isRepository: false }),
        });
        const report = await updater.check();
        assert.equal(report.status, 'blocked');
        assert.equal(report.components[0].status, 'not-a-repository');
        assert.match(report.components[0].reason, /not a Git checkout/u);

        // The job runs in the background, so a refusal is recorded as its
        // outcome rather than thrown at the caller that started it.
        const result = await updater.start();
        assert.equal(result.status, 'failed');
        assert.equal(result.code, 'UPDATER_COMPONENT_BLOCKED');
        assert.match(result.message, /not a Git checkout/u);
        assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
        assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('an installation already on the selected release is left alone', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {
            frontendState: installation(host.frontend, {
                head: FRONTEND_TIP,
                metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: FRONTEND_TIP },
                remote: FRONTEND_REMOTE,
                branch: null,
            }),
            serverState: installation(host.server, {
                head: SERVER_TIP,
                metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: SERVER_TIP },
                remote: SERVER_REMOTE,
                branch: null,
            }),
        });
        const report = await updater.check();
        assert.equal(report.status, 'up-to-date');
        assert.deepEqual(report.components.map(component => component.status), ['unchanged', 'unchanged']);

        const result = await updater.start();
        assert.equal(result.status, 'no-change');
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
        assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('a copy installed from a different origin is reported but still updated from the official one', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {
            frontendState: installation(host.frontend, { head: FRONTEND_OLD, metadata: null, remote: 'https://example.invalid/fork.git' }),
        });
        const report = await updater.check();
        assert.equal(report.components[0].originMismatch, true);
        assert.equal(report.components[1].originMismatch, false);
        const result = await updater.start();
        assert.equal(result.status, 'updated');
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('asynchronous ancestry rejects a local-only revision before replacing either component', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {
        frontendState: installation(host.frontend, { head: 'e'.repeat(40), remote: FRONTEND_REMOTE }),
    });
    await assert.rejects(updater.check(), error => error.code === 'UPDATER_LOCAL_COMMITS');
    assert.equal((await updater.start()).code, 'UPDATER_LOCAL_COMMITS');
    assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
    assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
    assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
});

test('main installations ahead of the latest tags are kept even without metadata', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {
        frontendState: installation(host.frontend, { head: FRONTEND_TIP, remote: FRONTEND_REMOTE }),
        serverState: installation(host.server, { head: SERVER_TIP, remote: SERVER_REMOTE }),
    }, {
        async listRemoteTags(url) {
            return [{ name: 'v0.4.0', commit: url === FRONTEND_REMOTE ? FRONTEND_OLD : SERVER_OLD }];
        },
    });
    const report = await updater.check();
    assert.equal(report.status, 'up-to-date');
    assert.deepEqual(report.components.map(c => c.status), ['keep-ahead', 'keep-ahead']);
    assert.equal((await updater.start()).status, 'no-change');
});

test('main metadata in commit mode still plans the release tag, not unreleased commits', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {
        frontendState: installation(host.frontend, { head: FRONTEND_OLD, remote: FRONTEND_REMOTE,
            metadata: { schema: 1, branch: 'main', mode: 'commit', tag: null, commit: FRONTEND_OLD } }),
        serverState: installation(host.server, { head: SERVER_OLD, remote: SERVER_REMOTE,
            metadata: { schema: 1, branch: 'main', mode: 'commit', tag: null, commit: SERVER_OLD } }),
    }, {
        async listRemoteTags(url) {
            return [{ name: 'v0.5.0', commit: url === FRONTEND_REMOTE ? FRONTEND_OLD : SERVER_OLD }];
        },
    });
    const report = await updater.check();
    assert.deepEqual(report.components.map(c => c.channel.mode), ['tag', 'tag']);
    assert.deepEqual(report.components.map(c => c.target.commit), [FRONTEND_OLD, SERVER_OLD]);
});

test('different release tags refuse the pair before activation', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {}, {
        async listRemoteTags(url) {
            return [{ name: url === FRONTEND_REMOTE ? 'v0.5.1' : 'v0.5.0', commit: url === FRONTEND_REMOTE ? FRONTEND_TIP : SERVER_TIP }];
        },
    });
    await assert.rejects(updater.check(), error => error.code === 'UPDATER_TAG_MISMATCH');
    assert.equal((await updater.start()).code, 'UPDATER_TAG_MISMATCH');
    assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
});

test('development channels plan branch-head updates without a release tag', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {
        frontendState: installation(host.frontend, { head: FRONTEND_OLD, branch: 'dev', remote: FRONTEND_REMOTE }),
        serverState: installation(host.server, { head: SERVER_OLD, branch: 'dev', remote: SERVER_REMOTE }),
    });
    const report = await updater.check();
    assert.equal(report.status, 'update-available');
    assert.deepEqual(report.components.map(c => c.target.tag), [null, null]);
    assert.equal((await updater.start()).status, 'updated');
});

test('a failed second download leaves both installed components unchanged and releases the lock', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {}, {
        async stagedClone({ url, directory }) {
            if (url === SERVER_REMOTE) throw new Error('fixture download failed');
            fs.mkdirSync(directory, { recursive: true });
            return { branchHead: FRONTEND_TIP, history: chain(FRONTEND_TIP, FRONTEND_OLD) };
        },
    });
    assert.equal((await updater.start()).status, 'failed');
    assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
    assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
    assert.deepEqual(fs.readdirSync(host.root).filter(name => name.startsWith('.paygo-install')), []);
});

test('edits made during preparation are detected before either installation is moved', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    let reads = 0;
    const updater = makeUpdater(host, {}, {
        async readInstallation(directory) {
            const frontend = directory === host.frontend;
            reads += 1;
            return installation(directory, { head: frontend ? FRONTEND_OLD : SERVER_OLD,
                remote: frontend ? FRONTEND_REMOTE : SERVER_REMOTE, dirtyTrackedCount: reads > 2 ? 1 : 0 });
        },
    });
    const result = await updater.start();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'UPDATER_INSTALLATION_CHANGED');
    assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
});

test('the installation lock covers preparation and concurrent starts are refused', async t => {
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const updater = makeUpdater(host, {}, {
        async listRemoteTags(url) {
            assert.equal(fs.existsSync(path.join(host.root, '.paygo-install.lock')), true);
            return [{ name: 'v0.5.0', commit: url === FRONTEND_REMOTE ? FRONTEND_TIP : SERVER_TIP }];
        },
    });
    const task = updater.start();
    assert.throws(() => updater.start(), error => error.code === 'UPDATER_IN_PROGRESS');
    assert.equal((await task).status, 'updated');
});

test('a clean Git tree with backed-up data inside a component is refused before downloads', async t => {
    if (spawnSync('git', ['--version']).status !== 0) return t.skip('System Git is required for the clean-tree comparison.');
    const host = makeHost();
    t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
    const dataRoot = path.join(host.server, 'node_modules', 'host-data');
    const userRoot = path.join(dataRoot, 'alice');
    const ledger = path.join(userRoot, 'vertex-paygo', 'usage-ledger.jsonl');
    writeText(ledger, '{"id":"saved-record"}\n');
    writeText(path.join(host.server, '.gitignore'), 'node_modules/\n');
    const git = args => {
        const result = spawnSync('git', args, { cwd: host.server, encoding: 'utf8', env: {
            ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
        } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git(['init', '-q', '-b', 'main']);
    git(['add', '.']);
    git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const user = { user: { profile: { handle: 'alice' }, directories: {
        root: userRoot, backups: path.join(userRoot, 'backups'),
    } } };
    const dataBackups = createDataBackups({ runtime: { dataBackupContext: async () => ({ users: [user], retention: 2 }) } });
    await dataBackups.initialize();
    const snapshot = dataBackups.list(user).entries[0];
    assert.equal(snapshot.restorable, true);
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal((await createGitOperations().readInstallation(host.server)).dirtyTrackedCount, 0);
    let downloads = 0;
    const commandLine = { dataRoot, configPath: path.join(host.root, 'config.yaml') };
    const updater = makeUpdater(host, {}, {
        async listRemoteTags(url) {
            downloads++;
            return [{ name: 'v0.5.0', commit: url === FRONTEND_REMOTE ? FRONTEND_TIP : SERVER_TIP }];
        },
    }, { dataBackups, commandLine });
    const result = await updater.start();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'UPDATER_UNSAFE_PATH');
    assert.equal(downloads, 0);
    assert.equal(fs.readFileSync(ledger, 'utf8'), '{"id":"saved-record"}\n');
    assert.equal(fs.existsSync(path.join(userRoot, 'backups', snapshot.id)), true);
    assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
    assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
    assert.deepEqual(fs.readdirSync(host.root).filter(name => name.startsWith('.paygo-install')), []);
});

test('a second activation failure restores both installed components and reports the transaction error', async () => {
    const host = makeHost();
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (to === host.server && path.dirname(from).includes('.paygo-install-stage-')) {
            const error = new Error('fixture second activation failed');
            error.code = 'EIO';
            throw error;
        }
        return rename(from, to);
    };
    try {
        const result = await makeUpdater(host).start();
        assert.equal(result.status, 'failed');
        assert.equal(result.code, 'UPDATER_ACTIVATION_FAILED');
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
        assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
        assert.equal(fs.existsSync(path.join(host.root, '.paygo-install.lock')), false);
    } finally {
        fs.renameSync = rename;
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});
