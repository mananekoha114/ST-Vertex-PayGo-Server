'use strict';

const { createLoopbackTransport } = require('./src/loopback-server.cjs');
const { PLUGIN_ID } = require('./src/protocol.cjs');
const { registerRoutes } = require('./src/routes.cjs');
const { loadStRuntime } = require('./src/st-runtime.cjs');
const { TicketStore } = require('./src/ticket-store.cjs');

const info = Object.freeze({
    id: PLUGIN_ID,
    name: 'Vertex AI PayGo service tiers',
    description: 'Adds a private server-side transport for Vertex AI Standard, Flex, and Priority PayGo requests.',
});

let activeState;

async function init(router) {
    if (activeState) throw new Error('Vertex PayGo server plugin is already initialized.');

    const stRuntime = await loadStRuntime();
    const ticketStore = new TicketStore();
    const loopbackTransport = createLoopbackTransport({ ticketStore });
    try {
        await loopbackTransport.start();
        registerRoutes(router, { stRuntime, ticketStore, loopbackTransport });
        activeState = { ticketStore, loopbackTransport };
    } catch (error) {
        ticketStore.close();
        await loopbackTransport.close();
        throw error;
    }
}

async function exit() {
    const state = activeState;
    activeState = undefined;
    if (!state) return;
    state.ticketStore.close();
    await state.loopbackTransport.close();
}

module.exports = { info, init, exit };
