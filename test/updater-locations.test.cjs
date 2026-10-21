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

const {
    assertSafeLayout,
    componentIdentity,
    locateComponent,
    resolveDirectories,
    resolveWithinHost,
} = require('../src/updater/locations.cjs');
const { BACKUP_ROOT } = require('../src/updater/transaction.cjs');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

// A host fixture with both install locations and one per-user copy, matching
// the layout the host itself uses.
function makeHost(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-host-'));
    writeJson(path.join(root, 'package.json'), { name: 'luker', version: '2.8.0' });
    writeJson(path.join(root, 'plugins', 'ST-Vertex-PayGo-Server', 'package.json'), { name: 'st-vertex-paygo-server' });
    writeJson(path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo', 'manifest.json'), {
        display_name: 'Vertex AI PayGo Tiers',
    });
    if (options.config !== undefined) {
        fs.writeFileSync(path.join(root, 'config.yaml'), options.config);
    }
    return root;
}

function cleanup(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

function hostPaths(overrides = {}) {
    return { dataRoot: './data', configPath: './config.yaml', ...overrides };
}

function linkDirectory(t, target, link) {
    try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) {
            t.skip('Directory link creation is unavailable: ' + error.code);
            return false;
        }
        throw error;
    }
    return true;
}

test('resolved host paths ignore an inactive broken root config', t => {
    const root = makeHost({ config: '{{ invalid inactive YAML' });
    t.after(() => cleanup(root));
    const commandLine = { configPath: './active.yaml', dataRoot: './active-data',
        serverPluginsPath: './active-plugins', globalExtensionsPath: './active-extensions' };
    fs.writeFileSync(path.join(root, 'active.yaml'), 'dataRoot: ./active-data\n');
    const parser = path.join(root, 'node_modules', 'yaml');
    fs.mkdirSync(parser, { recursive: true });
    fs.writeFileSync(path.join(parser, 'index.js'), 'exports.parse = () => { throw new SyntaxError("Inactive config was parsed"); };');
    const resolved = resolveDirectories(root, { commandLine });
    assert.equal(resolved.dataRootDirectory, path.join(root, 'active-data'));
    assert.equal(resolved.configPath, path.join(root, 'active.yaml'));
    assert.equal(resolved.pluginsDirectory, path.join(root, 'active-plugins'));
    assert.equal(resolved.extensionsDirectory, path.join(root, 'active-extensions'));
});

test('identity comes from the manifest and package names the host already reads', () => {
    const root = makeHost();
    try {
        assert.equal(componentIdentity('frontend', path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo')), true);
        assert.equal(componentIdentity('frontend', path.join(root, 'public', 'scripts', 'extensions', 'third-party')), false);
        assert.equal(componentIdentity('server', path.join(root, 'plugins', 'ST-Vertex-PayGo-Server')), true);
        assert.equal(componentIdentity('server', path.join(root, 'plugins')), false);
    } finally {
        cleanup(root);
    }
});

test('both install locations are found, including per-user copies', () => {
    const root = makeHost();
    try {
        const userCopy = path.join(root, 'data', 'alice', 'extensions', 'ST-Vertex-PayGo');
        writeJson(path.join(userCopy, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers' });
        const directories = resolveDirectories(root, { commandLine: hostPaths() });
        assert.deepEqual(locateComponent('frontend', directories), [
            path.join(root, 'data', 'alice', 'extensions', 'ST-Vertex-PayGo'),
            path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo'),
        ].sort());
        assert.deepEqual(locateComponent('server', directories), [path.join(root, 'plugins', 'ST-Vertex-PayGo-Server')]);
    } finally {
        cleanup(root);
    }
});

test('host-resolved directories take precedence and fixed host paths use their defaults', () => {
    const root = makeHost({ config: JSON.stringify({ serverPluginsPath: './cfg-plugins', globalExtensionsPath: './cfg-ext', dataRoot: './cfg-data' }) });
    try {
        const fromCommandLine = resolveDirectories(root, {
            commandLine: hostPaths({ serverPluginsPath: './cli-plugins', globalExtensionsPath: './cli-ext', dataRoot: './cli-data' }),
        });
        assert.equal(fromCommandLine.pluginsDirectory, path.join(root, 'cli-plugins'));
        assert.equal(fromCommandLine.extensionsDirectory, path.join(root, 'cli-ext'));
        assert.equal(fromCommandLine.dataRootDirectory, path.join(root, 'cli-data'));

        const defaults = resolveDirectories(root, { commandLine: hostPaths() });
        assert.equal(defaults.pluginsDirectory, path.join(root, 'plugins'));
        assert.equal(defaults.extensionsDirectory, path.join(root, 'public', 'scripts', 'extensions', 'third-party'));
        assert.equal(defaults.dataRootDirectory, path.join(root, 'data'));
    } finally {
        cleanup(root);
    }
});

test('managed paths outside the host root or equal to it are refused', () => {
    const root = makeHost();
    try {
        assert.throws(() => resolveWithinHost(root, path.join(root, '..', 'elsewhere')), error => error?.code === 'UPDATER_UNSAFE_PATH');
        assert.throws(() => resolveWithinHost(root, root), error => error?.code === 'UPDATER_UNSAFE_PATH');
    } finally {
        cleanup(root);
    }
});

test('managed paths through a directory link are refused', t => {
    const root = makeHost();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-outside-'));
    t.after(() => { cleanup(root); cleanup(outside); });
    if (!linkDirectory(t, outside, path.join(root, 'linked'))) return;
    assert.throws(() => resolveWithinHost(root, path.join(root, 'linked', 'payload')), error => error.code === 'UPDATER_UNSAFE_PATH');
});

test('missing host-resolved data or config paths fail without guessing', t => {
    const root = makeHost();
    t.after(() => cleanup(root));
    for (const commandLine of [null, {}, { dataRoot: './data' }, { configPath: './config.yaml' }]) {
        assert.throws(() => resolveDirectories(root, { commandLine }), error => error.code === 'UPDATER_HOST_PATHS_UNAVAILABLE');
    }
});

test('a missing root config does not override the host global-mode paths', () => {
    const root = makeHost();
    const global = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-global-'));
    try {
        const directories = resolveDirectories(root, { commandLine: hostPaths({
            configPath: path.join(global, 'config.yaml'), dataRoot: path.join(global, 'data'),
        }) });
        assert.equal(directories.configPath, path.join(global, 'config.yaml'));
        assert.equal(directories.dataRootDirectory, path.join(global, 'data'));
        assert.equal(directories.pluginsDirectory, path.join(root, 'plugins'));
    } finally {
        cleanup(root);
        cleanup(global);
    }
});

test('APK components outside the program use their configured data root as the storage boundary', async t => {
    const root = makeHost();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-apk-data-'));
    t.after(() => { cleanup(root); cleanup(data); });
    const server = path.join(data, 'plugins', 'server');
    const frontend = path.join(data, 'extensions', 'third-party', 'frontend');
    writeJson(path.join(server, 'package.json'), { name: 'st-vertex-paygo-server' });
    writeJson(path.join(frontend, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers' });
    const options = {
        commandLine: hostPaths({ dataRoot: data, serverPluginsPath: path.dirname(server), globalExtensionsPath: path.dirname(frontend) }),
        pluginDirectory: server,
    };
    const directories = resolveDirectories(root, options);
    assert.equal(directories.updateRoot, data);
    assert.deepEqual(locateComponent('server', directories), [server]);
    assert.deepEqual(locateComponent('frontend', directories), [frontend]);
    assert.throws(() => resolveDirectories(root, { ...options, pluginDirectory: path.join(root, 'plugins/server') }), e => e.code === 'UPDATER_UNSAFE_PATH');
    assert.throws(() => resolveDirectories(root, { ...options, commandLine: { ...options.commandLine, dataRoot: path.parse(data).root } }), e => e.code === 'UPDATER_UNSAFE_PATH');
    assert.throws(() => resolveDirectories(root, { ...options, commandLine: { ...options.commandLine, globalExtensionsPath: path.join(root, 'public/extensions') } }), e => e.code === 'UPDATER_UNSAFE_PATH');
    await t.test('external extension directories cannot cross a link', t => {
        if (!linkDirectory(t, path.dirname(frontend), path.join(data, 'linked-extensions'))) return;
        assert.throws(() => resolveDirectories(root, { ...options, commandLine: { ...options.commandLine, globalExtensionsPath: path.join(data, 'linked-extensions') } }), e => e.code === 'UPDATER_UNSAFE_PATH');
    });
});

test('component discovery refuses a matching installation reached through a symlink', t => {
    const root = makeHost();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-outside-'));
    try {
        const frontend = path.join(root, 'public/scripts/extensions/third-party/ST-Vertex-PayGo');
        fs.renameSync(frontend, path.join(outside, 'frontend'));
        if (!linkDirectory(t, path.join(outside, 'frontend'), frontend)) return;
        const directories = resolveDirectories(root, { commandLine: hostPaths() });
        assert.throws(() => locateComponent('frontend', directories), error => error.code === 'UPDATER_UNSAFE_PATH');
    } finally {
        cleanup(root);
        cleanup(outside);
    }
});

test('replacement layouts preserve data, active configuration and recovery directories', t => {
    const root = makeHost();
    t.after(() => cleanup(root));
    const directories = resolveDirectories(root, { commandLine: hostPaths() });
    const frontend = locateComponent('frontend', directories)[0];
    const server = locateComponent('server', directories)[0];
    const backup = path.join(root, BACKUP_ROOT);
    assert.doesNotThrow(() => assertSafeLayout(directories, [frontend, server], backup));
    // Per-user frontends and APK components are inside dataRoot, which is safe.
    assert.doesNotThrow(() => assertSafeLayout({ ...directories, dataRootDirectory: root }, [frontend, server], backup));
    for (const dataRootDirectory of [server, path.join(server, 'node_modules', 'data')]) {
        assert.throws(() => assertSafeLayout({ ...directories, dataRootDirectory }, [frontend, server], backup), error => error.code === 'UPDATER_UNSAFE_PATH');
    }
    assert.throws(() => assertSafeLayout({ ...directories, configPath: path.join(frontend, 'active.yaml') }, [frontend, server], backup), error => error.code === 'UPDATER_UNSAFE_PATH');
    assert.throws(() => assertSafeLayout(directories, [frontend, path.join(frontend, 'server')], backup), error => error.code === 'UPDATER_UNSAFE_PATH');
    assert.throws(() => assertSafeLayout(directories, [server, server], backup), error => error.code === 'UPDATER_UNSAFE_PATH');
    assert.throws(() => assertSafeLayout(directories, [path.join(backup, 'frontend'), server], backup), error => error.code === 'UPDATER_UNSAFE_PATH');
    assert.throws(() => assertSafeLayout(directories, [frontend, server], path.join(server, 'backups')), error => error.code === 'UPDATER_UNSAFE_PATH');
});

test('a data-root alias into a replaced component is also refused', t => {
    const root = makeHost();
    t.after(() => cleanup(root));
    const directories = resolveDirectories(root, { commandLine: hostPaths() });
    const frontend = locateComponent('frontend', directories)[0];
    const server = locateComponent('server', directories)[0];
    const data = path.join(server, 'node_modules', 'host-data');
    fs.mkdirSync(data, { recursive: true });
    const alias = path.join(root, 'linked-data');
    if (!linkDirectory(t, data, alias)) return;
    assert.throws(() => assertSafeLayout({ ...directories, dataRootDirectory: alias }, [frontend, server], path.join(root, BACKUP_ROOT)), error => error.code === 'UPDATER_UNSAFE_PATH');
});
