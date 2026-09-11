/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError, sendExpressError } = require('./errors.cjs');
const {
    CLIENT_LOG_MEDIA_TYPE,
    MAX_CLIENT_EVENT_BYTES,
    describeError,
    validateClientLogEvent,
} = require('./log-store.cjs');

function requireAuthenticatedUser(request) {
    if (!request.user || !request.user.directories) {
        throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
    }
}

function requireLogReader(request) {
    requireAuthenticatedUser(request);
    if (request.user.profile?.admin !== true) {
        throw new PluginError(403, 'LOG_ACCESS_FORBIDDEN', 'Administrator access is required to read the shared server log.');
    }
}

function requireLogWriter(request) {
    requireAuthenticatedUser(request);
    if (request.user.profile?.admin !== true) {
        throw new PluginError(403, 'CLIENT_LOG_ACCESS_FORBIDDEN', 'Administrator access is required to write the shared server log.');
    }
}

function discardRequestBody(request) {
    if (!request?.readableEnded && !request?.destroyed) request.resume?.();
}

function requireClientLogMediaType(request) {
    const contentType = request.headers?.['content-type'];
    const parts = typeof contentType === 'string'
        ? contentType.split(';').map(value => value.trim().toLowerCase())
        : [];
    const validParameters = parts.length === 1 || (parts.length === 2 && parts[1] === 'charset=utf-8');
    if (parts[0] !== CLIENT_LOG_MEDIA_TYPE || !validParameters) {
        throw new PluginError(
            415,
            'CLIENT_LOG_MEDIA_TYPE_REQUIRED',
            `Client log events require ${CLIENT_LOG_MEDIA_TYPE}.`,
        );
    }
}

function validateDeclaredLength(request, maxBytes) {
    const value = request.headers?.['content-length'];
    if (value === undefined) return;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log content length is invalid.');
    }
    const length = Number(value);
    if (!Number.isSafeInteger(length)) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log content length is invalid.');
    }
    if (length > maxBytes) {
        throw new PluginError(413, 'CLIENT_LOG_EVENT_TOO_LARGE', 'The client log event is too large.');
    }
}

function readBoundedBody(request, maxBytes) {
    if (typeof request?.on !== 'function' || typeof request?.once !== 'function') {
        return Promise.reject(new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log request body is unavailable.'));
    }
    if (request.readableEnded) return Promise.resolve(Buffer.alloc(0));
    if (request.destroyed) {
        return Promise.reject(new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log request was interrupted.'));
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let settled = false;

        const cleanup = () => {
            request.removeListener?.('data', onData);
            request.removeListener?.('end', onEnd);
            request.removeListener?.('error', onError);
            request.removeListener?.('aborted', onAborted);
            request.removeListener?.('close', onClose);
        };
        const fail = (error, drain = false) => {
            if (settled) return;
            settled = true;
            cleanup();
            chunks.length = 0;
            if (drain) discardRequestBody(request);
            reject(error);
        };
        const onData = chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buffer.byteLength;
            if (totalBytes > maxBytes) {
                fail(new PluginError(413, 'CLIENT_LOG_EVENT_TOO_LARGE', 'The client log event is too large.'), true);
                return;
            }
            chunks.push(buffer);
        };
        const onEnd = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks, totalBytes));
        };
        const onError = () => fail(new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log request body could not be read.'));
        const onAborted = () => fail(new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log request was interrupted.'));
        const onClose = () => {
            if (!request.readableEnded) onAborted();
        };

        request.on('data', onData);
        request.once('end', onEnd);
        request.once('error', onError);
        request.once('aborted', onAborted);
        request.once('close', onClose);
    });
}

async function readClientLogEvent(request) {
    requireClientLogMediaType(request);
    validateDeclaredLength(request, MAX_CLIENT_EVENT_BYTES);
    const buffer = await readBoundedBody(request, MAX_CLIENT_EVENT_BYTES);
    let body;
    try {
        body = JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log event must contain valid JSON.');
    }
    return validateClientLogEvent(body);
}

function createReadLogsHandler({ logStore }) {
    return function readLogsHandler(request, response) {
        response.set?.('Cache-Control', 'no-store');
        response.set?.('X-Content-Type-Options', 'nosniff');
        try {
            requireLogReader(request);
            const contents = logStore.read();
            response.set('Content-Type', 'text/plain; charset=utf-8');
            return response.send(contents);
        } catch (error) {
            if (!(error instanceof PluginError)) {
                logStore.server('error', 'log_read_failed', describeError(error));
            }
            return sendExpressError(response, error instanceof PluginError
                ? error
                : new PluginError(500, 'LOG_READ_FAILED', 'The Vertex PayGo log could not be read.', { cause: error }));
        }
    };
}

function createClientLogHandler({ logStore }) {
    return async function clientLogHandler(request, response) {
        response.set?.('Cache-Control', 'no-store');
        try {
            requireLogWriter(request);
            const event = await readClientLogEvent(request);
            logStore.client(event.level, event.event, event.context);
            return response.sendStatus(204);
        } catch (error) {
            // Never log a rejected browser-controlled body or authorization
            // failure: doing so would let rejected traffic consume server space.
            discardRequestBody(request);
            return sendExpressError(response, error);
        }
    };
}

module.exports = {
    createClientLogHandler,
    createReadLogsHandler,
    readClientLogEvent,
    requireAuthenticatedUser,
    requireLogReader,
    requireLogWriter,
};
