/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { createLoopbackTransport } = require('./src/loopback-server.cjs');
const { createOpenAIBridge } = require('./src/openai-bridge.cjs');
const { createBridgeListener, readBridgePort } = require('./src/bridge-listener.cjs');
const { BridgeLogStore } = require('./src/bridge-log-store.cjs');
const { LogStore, describeError } = require('./src/log-store.cjs');
const { PLUGIN_ID } = require('./src/protocol.cjs');
const { registerRoutes } = require('./src/routes.cjs');
const { loadStRuntime } = require('./src/st-runtime.cjs');
const { TicketStore } = require('./src/ticket-store.cjs');
const { UsageStore } = require('./src/usage-store.cjs');

const info = Object.freeze({
    id: PLUGIN_ID,
    name: 'Vertex AI PayGo service tiers',
    description: 'Adds a private server-side transport for Vertex AI Standard, Flex, and Priority PayGo requests.',
});

let activeState;

async function init(router) {
    if (activeState) throw new Error('Vertex PayGo server plugin is already initialized.');

    const logStore = new LogStore({ rootDir: process.cwd() });
    logStore.server('info', 'plugin_initializing');
    let ticketStore;
    let loopbackTransport;
    let openaiBridge;
    let bridgeListener;
    const usageStore = new UsageStore();
    try {
        const stRuntime = await loadStRuntime();
        logStore.server('info', 'host_runtime_loaded', {
            hostName: stRuntime.hostName,
            hostVersion: stRuntime.stVersion,
        });
        ticketStore = new TicketStore();
        openaiBridge = createOpenAIBridge({ stRuntime, bridgeLogStore: new BridgeLogStore() });
        loopbackTransport = createLoopbackTransport({ ticketStore, logStore, usageStore });
        await loopbackTransport.start();
        try {
            const port = await readBridgePort();
            bridgeListener = createBridgeListener({ openaiBridge, port });
            await bridgeListener.start();
            logStore.server('info', 'bridge_listener_started', { port });
        } catch (error) {
            logStore.server('error', 'bridge_listener_failed', describeError(error));
            console.warn(`[Vertex PayGo] ${error.code}: ${error.message}`);
        }
        registerRoutes(router, { stRuntime, ticketStore, loopbackTransport, logStore, usageStore, openaiBridge });
        activeState = { ticketStore, loopbackTransport, logStore, usageStore, openaiBridge, bridgeListener };
        logStore.server('info', 'plugin_ready', {
            hostName: stRuntime.hostName,
            hostVersion: stRuntime.stVersion,
        });
    } catch (error) {
        logStore.server('error', 'plugin_initialization_failed', describeError(error));
        try {
            ticketStore?.close();
            openaiBridge?.close();
            await bridgeListener?.close();
            await loopbackTransport?.close();
        } catch (cleanupError) {
            logStore.server('error', 'plugin_initialization_cleanup_failed', describeError(cleanupError));
        } finally {
            logStore.close();
        }
        throw error;
    }
}

async function exit() {
    const state = activeState;
    activeState = undefined;
    if (!state) return;
    state.logStore.server('info', 'plugin_stopping');
    state.ticketStore.close();
    state.openaiBridge.close();
    try {
        await state.bridgeListener?.close();
        await state.loopbackTransport.close();
        state.logStore.server('info', 'plugin_stopped');
    } catch (error) {
        state.logStore.server('error', 'plugin_shutdown_failed', describeError(error));
        throw error;
    } finally {
        state.logStore.close();
    }
}

module.exports = { info, init, exit };
