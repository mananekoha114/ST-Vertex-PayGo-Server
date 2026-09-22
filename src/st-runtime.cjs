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

        if (request?.body?.api === 'vertexai') {
            const directories = request?.user?.directories;
            const authMode = request.body.vertexai_auth_mode;
            const region = request.body.vertexai_region;
            const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
            const baseUrl = `https://${host}/v1`;
            if (!directories) {
                const error = new Error('An authenticated user is required for explicit secret selection.');
                error.code = 'EXPLICIT_SECRET_UNAVAILABLE';
                throw error;
            }
            if (authMode === 'express') {
                const apiKey = secretsModule.readSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI, secretId);
                if (typeof apiKey !== 'string' || !apiKey) {
                    const error = new Error('The requested Vertex AI Express secret was not found.');
                    error.code = 'EXPLICIT_SECRET_NOT_FOUND';
                    throw error;
                }
                const projectId = request.body.vertexai_express_project_id;
                const pathPrefix = projectId ? `/projects/${projectId}/locations/${region}` : '';
                return {
                    url: `${baseUrl}${pathPrefix}/publishers/google/models/${model}:${endpoint}`,
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                };
            }
            if (authMode === 'full') {
                const requiredHelpers = ['generateJWTToken', 'getAccessToken', 'getProjectIdFromServiceAccount'];
                if (requiredHelpers.some(name => typeof googleModule[name] !== 'function')) {
                    const error = new Error('This host cannot authenticate an explicitly selected Vertex AI service account.');
                    error.code = 'EXPLICIT_SECRET_UNSUPPORTED';
                    throw error;
                }
                const serialized = secretsModule.readSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, secretId);
                if (typeof serialized !== 'string' || !serialized) {
                    const error = new Error('The requested Vertex AI service account was not found.');
                    error.code = 'EXPLICIT_SECRET_NOT_FOUND';
                    throw error;
                }
                try {
                    const serviceAccount = JSON.parse(serialized);
                    const projectId = googleModule.getProjectIdFromServiceAccount(serviceAccount);
                    const jwtToken = await googleModule.generateJWTToken(serviceAccount);
                    const accessToken = await googleModule.getAccessToken(jwtToken);
                    if (typeof accessToken !== 'string' || !accessToken) throw new Error('Missing access token');
                    return {
                        url: `${baseUrl}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`,
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                    };
                } catch (cause) {
                    const error = new Error('The selected Vertex AI service account could not be authenticated.', { cause });
                    error.code = 'EXPLICIT_SECRET_UNAVAILABLE';
                    throw error;
                }
            }
            const error = new Error('Explicit secret selection is unsupported for this Vertex AI authentication mode.');
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
