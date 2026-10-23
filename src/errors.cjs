/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

class PluginError extends Error {
    constructor(status, code, message, options = undefined) {
        super(message, options);
        this.name = 'PluginError';
        this.status = status;
        this.code = code;
        // Browser-safe structured context; never put credentials here.
        if (options?.details) this.details = options.details;
    }
}

function asPluginError(error) {
    if (error instanceof PluginError) {
        return error;
    }

    return new PluginError(
        500,
        'INTERNAL_ERROR',
        'The Vertex PayGo server plugin could not complete the request.',
        { cause: error },
    );
}

function errorPayload(error) {
    return {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
    };
}

function sendExpressError(response, error) {
    const safeError = asPluginError(error);
    return response.status(safeError.status).json({ error: true, ...errorPayload(safeError) });
}

function sendNodeError(response, error) {
    const safeError = asPluginError(error);
    // An ended response already delivered its own terminal event; destroying
    // it now could discard that event before it is flushed.
    if (response.writableEnded) return;
    if (response.headersSent) {
        response.destroy();
        return;
    }

    const body = Buffer.from(JSON.stringify({ error: true, ...errorPayload(safeError) }));

    response.writeHead(safeError.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

module.exports = {
    PluginError,
    asPluginError,
    errorPayload,
    sendExpressError,
    sendNodeError,
};
