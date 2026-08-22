'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PluginError } = require('./errors.cjs');

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

    if (packageData.name !== 'sillytavern' || typeof packageData.version !== 'string' || !/^1\.18\./u.test(packageData.version)) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'This development build requires SillyTavern 1.18.x.');
    }

    const googleModuleUrl = pathToFileURL(path.join(resolvedRoot, 'src', 'endpoints', 'google.js')).href;
    let googleModule;
    try {
        googleModule = await importModule(googleModuleUrl);
    } catch (error) {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'Could not load SillyTavern\'s Vertex AI runtime.', { cause: error });
    }
    if (typeof googleModule.getGoogleApiConfig !== 'function') {
        throw new PluginError(500, 'INCOMPATIBLE_SILLYTAVERN', 'SillyTavern does not export the required Vertex AI configuration helper.');
    }

    return Object.freeze({
        rootDir: resolvedRoot,
        stVersion: packageData.version,
        getGoogleApiConfig: googleModule.getGoogleApiConfig,
    });
}

module.exports = { loadStRuntime };
