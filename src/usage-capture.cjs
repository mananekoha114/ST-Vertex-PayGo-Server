'use strict';

const { StringDecoder } = require('node:string_decoder');

const COUNT_FIELDS = Object.freeze([
    'promptTokenCount', 'cachedContentTokenCount', 'candidatesTokenCount',
    'thoughtsTokenCount', 'toolUsePromptTokenCount', 'totalTokenCount',
]);
const DETAIL_FIELDS = Object.freeze([
    'promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails',
]);

function sanitizeDetails(value) {
    if (!Array.isArray(value)) return undefined;
    const result = [];
    for (const item of value.slice(0, 32)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const clean = {};
        if (typeof item.modality === 'string' && item.modality.length <= 64) clean.modality = item.modality;
        if (Number.isSafeInteger(item.tokenCount) && item.tokenCount >= 0) clean.tokenCount = item.tokenCount;
        if (Object.keys(clean).length) result.push(clean);
    }
    return result.length ? result : undefined;
}

function sanitizeUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const usage = {};
    for (const field of COUNT_FIELDS) {
        if (Number.isSafeInteger(value[field]) && value[field] >= 0) usage[field] = value[field];
    }
    for (const field of DETAIL_FIELDS) {
        const details = sanitizeDetails(value[field]);
        if (details) usage[field] = details;
    }
    if (typeof value.trafficType === 'string' && value.trafficType.length <= 64) usage.trafficType = value.trafficType;
    return Object.keys(usage).length ? usage : null;
}

function usageFromJson(value) {
    if (Array.isArray(value)) {
        let latest = null;
        for (const item of value) latest = usageFromJson(item) || latest;
        return latest;
    }
    return sanitizeUsage(value?.usageMetadata);
}

class TopLevelUsageScanner {
    constructor(limit) {
        this.limit = limit;
        this.depth = 0;
        this.inString = false;
        this.escape = false;
        this.expectKey = false;
        this.readingKey = false;
        this.key = '';
        this.pendingKey = null;
        this.awaitingUsage = false;
        this.capture = null;
        this.captureDepth = 0;
        this.captureInString = false;
        this.captureEscape = false;
        this.usage = null;
        this.limitExceeded = false;
    }

    write(text) {
        for (const character of text) this.#character(character);
    }

    #character(character) {
        if (this.capture !== null) {
            if (this.capture.length < this.limit) this.capture += character;
            else this.limitExceeded = true;
            if (this.captureInString) {
                if (this.captureEscape) this.captureEscape = false;
                else if (character === '\\') this.captureEscape = true;
                else if (character === '"') this.captureInString = false;
            } else if (character === '"') this.captureInString = true;
            else if (character === '{') this.captureDepth += 1;
            else if (character === '}' && --this.captureDepth === 0) {
                if (!this.limitExceeded) {
                    try { this.usage = sanitizeUsage(JSON.parse(this.capture)) || this.usage; } catch { /* Ignore malformed metadata. */ }
                }
                this.capture = null;
            }
        }

        if (this.inString) {
            if (this.escape) this.escape = false;
            else if (character === '\\') this.escape = true;
            else if (character === '"') {
                this.inString = false;
                if (this.readingKey) {
                    this.pendingKey = this.key;
                    this.readingKey = false;
                    this.expectKey = false;
                }
            } else if (this.readingKey && this.key.length < 64) this.key += character;
            return;
        }
        if (character === '"') {
            this.inString = true;
            if (this.depth === 1 && this.expectKey) {
                this.readingKey = true;
                this.key = '';
            }
            return;
        }
        if (character === '{') {
            this.depth += 1;
            if (this.depth === 1) this.expectKey = true;
            if (this.awaitingUsage && this.depth === 2) {
                this.capture = '{';
                this.captureDepth = 1;
                this.captureInString = false;
                this.captureEscape = false;
                this.limitExceeded = false;
                this.awaitingUsage = false;
            }
            return;
        }
        if (character === '}') {
            this.depth = Math.max(0, this.depth - 1);
            return;
        }
        if (this.depth === 1 && character === ':' && this.pendingKey) {
            this.awaitingUsage = this.pendingKey === 'usageMetadata';
            this.pendingKey = null;
            return;
        }
        if (this.depth === 1 && character === ',') {
            this.expectKey = true;
            this.pendingKey = null;
            this.awaitingUsage = false;
        }
    }
}

class UsageCapture {
    constructor({ stream, maxBufferBytes = 256 * 1024 } = {}) {
        this.stream = stream;
        this.maxBufferBytes = maxBufferBytes;
        this.buffer = '';
        this.decoder = new StringDecoder('utf8');
        this.usage = null;
        this.limitExceeded = false;
        this.droppingEvent = false;
        this.scanner = stream ? null : new TopLevelUsageScanner(maxBufferBytes);
    }

    #merge(usage) {
        if (usage) {
            this.usage = { ...(this.usage || {}), ...usage };
            this.limitExceeded = false;
        }
    }

    #event(event) {
        const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') return;
        try { this.#merge(usageFromJson(JSON.parse(data))); } catch { /* Observation cannot break forwarding. */ }
    }

    #streamText(text) {
        this.buffer += text;
        for (;;) {
            const match = /\r?\n\r?\n/u.exec(this.buffer);
            if (!match) break;
            const event = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            if (!this.droppingEvent && Buffer.byteLength(event) <= this.maxBufferBytes) this.#event(event);
            else if (!this.droppingEvent) this.limitExceeded = true;
            this.droppingEvent = false;
        }
        if (Buffer.byteLength(this.buffer) > this.maxBufferBytes) {
            this.limitExceeded = true;
            this.droppingEvent = true;
            this.buffer = this.buffer.slice(-3);
        }
    }

    write(chunk) {
        const text = this.decoder.write(chunk);
        if (this.stream) this.#streamText(text);
        else this.scanner.write(text);
    }

    finish() {
        const tail = this.decoder.end();
        if (this.stream) {
            this.#streamText(tail);
            if (this.buffer && !this.droppingEvent) this.#event(this.buffer);
        } else {
            this.scanner.write(tail);
            this.#merge(this.scanner.usage);
            this.limitExceeded ||= this.scanner.limitExceeded;
        }
        this.buffer = '';
        if (!this.usage) return null;
        const usage = { ...this.usage };
        for (const field of ['cachedContentTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount']) {
            if (usage[field] === undefined) usage[field] = 0;
        }
        return usage;
    }
}

module.exports = { TopLevelUsageScanner, UsageCapture, sanitizeUsage, usageFromJson };
