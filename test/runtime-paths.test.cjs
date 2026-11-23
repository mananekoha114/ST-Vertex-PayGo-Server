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
const { RUNTIME_SUBDIR, resolveRuntimePaths } = require('../src/runtime-paths.cjs');

function makeTempDir(prefix = 'vertex-paygo-paths-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('resolveRuntimePaths follows env -> dataRoot/vertex-paygo -> hostRoot priority', t => {
    const root = makeTempDir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // 1. Default fallback to hostRoot
    const fallback = resolveRuntimePaths({ hostRoot: root, env: {}, commandLine: {}, dataRootGlobal: undefined });
    assert.deepEqual(fallback, {
        hostRoot: root,
        logDir: root,
        configDir: root,
        legacyRootDir: root,
    });

    // 2. dataRootGlobal resolved relative to hostRoot
    const fromGlobal = resolveRuntimePaths({
        hostRoot: root,
        env: {},
        commandLine: { dataRoot: '   ' },
        dataRootGlobal: 'global-data',
    });
    const expectedGlobalDir = path.join(root, 'global-data', RUNTIME_SUBDIR);
    assert.deepEqual(fromGlobal, {
        hostRoot: root,
        logDir: expectedGlobalDir,
        configDir: expectedGlobalDir,
        legacyRootDir: root,
    });
    assert.equal(fs.statSync(expectedGlobalDir).isDirectory(), true);

    // 3. commandLine.dataRoot overrides dataRootGlobal
    const fromCli = resolveRuntimePaths({
        hostRoot: root,
        env: {},
        commandLine: { dataRoot: 'cli-data' },
        dataRootGlobal: 'global-data',
    });
    const expectedCliDir = path.join(root, 'cli-data', RUNTIME_SUBDIR);
    assert.deepEqual(fromCli, {
        hostRoot: root,
        logDir: expectedCliDir,
        configDir: expectedCliDir,
        legacyRootDir: root,
    });
    assert.equal(fs.statSync(expectedCliDir).isDirectory(), true);

    // 4. ST_VERTEX_PAYGO_DATA_DIR overrides dataRoot for both logDir and configDir
    const fromDataEnv = resolveRuntimePaths({
        hostRoot: root,
        env: { ST_VERTEX_PAYGO_DATA_DIR: 'env-data' },
        commandLine: { dataRoot: 'cli-data' },
        dataRootGlobal: 'global-data',
    });
    const expectedDataEnvDir = path.join(root, 'env-data');
    assert.deepEqual(fromDataEnv, {
        hostRoot: root,
        logDir: expectedDataEnvDir,
        configDir: expectedDataEnvDir,
        legacyRootDir: root,
    });
    assert.equal(fs.statSync(expectedDataEnvDir).isDirectory(), true);

    // 5. ST_VERTEX_PAYGO_LOG_DIR overrides logDir independently of configDir
    const customLogDir = path.join(root, 'separate-logs');
    const fromLogEnv = resolveRuntimePaths({
        hostRoot: root,
        env: {
            ST_VERTEX_PAYGO_LOG_DIR: customLogDir,
            ST_VERTEX_PAYGO_DATA_DIR: 'env-data',
        },
        commandLine: { dataRoot: 'cli-data' },
    });
    assert.deepEqual(fromLogEnv, {
        hostRoot: root,
        logDir: customLogDir,
        configDir: expectedDataEnvDir,
        legacyRootDir: root,
    });
    assert.equal(fs.statSync(customLogDir).isDirectory(), true);

    // 6. ST_VERTEX_PAYGO_LOG_DIR with dataRoot keeps configDir under dataRoot/vertex-paygo
    const fromLogAndCli = resolveRuntimePaths({
        hostRoot: root,
        env: { ST_VERTEX_PAYGO_LOG_DIR: 'only-logs' },
        commandLine: { dataRoot: 'cli-data' },
    });
    assert.deepEqual(fromLogAndCli, {
        hostRoot: root,
        logDir: path.join(root, 'only-logs'),
        configDir: expectedCliDir,
        legacyRootDir: root,
    });
});

test('resolveRuntimePaths refuses symlinked target and ancestor directories', t => {
    const root = makeTempDir();
    const outside = makeTempDir('vertex-paygo-outside-');
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    const linkDir = path.join(root, 'linked-dir');
    try {
        fs.symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
            t.skip(`Directory symlink creation unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    // Target directory itself is a symlink
    assert.throws(() => resolveRuntimePaths({
        hostRoot: root,
        env: { ST_VERTEX_PAYGO_DATA_DIR: linkDir },
    }), { code: 'RUNTIME_PATH_UNSAFE' });

    // Ancestor directory is a symlink (nested vertex-paygo does not exist yet)
    assert.throws(() => resolveRuntimePaths({
        hostRoot: root,
        env: {},
        commandLine: { dataRoot: linkDir },
    }), { code: 'RUNTIME_PATH_UNSAFE' });

    assert.equal(fs.existsSync(path.join(outside, RUNTIME_SUBDIR)), false);
});

test('resolveRuntimePaths refuses symlinks reported by fsModule.lstatSync', () => {
    const root = path.resolve(os.tmpdir(), 'fake-host-root');
    const symlinkAncestor = path.join(root, 'bad-link');
    const nestedTarget = path.join(symlinkAncestor, 'logs');
    const fsModule = {
        lstatSync(candidate) {
            if (candidate === symlinkAncestor) {
                return { isSymbolicLink: () => true };
            }
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
        },
        mkdirSync() {
            throw new Error('mkdirSync must not run after symlink detection');
        },
    };

    assert.throws(() => resolveRuntimePaths({
        hostRoot: root,
        env: { ST_VERTEX_PAYGO_LOG_DIR: nestedTarget },
        fsModule,
    }), { code: 'RUNTIME_PATH_UNSAFE' });
});

test('resolveRuntimePaths tolerates read-only mkdirSync failures and rethrows unexpected errors', () => {
    const root = path.resolve(os.tmpdir(), 'fake-ro-host');

    for (const code of ['EROFS', 'EACCES', 'EPERM']) {
        const mkdirCalls = [];
        const fsModule = {
            lstatSync() {
                const error = new Error('missing');
                error.code = 'ENOENT';
                throw error;
            },
            mkdirSync(target, options) {
                mkdirCalls.push({ target, options });
                const error = new Error(`readonly ${code}`);
                error.code = code;
                throw error;
            },
        };

        const result = resolveRuntimePaths({
            hostRoot: root,
            env: {},
            commandLine: { dataRoot: 'data' },
            fsModule,
        });
        const expectedDir = path.join(root, 'data', RUNTIME_SUBDIR);
        assert.deepEqual(result, {
            hostRoot: root,
            logDir: expectedDir,
            configDir: expectedDir,
            legacyRootDir: root,
        });
        assert.deepEqual(mkdirCalls, [{ target: expectedDir, options: { recursive: true, mode: 0o700 } }]);
    }

    const unexpectedFs = {
        lstatSync() {
            const error = new Error('missing');
            error.code = 'ENOENT';
            throw error;
        },
        mkdirSync() {
            const error = new Error('disk failure');
            error.code = 'EIO';
            throw error;
        },
    };
    assert.throws(() => resolveRuntimePaths({
        hostRoot: root,
        env: {},
        commandLine: { dataRoot: 'data' },
        fsModule: unexpectedFs,
    }), { code: 'EIO' });
});
