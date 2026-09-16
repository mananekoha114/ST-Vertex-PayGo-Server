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
const { PluginError } = require('./errors.cjs');

const LOG_FILE_NAME = 'st-vertex-paygo.log';
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_CLIENT_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_LENGTH = 64;
const MAX_CLIENT_EVENT_BYTES = 4096;
const CLIENT_LOG_MEDIA_TYPE = 'application/vnd.st-vertex-paygo.client-log+json';
const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_STRING_LENGTH = 256;
const DEFAULT_MAX_LOW_PRIORITY_BYTES = 2 * 1024 * 1024;
const LEVELS = new Set(['info', 'warn', 'error']);
const SOURCES = new Set(['server', 'client']);
const PRIORITIES = new Set(['low', 'normal']);
const EVENT_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
const DETAIL_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const REGION_PATTERN = /^(?:global|[a-z0-9][a-z0-9-]{0,62})$/u;
const SENSITIVE_DETAIL_KEY_PATTERN = /(?:authorization|apiKey|token|secret|password|credential|cookie|body|prompt|response|content|ticket|proxy|url|headers?)/iu;

const CLIENT_DETAIL_VALIDATORS = Object.freeze({
    clientVersion: value => isBoundedIdentifier(value, 64),
    protocolVersion: value => Number.isSafeInteger(value) && value >= 0,
    phase: value => isBoundedIdentifier(value, 64),
    statusCode: value => Number.isSafeInteger(value) && value >= 100 && value <= 599,
    errorCode: value => typeof value === 'string' && ERROR_CODE_PATTERN.test(value),
    model: value => isBoundedIdentifier(value, 128),
    provider: value => ['vertexai', 'makersuite'].includes(value),
    tier: value => ['standard', 'flex', 'priority'].includes(value),
    region: value => typeof value === 'string' && REGION_PATTERN.test(value),
    stream: value => typeof value === 'boolean',
    paygoOnly: value => typeof value === 'boolean',
    durationMs: value => Number.isSafeInteger(value) && value >= 0 && value <= 24 * 60 * 60_000,
    serverStatus: value => isBoundedIdentifier(value, 32),
    supportLevel: value => isBoundedIdentifier(value, 32),
    requestId: value => isBoundedIdentifier(value, 128),
    clientSessionId: value => isBoundedIdentifier(value, 128),
    component: value => isBoundedIdentifier(value, 64),
    result: value => isBoundedIdentifier(value, 64),
    online: value => typeof value === 'boolean',
});

function isBoundedIdentifier(value, maxLength) {
    return typeof value === 'string'
        && value.length <= maxLength
        && IDENTIFIER_PATTERN.test(value);
}

function validateLogPrimitive(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return value.slice(0, MAX_DETAIL_STRING_LENGTH);
    return undefined;
}

function sanitizeServerDetails(details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;

    const sanitized = {};
    for (const [key, value] of Object.entries(details).slice(0, MAX_DETAIL_KEYS)) {
        if (!DETAIL_KEY_PATTERN.test(key) || SENSITIVE_DETAIL_KEY_PATTERN.test(key)) continue;
        const primitive = validateLogPrimitive(value);
        if (primitive !== undefined) sanitized[key] = primitive;
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function validateClientLogEvent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log event must be an object.');
    }
    if (Object.keys(body).some(key => !['level', 'event', 'context'].includes(key))) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log event contains an unsupported field.');
    }
    if (!LEVELS.has(body.level) || typeof body.event !== 'string' || body.event.length > MAX_EVENT_LENGTH || !EVENT_PATTERN.test(body.event)) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log event level or name is invalid.');
    }

    const inputContext = body.context === undefined ? {} : body.context;
    if (!inputContext || typeof inputContext !== 'object' || Array.isArray(inputContext)) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log context must be an object.');
    }

    const entries = Object.entries(inputContext);
    if (entries.length > MAX_DETAIL_KEYS) {
        throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', 'The client log context contains too many fields.');
    }

    const context = {};
    for (const [key, value] of entries) {
        const validator = CLIENT_DETAIL_VALIDATORS[key];
        if (!validator || !validator(value)) {
            throw new PluginError(400, 'INVALID_CLIENT_LOG_EVENT', `Invalid client log context field: ${key}.`);
        }
        context[key] = value;
    }

    const event = {
        level: body.level,
        event: body.event,
        context: Object.freeze(context),
    };
    // Measure only the already validated, bounded structure. The HTTP handler
    // enforces the same limit while streaming, before parsing any JSON.
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_CLIENT_EVENT_BYTES) {
        throw new PluginError(413, 'CLIENT_LOG_EVENT_TOO_LARGE', 'The client log event is too large.');
    }
    return Object.freeze(event);
}

function describeError(error) {
    const details = {};
    if (typeof error?.name === 'string' && ERROR_CODE_PATTERN.test(error.name)) {
        details.errorName = error.name;
    }
    if (typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code)) {
        details.errorCode = error.code;
    }
    if (Number.isSafeInteger(error?.status) && error.status >= 100 && error.status <= 599) {
        details.statusCode = error.status;
    }
    return details;
}

class LogStore {
    constructor({
        rootDir = process.cwd(),
        fileName = LOG_FILE_NAME,
        maxFileBytes = DEFAULT_MAX_FILE_BYTES,
        maxClientBytes,
        maxLowPriorityBytes,
        now = () => new Date(),
        fsModule = fs,
    } = {}) {
        if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1024) {
            throw new TypeError('Invalid log file size limit.');
        }
        if (typeof fileName !== 'string' || fileName.length === 0 || path.basename(fileName) !== fileName) {
            throw new TypeError('Invalid log file name.');
        }
        const resolvedMaxClientBytes = maxClientBytes
            ?? Math.min(DEFAULT_MAX_CLIENT_BYTES, Math.floor(maxFileBytes * 0.4));
        if (!Number.isSafeInteger(resolvedMaxClientBytes)
            || resolvedMaxClientBytes < 256
            || resolvedMaxClientBytes >= maxFileBytes) {
            throw new TypeError('Invalid client log size limit.');
        }
        const resolvedMaxLowPriorityBytes = maxLowPriorityBytes
            ?? Math.min(DEFAULT_MAX_LOW_PRIORITY_BYTES, Math.floor(maxFileBytes * 0.4));
        if (!Number.isSafeInteger(resolvedMaxLowPriorityBytes)
            || resolvedMaxLowPriorityBytes < 256
            || resolvedMaxLowPriorityBytes >= maxFileBytes) {
            throw new TypeError('Invalid low-priority log size limit.');
        }

        this.fs = fsModule;
        this.filePath = path.join(path.resolve(rootDir), fileName);
        this.maxFileBytes = maxFileBytes;
        this.maxClientBytes = resolvedMaxClientBytes;
        this.maxLowPriorityBytes = resolvedMaxLowPriorityBytes;
        this.now = now;
        this.bytesWritten = 0;
        this.clientBytesWritten = 0;
        this.lowPriorityBytesWritten = 0;
        this.atCapacity = false;
        this.clientAtCapacity = false;
        this.lowPriorityAtCapacity = false;
        this.disabled = false;
        // Opening with `w` is intentional: every host start begins a fresh log.
        this.fileDescriptor = this.fs.openSync(this.filePath, 'w', 0o600);
        try {
            this.fs.fchmodSync?.(this.fileDescriptor, 0o600);
        } catch {
            // Windows and some mounted filesystems do not expose POSIX modes.
        }
    }

    server(level, event, details = undefined, options = undefined) {
        const priority = options?.priority ?? 'normal';
        return this.#write('server', level, event, sanitizeServerDetails(details), priority);
    }

    client(level, event, context = undefined) {
        return this.#write('client', level, event, sanitizeServerDetails(context));
    }

    read() {
        return this.fs.readFileSync(this.filePath, 'utf8');
    }

    close() {
        if (this.fileDescriptor === undefined) return;
        const fileDescriptor = this.fileDescriptor;
        this.fileDescriptor = undefined;
        try {
            this.fs.closeSync(fileDescriptor);
        } catch {
            // Shutdown must continue even if the filesystem is already unavailable.
        }
    }

    #write(source, level, event, details, priority = 'normal') {
        if (this.disabled
            || this.atCapacity
            || (source === 'client' && this.clientAtCapacity)
            || (source === 'server' && priority === 'low' && this.lowPriorityAtCapacity)
            || this.fileDescriptor === undefined) return false;
        if (!SOURCES.has(source) || !LEVELS.has(level) || !PRIORITIES.has(priority)
            || (source !== 'server' && priority !== 'normal')
            || typeof event !== 'string' || !EVENT_PATTERN.test(event)) {
            return false;
        }

        const timestamp = this.now();
        const record = {
            timestamp: timestamp instanceof Date && Number.isFinite(timestamp.getTime())
                ? timestamp.toISOString()
                : new Date().toISOString(),
            source,
            level,
            event,
        };
        if (details && Object.keys(details).length > 0) record.context = details;
        const line = `${JSON.stringify(record)}\n`;
        const byteLength = Buffer.byteLength(line);

        if (source === 'server' && priority === 'low'
            && this.lowPriorityBytesWritten + byteLength > this.maxLowPriorityBytes) {
            // Rejected/anonymous prepare traffic is deliberately bounded by its
            // own budget. Dropping it must not flip the shared server log into a
            // permanent full state and hide later operational diagnostics.
            this.lowPriorityAtCapacity = true;
            return false;
        }
        if (source === 'client' && this.clientBytesWritten + byteLength > this.maxClientBytes) {
            this.#writeCapacityMarker('client_log_capacity_reached', { maxClientBytes: this.maxClientBytes });
            this.clientAtCapacity = true;
            return false;
        }
        if (this.bytesWritten + byteLength > this.maxFileBytes) {
            this.#writeCapacityMarker('log_capacity_reached', { maxFileBytes: this.maxFileBytes });
            this.atCapacity = true;
            return false;
        }

        try {
            this.fs.writeSync(this.fileDescriptor, line, undefined, 'utf8');
            this.bytesWritten += byteLength;
            if (source === 'client') this.clientBytesWritten += byteLength;
            if (source === 'server' && priority === 'low') this.lowPriorityBytesWritten += byteLength;
            return true;
        } catch {
            this.disabled = true;
            return false;
        }
    }

    #writeCapacityMarker(event, context) {
        const timestamp = this.now();
        const line = `${JSON.stringify({
            timestamp: timestamp instanceof Date && Number.isFinite(timestamp.getTime())
                ? timestamp.toISOString()
                : new Date().toISOString(),
            source: 'server',
            level: 'warn',
            event,
            context,
        })}\n`;
        const byteLength = Buffer.byteLength(line);
        if (this.bytesWritten + byteLength > this.maxFileBytes) return;

        try {
            this.fs.writeSync(this.fileDescriptor, line, undefined, 'utf8');
            this.bytesWritten += byteLength;
        } catch {
            this.disabled = true;
        }
    }
}

module.exports = {
    CLIENT_LOG_MEDIA_TYPE,
    DEFAULT_MAX_CLIENT_BYTES,
    DEFAULT_MAX_FILE_BYTES,
    DEFAULT_MAX_LOW_PRIORITY_BYTES,
    LOG_FILE_NAME,
    MAX_CLIENT_EVENT_BYTES,
    LogStore,
    describeError,
    validateClientLogEvent,
};
