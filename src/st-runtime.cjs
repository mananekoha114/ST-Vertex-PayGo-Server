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
const { createVertexOAuthClient } = require('./vertex-oauth.cjs');

const MINIMUM_SILLYTAVERN_VERSION = Object.freeze([1, 16, 0]);
const defaultImportModule = specifier => import(specifier);

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
    importModule = defaultImportModule,
    fileExists = filename => fs.existsSync(filename),
    oauthRequest = undefined,
    oauthTimeoutMs = undefined,
    now = Date.now,
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

    // New Luker installations store authoritative settings in a repository,
    // which may use a database. Existing repository failures must never cause
    // the bridge to read an obsolete settings.json instead.
    let readSavedSettings;
    const storagePath = path.join(resolvedRoot, 'src', 'storage', 'index.js');
    if (packageData.name === 'luker' && await fileExists(storagePath)) {
        let storage;
        try { storage = await importModule(pathToFileURL(storagePath).href); } catch { /* Report on follow, leaving independent features available. */ }
        readSavedSettings = async ownerHandle => {
            try {
                if (typeof ownerHandle !== 'string' || !ownerHandle || ownerHandle.length > 256 || /[\x00-\x1f\x7f]/u.test(ownerHandle)) throw new Error('Missing authenticated settings owner');
                if (typeof storage?.getSettingsRepo !== 'function') throw new Error('Missing settings repository');
                const repo = storage.getSettingsRepo();
                const read = typeof repo?.get === 'function' ? repo.get : repo?.load;
                if (typeof read !== 'function') throw new Error('Missing repository reader');
                return await read.call(repo, ownerHandle);
            } catch {
                throw new PluginError(409, 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE', 'The saved main API settings could not be read from the host settings repository. Save the settings and retry.');
            }
        };
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

    const useHostAccessTokenFallback = oauthRequest === undefined && importModule !== defaultImportModule;
    const vertexOAuth = createVertexOAuthClient({
        ...(oauthRequest !== undefined ? { oauthRequest } : {}),
        ...(oauthTimeoutMs !== undefined ? { timeoutMs: oauthTimeoutMs } : {}),
        now,
    });
    const hasHostVertexFullHelpers = () => ['generateJWTToken', 'getAccessToken', 'getProjectIdFromServiceAccount']
        .every(name => typeof googleModule[name] === 'function');
    const readHostSecret = (directories, key, secretId) => {
        if (!key) return '';
        return secretId
            ? secretsModule.readSecret(directories, key, secretId)
            : secretsModule.readSecret(directories, key);
    };

    const getGoogleApiConfig = async (request, model, endpoint) => {
        // Match the host: a reverse proxy owns its credentials for either
        // source, even when a saved profile also carries an explicit secret ID.
        if (request?.body?.reverse_proxy) {
            return googleModule.getGoogleApiConfig(request, model, endpoint);
        }
        const rawSecretId = request?.body?.secret_id ?? request?.body?.secretId;
        const secretId = typeof rawSecretId === 'string' ? rawSecretId.trim() : '';
        const directories = request?.user?.directories;

        if (request?.body?.api === 'vertexai') {
            if (!directories || typeof directories !== 'object') {
                if (secretId) {
                    throw new PluginError(400, 'EXPLICIT_SECRET_UNAVAILABLE', 'An authenticated user is required for explicit secret selection.');
                }
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
            }
            const requestedAuthMode = request.body.vertexai_auth_mode || 'express';
            const region = request.body.vertexai_region || 'us-central1';
            if (requestedAuthMode !== 'express' && requestedAuthMode !== 'full') {
                if (secretId) {
                    throw new PluginError(400, 'EXPLICIT_SECRET_UNSUPPORTED', 'Explicit secret selection is unsupported for this Vertex AI authentication mode.');
                }
                throw new PluginError(400, 'VERTEX_AUTH_CONFIGURATION_FAILED', 'Google authentication is unavailable for this configuration.');
            }

            let effectiveAuthMode = requestedAuthMode;
            let credential = '';
            if (secretId) {
                if (requestedAuthMode === 'full') {
                    if (useHostAccessTokenFallback && !hasHostVertexFullHelpers()) {
                        throw new PluginError(400, 'EXPLICIT_SECRET_UNSUPPORTED', 'This host cannot authenticate an explicitly selected Vertex AI service account.');
                    }
                    credential = readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, secretId);
                    if ((typeof credential !== 'string' || !credential) && secretsModule.SECRET_KEYS.VERTEXAI) {
                        const fallbackExpress = readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI, secretId);
                        if (typeof fallbackExpress === 'string' && fallbackExpress) {
                            credential = fallbackExpress;
                            effectiveAuthMode = 'express';
                        }
                    }
                    if (typeof credential !== 'string' || !credential) {
                        throw new PluginError(400, 'EXPLICIT_SECRET_NOT_FOUND', 'The requested Vertex AI service account was not found.');
                    }
                } else {
                    credential = readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI, secretId);
                    if ((typeof credential !== 'string' || !credential) && secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT) {
                        const fallbackFull = readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, secretId);
                        if (typeof fallbackFull === 'string' && fallbackFull) {
                            if (useHostAccessTokenFallback && !hasHostVertexFullHelpers()) {
                                throw new PluginError(400, 'EXPLICIT_SECRET_UNSUPPORTED', 'This host cannot authenticate an explicitly selected Vertex AI service account.');
                            }
                            credential = fallbackFull;
                            effectiveAuthMode = 'full';
                        }
                    }
                    if (typeof credential !== 'string' || !credential) {
                        throw new PluginError(400, 'EXPLICIT_SECRET_NOT_FOUND', 'The requested Vertex AI Express secret was not found.');
                    }
                }
            } else if (requestedAuthMode === 'full') {
                if (useHostAccessTokenFallback && !hasHostVertexFullHelpers()) {
                    throw new PluginError(400, 'VERTEX_AUTH_CONFIGURATION_FAILED', 'Google authentication is unavailable for this configuration.');
                }
                credential = readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, '');
                if (typeof credential !== 'string' || !credential) {
                    throw new PluginError(400, 'VERTEX_SECRET_MISSING', 'Vertex AI service account JSON is missing.', {
                        details: { authMode: 'full' },
                    });
                }
            } else {
                credential = readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI, '');
                if (typeof credential !== 'string' || !credential) {
                    throw new PluginError(400, 'VERTEX_SECRET_MISSING', 'Vertex AI Express API key is missing.', {
                        details: { authMode: 'express' },
                    });
                }
            }

            const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
            const baseUrl = `https://${host}/v1`;
            if (effectiveAuthMode === 'express') {
                const projectId = request.body.vertexai_express_project_id;
                const pathPrefix = projectId ? `/projects/${projectId}/locations/${region}` : '';
                return {
                    url: `${baseUrl}${pathPrefix}/publishers/google/models/${model}:${endpoint}`,
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': credential },
                };
            }

            const { projectId, accessToken, oauthCacheKey } = await vertexOAuth.authenticateServiceAccount({
                userRoot: typeof directories.root === 'string' ? directories.root : '',
                serialized: credential,
                googleModule,
                useHostAccessTokenFallback,
            });
            return {
                url: `${baseUrl}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                oauthCacheKey,
            };
        }

        if (!directories || typeof directories !== 'object') {
            if (secretId) {
                throw new PluginError(400, 'EXPLICIT_SECRET_UNAVAILABLE', 'An authenticated user is required for explicit secret selection.');
            }
            throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
        }
        const apiKey = readHostSecret(directories, secretsModule.SECRET_KEYS.MAKERSUITE, secretId);
        if (typeof apiKey !== 'string' || !apiKey) {
            if (secretId) {
                throw new PluginError(400, 'EXPLICIT_SECRET_NOT_FOUND', 'The requested Google AI Studio secret was not found.');
            }
            throw new PluginError(400, 'GOOGLE_SECRET_MISSING', 'Google AI Studio API key is missing.');
        }

        const customBaseUrl = typeof request?.body?.base_url === 'string' && request.body.base_url
            ? request.body.base_url
            : '';
        const hostRequest = customBaseUrl
            ? { ...request, body: { ...request.body, reverse_proxy: customBaseUrl, proxy_password: apiKey } }
            : request;
        const config = await googleModule.getGoogleApiConfig(hostRequest, model, endpoint);
        return {
            ...config,
            headers: { ...config.headers, 'x-goog-api-key': apiKey },
        };
    };

    const resolveOpenAIConnection = (request, connection) => {
        const directories = request?.user?.directories;
        if (!directories?.root) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated user is required.');
        const secretKey = connection.source === 'makersuite' ? secretsModule.SECRET_KEYS.MAKERSUITE : secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT;
        let secretId = connection.secretId;
        if (!secretId && typeof secretsModule.readSecretState === 'function') {
            const entries = secretsModule.readSecretState(directories)?.[secretKey];
            if (Array.isArray(entries)) secretId = entries.find(entry => entry?.active && typeof entry.id === 'string')?.id;
        }
        const credential = readHostSecret(directories, secretKey, secretId);
        if (typeof credential !== 'string' || !credential) throw new PluginError(400, 'GOOGLE_SECRET_NOT_FOUND', 'The selected Google credential was not found.');
        return { connection: Object.freeze({ ...connection, ...(secretId ? { secretId } : {}) }), credentialSnapshot: secretId ? undefined : credential, logCredential: credential };
    };

    const getOpenAIConfig = async (request, connection, authenticate = true, credentialSnapshot) => {
        const directories = request?.user?.directories;
        if (!directories?.root) throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated user is required.');
        const { source, secretId, region } = connection;
        if (credentialSnapshot !== undefined) {
            const key = source === 'makersuite' ? secretsModule.SECRET_KEYS.MAKERSUITE : secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT;
            if (secretsModule.readSecret(directories, key) !== credentialSnapshot) {
                throw new PluginError(409, 'GOOGLE_CONNECTION_CHANGED', 'The selected Google credential changed. Update the bridge connection.');
            }
        }
        if (source === 'makersuite') {
            const apiKey = credentialSnapshot ?? readHostSecret(directories, secretsModule.SECRET_KEYS.MAKERSUITE, secretId);
            if (!apiKey || typeof apiKey !== 'string') throw new PluginError(400, 'GOOGLE_SECRET_NOT_FOUND', 'The selected Google AI Studio secret was not found.');
            return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: `Bearer ${apiKey}` }, logCredential: apiKey };
        }
        if (source !== 'vertexai' || connection.authMode !== 'full') throw new PluginError(400, 'VERTEX_AUTH_UNSUPPORTED', 'Vertex AI requires full service-account authentication.');
        if (useHostAccessTokenFallback && !hasHostVertexFullHelpers()) {
            throw new PluginError(400, 'VERTEX_AUTH_UNSUPPORTED', 'The host cannot authenticate a Vertex service account.');
        }
        const serialized = credentialSnapshot ?? readHostSecret(directories, secretsModule.SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, secretId);
        if (!serialized || typeof serialized !== 'string') throw new PluginError(400, 'GOOGLE_SECRET_NOT_FOUND', 'The selected Vertex service account was not found.');
        const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
        if (!authenticate) {
            const { projectId } = vertexOAuth.validateServiceAccount(serialized, googleModule);
            const target = `https://${host}/v1/projects/${projectId}/locations/${region}/endpoints/openapi/chat/completions`;
            return { target, logCredential: serialized };
        }
        const { projectId, accessToken, oauthCacheKey } = await vertexOAuth.authenticateServiceAccount({
            userRoot: directories.root,
            serialized,
            googleModule,
            useHostAccessTokenFallback,
        });
        const target = `https://${host}/v1/projects/${projectId}/locations/${region}/endpoints/openapi/chat/completions`;
        return { target, headers: { Authorization: `Bearer ${accessToken}` }, logCredential: serialized, oauthCacheKey };
    };

    const listBridgeUsers = async () => {
        try {
            // Use the host account registry, never directories stored in a bridge
            // configuration. Account-free ST installations return no enabled users.
            const [users, util, constants] = await Promise.all([
                importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'users.js')).href),
                importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'util.js')).href),
                importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'constants.js')).href),
            ]);
            if (typeof users.getAllEnabledUsers !== 'function' || typeof users.getUserDirectories !== 'function'
                || typeof util.getConfigValue !== 'function') throw new Error('Missing host user registry');
            const accountsEnabled = util.getConfigValue('enableUserAccounts', false, 'boolean');
            if (typeof accountsEnabled !== 'boolean') throw new Error('Invalid account configuration');
            const profiles = accountsEnabled ? await users.getAllEnabledUsers() : [constants.DEFAULT_USER];
            if (!Array.isArray(profiles)) throw new Error('Invalid user registry');
            const handles = new Set();
            return profiles.filter(profile => !accountsEnabled || profile?.enabled === true).map(profile => {
                const handle = profile?.handle;
                if (typeof handle !== 'string' || !handle || handle.length > 256 || /[\x00-\x1f\x7f]/u.test(handle)
                    || handles.has(handle)) throw new Error('Invalid user handle');
                handles.add(handle);
                const directories = users.getUserDirectories(handle);
                if (typeof directories?.root !== 'string' || !path.isAbsolute(directories.root)) throw new Error('Invalid user directory');
                return { user: { directories: { ...directories }, profile: { handle } } };
            });
        } catch {
            throw new PluginError(503, 'BRIDGE_USERS_UNAVAILABLE', 'The host user registry is unavailable for bridge restoration.');
        }
    };

    const dataBackupContext = async () => {
        try {
            const [users, util, constants] = await Promise.all([
                importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'users.js')).href),
                importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'util.js')).href),
                importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'constants.js')).href),
            ]);
            if (typeof users.getAllUserHandles !== 'function' || typeof users.getUserDirectories !== 'function'
                || typeof util.getConfigValue !== 'function') throw new Error('Missing backup host helpers');
            const enabled = util.getConfigValue('enableUserAccounts', false, 'boolean');
            if (typeof enabled !== 'boolean') throw new Error('Invalid account configuration');
            const handles = enabled ? await users.getAllUserHandles() : [constants.DEFAULT_USER?.handle];
            if (!Array.isArray(handles) || new Set(handles).size !== handles.length) throw new Error('Invalid user registry');
            return {
                retention: util.getConfigValue('backups.common.numberOfBackups', 50, 'number'),
                users: handles.map(handle => {
                    if (typeof handle !== 'string' || !handle || handle.length > 256 || /[\\/\x00-\x1f\x7f]/u.test(handle)) throw new Error('Invalid user handle');
                    const directories = users.getUserDirectories(handle);
                    if (!path.isAbsolute(directories?.root ?? '') || !path.isAbsolute(directories?.backups ?? '')) throw new Error('Invalid user directory');
                    return { user: { profile: { handle }, directories: { ...directories } } };
                }),
            };
        } catch {
            throw new PluginError(503, 'DATA_BACKUP_HOST_UNAVAILABLE', 'The host user directories or backup configuration could not be read.');
        }
    };

    let nativeGeminiHelpers;
    const getNativeGeminiHelpers = async () => {
        if (!nativeGeminiHelpers) nativeGeminiHelpers = Promise.all([
            importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'prompt-converters.js')).href),
            importModule(pathToFileURL(path.join(resolvedRoot, 'src', 'constants.js')).href),
        ]).then(([converters, constants]) => {
            if (typeof converters.postProcessPrompt !== 'function' || typeof converters.convertGooglePrompt !== 'function' || !Array.isArray(constants.GEMINI_SAFETY) || !Array.isArray(constants.VERTEX_SAFETY)) {
                throw new Error('Missing native Gemini helpers');
            }
            return { postProcessPrompt: converters.postProcessPrompt, convertGooglePrompt: converters.convertGooglePrompt, GEMINI_SAFETY: constants.GEMINI_SAFETY, VERTEX_SAFETY: constants.VERTEX_SAFETY };
        }).catch(() => { nativeGeminiHelpers = undefined; throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'The host native Gemini converter is unavailable.'); });
        return nativeGeminiHelpers;
    };

    return Object.freeze({
        rootDir: resolvedRoot,
        hostName: packageData.name,
        stVersion: packageData.version,
        getGoogleApiConfig,
        getOpenAIConfig,
        resolveOpenAIConnection,
        listBridgeUsers,
        dataBackupContext,
        getNativeGeminiHelpers,
        invalidateOAuthToken: cacheKey => vertexOAuth.invalidate(cacheKey),
        clearOAuthCache: () => vertexOAuth.clear(),
        ...(readSavedSettings ? { readSavedSettings } : {}),
    });
}

module.exports = { loadStRuntime };
