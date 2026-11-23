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
const { PluginError } = require('./errors.cjs');

const RUNTIME_SUBDIR = 'vertex-paygo';
const READ_ONLY_ERROR_CODES = new Set(['EROFS', 'EACCES', 'EPERM']);

function readNonEmptyString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function assertNoSymlinkPath(targetPath, fsModule) {
    const resolved = path.resolve(targetPath);
    const { root } = path.parse(resolved);
    const relative = resolved.slice(root.length);
    const segments = relative.split(path.sep).filter(Boolean);
    let cursor = root;
    for (const segment of segments) {
        cursor = path.join(cursor, segment);
        let stat;
        try {
            stat = fsModule.lstatSync(cursor);
        } catch (error) {
            if (error?.code === 'ENOENT' || READ_ONLY_ERROR_CODES.has(error?.code)) {
                continue;
            }
            throw error;
        }
        if (stat?.isSymbolicLink?.()) {
            throw new PluginError(
                500,
                'RUNTIME_PATH_UNSAFE',
                `Refusing to use symlinked runtime directory: ${cursor}`,
            );
        }
    }
    return resolved;
}

function createRuntimeDirectory(resolvedPath, fsModule) {
    try {
        fsModule.mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
    } catch (error) {
        if (!READ_ONLY_ERROR_CODES.has(error?.code)) {
            throw error;
        }
    }
    return resolvedPath;
}

function resolveRuntimePaths({
    hostRoot = process.cwd(),
    env = process.env,
    commandLine = globalThis.COMMAND_LINE_ARGS,
    dataRootGlobal = globalThis.DATA_ROOT,
    fsModule = fs,
} = {}) {
    const resolvedHostRoot = path.resolve(readNonEmptyString(hostRoot) ?? process.cwd());
    const envLogDir = readNonEmptyString(env?.ST_VERTEX_PAYGO_LOG_DIR);
    const envDataDir = readNonEmptyString(env?.ST_VERTEX_PAYGO_DATA_DIR);
    const rawDataRoot = readNonEmptyString(commandLine?.dataRoot) ?? readNonEmptyString(dataRootGlobal);
    const resolvedDataRoot = rawDataRoot ? path.resolve(resolvedHostRoot, rawDataRoot) : null;
    const hostDataDir = resolvedDataRoot ? path.join(resolvedDataRoot, RUNTIME_SUBDIR) : null;

    const configCandidate = envDataDir
        ? path.resolve(resolvedHostRoot, envDataDir)
        : (hostDataDir ?? resolvedHostRoot);

    const logCandidate = envLogDir
        ? path.resolve(resolvedHostRoot, envLogDir)
        : configCandidate;

    // Validate all candidate paths before creating any directory.
    const configDir = assertNoSymlinkPath(configCandidate, fsModule);
    const logDir = logCandidate === configCandidate
        ? configDir
        : assertNoSymlinkPath(logCandidate, fsModule);

    createRuntimeDirectory(configDir, fsModule);
    if (logDir !== configDir) {
        createRuntimeDirectory(logDir, fsModule);
    }

    return {
        hostRoot: resolvedHostRoot,
        logDir,
        configDir,
        legacyRootDir: resolvedHostRoot,
    };
}

module.exports = {
    RUNTIME_SUBDIR,
    resolveRuntimePaths,
};
