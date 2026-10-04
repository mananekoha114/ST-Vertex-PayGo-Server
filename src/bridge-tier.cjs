/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PluginError } = require('./errors.cjs');

const MAX_SETTINGS_BYTES = 8 * 1024 * 1024;
const DEFAULT_POLICY = Object.freeze({ mode: 'openai', tierSource: 'independent', tier: 'standard' });
function validateBridgePolicy(body, previous, connection) {
    const inherited = connection.source === 'vertexai' ? previous : null;
    const policy = Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([key, fallback]) => [key, body[key] !== undefined ? body[key] : inherited?.[key] ?? fallback]));
    if (!['openai', 'gemini'].includes(policy.mode) || !['independent', 'follow'].includes(policy.tierSource) || !['standard', 'flex', 'priority'].includes(policy.tier)) throw new PluginError(400, 'INVALID_BRIDGE_POLICY', 'The bridge mode or tier policy is invalid.');
    if (connection.source !== 'vertexai') {
        if (Object.keys(DEFAULT_POLICY).some(key => policy[key] !== DEFAULT_POLICY[key])) throw new PluginError(400, 'VERTEX_BRIDGE_POLICY_REQUIRED', 'Gateway modes and tier policies require a Vertex AI connection.');
        return policy;
    }
    if (policy.tierSource === 'independent') validateEffectiveTier(policy, connection, policy.tier);
    return policy;
}
function validateEffectiveTier(policy, connection, tier) {
    if (policy.mode === 'openai' && tier === 'flex') throw new PluginError(400, 'BRIDGE_OPENAI_FLEX_UNSUPPORTED', 'Vertex Flex requires the Gemini gateway mode.');
    if (tier !== 'standard' && connection.region !== 'global') throw new PluginError(400, 'BRIDGE_TIER_REQUIRES_GLOBAL', 'Vertex Flex and Priority require the bound connection region to be global. Update the connection explicitly.');
}
async function readSavedTier(bridgeState, stRuntime) {
    let handle;
    try {
        let serialized;
        if (typeof stRuntime?.readSavedSettings === 'function') {
            const stored = await stRuntime.readSavedSettings(bridgeState.ownerHandle);
            serialized = typeof stored === 'string' ? stored : JSON.stringify(stored);
            if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new Error('Settings exceed limit or are unavailable');
        } else {
            handle = await fs.open(path.join(bridgeState.directories.root, 'settings.json'), 'r');
            const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
            let size = 0;
            while (size < bytes.length) {
                const result = await handle.read(bytes, size, bytes.length - size, null);
                if (!result.bytesRead) break;
                size += result.bytesRead;
            }
            if (size > MAX_SETTINGS_BYTES) throw new Error('Settings exceed limit');
            serialized = bytes.subarray(0, size).toString('utf8');
        }
        const saved = JSON.parse(serialized);
        if (saved.main_api !== 'openai' || saved.oai_settings?.chat_completion_source !== 'vertexai') throw new PluginError(409, 'BRIDGE_FOLLOW_SOURCE_INVALID', 'Following the main API requires its saved connection to use Vertex AI. Save the main API settings first.');
        const manager = saved.extension_settings?.connectionManager;
        const profile = Array.isArray(manager?.profiles) ? manager.profiles.find(item => item?.id === manager.selectedProfile && item?.mode === 'cc' && ['vertexai', 'makersuite'].includes(item?.api)) : null;
        if (profile && profile.api !== 'vertexai') throw new PluginError(409, 'BRIDGE_FOLLOW_SOURCE_INVALID', 'The saved active Google profile must use Vertex AI.');
        const state = profile && Object.hasOwn(profile, 'vertex-paygo') ? profile['vertex-paygo'] : saved.oai_settings.extensions?.['vertex-paygo'];
        const tier = state?.tier ?? 'standard';
        if (!['standard', 'flex', 'priority'].includes(tier)) throw new PluginError(409, 'BRIDGE_FOLLOW_TIER_INVALID', 'The saved main API tier is invalid.');
        return { tier, paygoOnly: state?.paygoOnly === true };
    } catch (cause) {
        if (cause instanceof PluginError) throw cause;
        throw new PluginError(409, 'BRIDGE_FOLLOW_SETTINGS_UNAVAILABLE', 'The saved main API settings could not be read. Save the settings and retry.');
    } finally { await handle?.close(); }
}
async function effectiveBridgeTier(state, stRuntime) {
    if (state.connection.source !== 'vertexai') return { tier: 'standard', paygoOnly: false };
    const selected = state.tierSource === 'follow' ? await readSavedTier(state, stRuntime) : { tier: state.tier, paygoOnly: false };
    validateEffectiveTier(state, state.connection, selected.tier);
    return selected;
}
module.exports = { DEFAULT_POLICY, MAX_SETTINGS_BYTES, validateBridgePolicy, effectiveBridgeTier };
