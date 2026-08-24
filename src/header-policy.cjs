/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');

const REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Request-Type';
const SHARED_REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Shared-Request-Type';
const SERVER_TIMEOUT_HEADER = 'X-Server-Timeout';

function buildPayGoHeaders({ tier, paygoOnly }) {
    if (!['standard', 'flex', 'priority'].includes(tier) || typeof paygoOnly !== 'boolean') {
        throw new PluginError(500, 'INVALID_HEADER_POLICY', 'The PayGo header policy received invalid state.');
    }

    const headers = {};
    if (paygoOnly) {
        headers[REQUEST_TYPE_HEADER] = 'shared';
    }
    if (tier === 'flex' || tier === 'priority') {
        headers[SHARED_REQUEST_TYPE_HEADER] = tier;
    }
    if (tier === 'flex') {
        headers[SERVER_TIMEOUT_HEADER] = '1800';
    }
    return Object.freeze(headers);
}

module.exports = {
    REQUEST_TYPE_HEADER,
    SERVER_TIMEOUT_HEADER,
    SHARED_REQUEST_TYPE_HEADER,
    buildPayGoHeaders,
};
