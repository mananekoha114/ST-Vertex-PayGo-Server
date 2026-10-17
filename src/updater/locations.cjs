/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PluginError } = require('../errors.cjs');

// Where the two components live on this host, and how a directory proves it is
// one of them. The identity rules are the installer's, not new ones: the
// frontend manifest that the host itself reads, and the server package name.
//
// Updates always come from the official repositories below, never from
// whatever origin a copy happens to carry. The installed origin is read only
// to report a mismatch.

const FRONTEND_DISPLAY_NAME = 'Vertex AI PayGo Tiers';
const SERVER_PACKAGE_NAME = 'st-vertex-paygo-server';
const METADATA_FILE = 'paygo-updater.json';

const OFFICIAL_REMOTES = Object.freeze({
    frontend: 'https://github.com/mananekoha114/ST-Vertex-PayGo.git',
    server: 'https://github.com/mananekoha114/ST-Vertex-PayGo-Server.git',
});

const DEFAULT_PLUGINS_PATH = 'plugins';
const DEFAULT_EXTENSIONS_PATH = 'public/scripts/extensions/third-party';

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/u, ''));
    } catch {
        return null;
    }
}

function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Rejects a managed path that leaves the selected storage root or crosses a symlink, the
// same way the installer refuses to operate through links.
function resolveWithinHost(rootDir, target) {
    const resolved = path.resolve(target);
    if (!inside(rootDir, resolved) || resolved === rootDir) {
        throw new PluginError(500, 'UPDATER_UNSAFE_PATH', `Refusing to manage a path outside the update storage root: ${resolved}`);
    }
    let cursor = rootDir;
    for (const part of path.relative(rootDir, resolved).split(path.sep)) {
        cursor = path.join(cursor, part);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                throw new PluginError(500, 'UPDATER_UNSAFE_PATH', `Refusing to manage a path through a symlink: ${cursor}`);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return resolved;
}

function frontendIdentity(directory) {
    const manifest = readJsonFile(path.join(directory, 'manifest.json'));
    return Boolean(manifest) && manifest.display_name === FRONTEND_DISPLAY_NAME;
}

function serverIdentity(directory) {
    const pkg = readJsonFile(path.join(directory, 'package.json'));
    return Boolean(pkg) && pkg.name === SERVER_PACKAGE_NAME;
}

function componentIdentity(component, directory) {
    return component === 'frontend' ? frontendIdentity(directory) : serverIdentity(directory);
}

function readStringOption(values, key) {
    const value = values?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

// Both hosts publish their resolved configuration and CLI overrides at startup.
// SillyTavern's plugin directories are fixed; Luker publishes configurable ones.
function resolveDirectories(rootDir, { commandLine = globalThis.COMMAND_LINE_ARGS, pluginDirectory = serverDirectory() } = {}) {
    rootDir = path.resolve(rootDir);
    const dataRoot = readStringOption(commandLine, 'dataRoot');
    const configPath = readStringOption(commandLine, 'configPath');
    if (!dataRoot || !configPath) {
        throw new PluginError(500, 'UPDATER_HOST_PATHS_UNAVAILABLE', 'The host has not published its resolved data and configuration paths.');
    }
    const pluginsPath = readStringOption(commandLine, 'serverPluginsPath') ?? DEFAULT_PLUGINS_PATH;
    const extensionsPath = readStringOption(commandLine, 'globalExtensionsPath') ?? DEFAULT_EXTENSIONS_PATH;
    const pluginsDirectory = path.resolve(rootDir, pluginsPath);
    const extensionsDirectory = path.resolve(rootDir, extensionsPath);
    const dataRootDirectory = path.resolve(rootDir, dataRoot);
    let updateRoot = rootDir;
    if (!inside(rootDir, pluginsDirectory) || !inside(rootDir, extensionsDirectory)) {
        // APKs keep writable plugins in data storage outside the extracted
        // program. Only that configured root is eligible, and the running
        // plugin must actually have been loaded from its plugin directory.
        // Never infer a common ancestor or permit arbitrary external paths.
        const loadedPlugin = path.resolve(pluginDirectory);
        if (dataRootDirectory === path.parse(dataRootDirectory).root
            || !isDirectory(dataRootDirectory) || fs.lstatSync(dataRootDirectory).isSymbolicLink()
            || !inside(dataRootDirectory, pluginsDirectory) || !inside(dataRootDirectory, extensionsDirectory)
            || path.dirname(loadedPlugin) !== pluginsDirectory) {
            throw new PluginError(500, 'UPDATER_UNSAFE_PATH', 'External plugin directories must share the configured data root and contain the running server plugin.');
        }
        resolveWithinHost(dataRootDirectory, loadedPlugin);
        if (!serverIdentity(loadedPlugin)) {
            throw new PluginError(500, 'UPDATER_UNSAFE_PATH', 'The configured storage does not contain the running PayGo server plugin.');
        }
        updateRoot = dataRootDirectory;
    }
    return Object.freeze({
        rootDir,
        updateRoot,
        pluginsDirectory: resolveWithinHost(updateRoot, pluginsDirectory),
        extensionsDirectory: resolveWithinHost(updateRoot, extensionsDirectory),
        dataRootDirectory,
        configPath: path.resolve(rootDir, configPath),
    });
}

// Moving a component must not move host data, configuration or recovery files.
// A component inside dataRoot is normal for APKs and per-user extensions;
// only the opposite containment would move the host's active data away.
function assertSafeLayout(directories, targets, backupDirectory) {
    const backupRoot = resolveWithinHost(directories.updateRoot, backupDirectory);
    const protectedPaths = [directories.dataRootDirectory, directories.configPath];
    for (const target of [...protectedPaths]) {
        if (fs.existsSync(target)) protectedPaths.push(fs.realpathSync(target));
    }
    for (const [index, target] of targets.entries()) {
        if (protectedPaths.some(protectedPath => inside(target, protectedPath))
            || inside(target, backupRoot) || inside(backupRoot, target)
            || targets.some((other, otherIndex) => otherIndex !== index && inside(target, other))) {
            throw new PluginError(409, 'UPDATER_UNSAFE_PATH', 'Component directories must not contain host data, active configuration or recovery files, or overlap one another.');
        }
    }
}

// Both install locations the host supports: the global third-party directory
// and every per-user extensions directory under the data root.
function extensionRoots(directories) {
    const roots = [directories.extensionsDirectory];
    if (isDirectory(directories.dataRootDirectory)) {
        for (const entry of fs.readdirSync(directories.dataRootDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            roots.push(path.join(directories.dataRootDirectory, entry.name, 'extensions'));
        }
    }
    return roots;
}

function locateComponent(component, directories) {
    const roots = component === 'frontend' ? extensionRoots(directories) : [directories.pluginsDirectory];
    const matches = [];
    for (const root of roots) {
        if (!isDirectory(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const candidate = path.join(root, entry.name);
            if (componentIdentity(component, candidate)) matches.push(resolveWithinHost(directories.updateRoot, candidate));
        }
    }
    return matches.sort();
}

// The server plugin's own directory is authoritative: the host loaded us from
// it, which already reflects any command-line or configuration override.
function serverDirectory() {
    return path.resolve(__dirname, '..', '..');
}

module.exports = {
    DEFAULT_EXTENSIONS_PATH,
    DEFAULT_PLUGINS_PATH,
    METADATA_FILE,
    OFFICIAL_REMOTES,
    assertSafeLayout,
    componentIdentity,
    extensionRoots,
    frontendIdentity,
    inside,
    isDirectory,
    locateComponent,
    resolveDirectories,
    resolveWithinHost,
    serverDirectory,
    serverIdentity,
};
