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
const { pathToFileURL } = require('node:url');
const { PluginError } = require('./errors.cjs');

const MINIMUM_SILLYTAVERN_VERSION = Object.freeze([1, 16, 0]);

function parseVersionCore(version) {
    if (typeof version !== 'string') return null;
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(version);
    if (!match) return null;

    const parts = match.slice(1, 4).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
}

function isAtLeastVersion(version, minimum) {
    const current = parseVersionCore(version);
    if (!current) return false;

    for (let index = 0; index < minimum.length; index += 1) {
        if (current[index] > minimum[index]) return true;
        if (current[index] < minimum[index]) return false;
    }
    return true;
}

function isSupportedHost(packageData) {
    if (!packageData || typeof packageData !== 'object') return false;
    if (packageData.name === 'sillytavern') {
        return isAtLeastVersion(packageData.version, MINIMUM_SILLYTAVERN_VERSION);
    }
    if (packageData.name === 'luker') {
        return parseVersionCore(packageData.version) !== null;
    }
    return false;
}

async function loadStRuntime({
    rootDir = process.cwd(),
    readFile = fs.promises.readFile,
    importModule = specifier => import(specifier),
} = {}) {
    const resolvedRoot = path.resolve(rootDir);
    let packageData;
    try {
        packageData = JSON.parse(await readFile(path.join(resolvedRoot, 'package.json'), 'utf8'));
    } catch (error) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'Could not identify the SillyTavern runtime.', { cause: error });
    }

    if (!isSupportedHost(packageData)) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'This plugin requires SillyTavern 1.16.0 or newer, or a compatible Luker runtime.');
    }

    const googleModuleUrl = pathToFileURL(path.join(resolvedRoot, 'src', 'endpoints', 'google.js')).href;
    let googleModule;
    try {
        googleModule = await importModule(googleModuleUrl);
    } catch (error) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'Could not load the host\'s Vertex AI runtime.', { cause: error });
    }
    if (typeof googleModule.getGoogleApiConfig !== 'function') {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'The host does not export the required Vertex AI configuration helper.');
    }

    const secretsModuleUrl = pathToFileURL(path.join(resolvedRoot, 'src', 'endpoints', 'secrets.js')).href;
    let secretsModule;
    try {
        secretsModule = await importModule(secretsModuleUrl);
    } catch (error) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'Could not load the host\'s secret manager.', { cause: error });
    }
    if (typeof secretsModule.readSecret !== 'function' || !secretsModule.SECRET_KEYS) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'The host does not export the required secret manager.');
    }

    const getGoogleApiConfig = async (request, model, endpoint) => {
        const rawSecretId = request?.body?.secret_id ?? request?.body?.secretId;
        const secretId = typeof rawSecretId === 'string' ? rawSecretId.trim() : '';
        if (!secretId) {
            return googleModule.getGoogleApiConfig(request, model, endpoint);
        }

        // The host's Vertex full mode helper always reads the active service
        // account. Refuse an explicit selection rather than silently using it.
        if (request?.body?.api === 'vertexai') {
            const error = new Error('Explicit secret selection is unsupported for Vertex AI authentication.');
            error.code = 'EXPLICIT_SECRET_UNSUPPORTED';
            throw error;
        }

        const directories = request?.user?.directories;
        if (!directories) {
            const error = new Error('An authenticated user is required for explicit secret selection.');
            error.code = 'EXPLICIT_SECRET_UNAVAILABLE';
            throw error;
        }
        const apiKey = secretsModule.readSecret(directories, secretsModule.SECRET_KEYS.MAKERSUITE, secretId);
        if (typeof apiKey !== 'string' || !apiKey) {
            const error = new Error('The requested Google AI Studio secret was not found.');
            error.code = 'EXPLICIT_SECRET_NOT_FOUND';
            throw error;
        }

        const config = await googleModule.getGoogleApiConfig(request, model, endpoint);
        return {
            ...config,
            headers: { ...config.headers, 'x-goog-api-key': apiKey },
        };
    };

    return Object.freeze({
        rootDir: resolvedRoot,
        hostName: packageData.name,
        stVersion: packageData.version,
        getGoogleApiConfig,
    });
}

module.exports = { loadStRuntime };
