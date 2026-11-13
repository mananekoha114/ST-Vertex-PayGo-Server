/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

// Copy into fixed blocks rather than retaining an object per network chunk.
// Allocation and object counts depend on the byte limit, not chunk boundaries.
class BoundedBuffer {
    constructor(limit, blockSize = 64 * 1024) {
        if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(blockSize) || blockSize < 1) throw new RangeError('Invalid buffer bound');
        this.limit = limit;
        this.blockSize = blockSize;
        this.blocks = [];
        this.size = 0;
    }
    append(chunk) {
        const accepted = Math.min(chunk.length, this.limit - this.size);
        let offset = 0;
        while (offset < accepted) {
            const index = Math.floor(this.size / this.blockSize);
            const position = this.size % this.blockSize;
            if (!this.blocks[index]) this.blocks.push(Buffer.allocUnsafe(Math.min(this.blockSize, this.limit - index * this.blockSize)));
            const count = Math.min(accepted - offset, this.blocks[index].length - position);
            chunk.copy(this.blocks[index], position, offset, offset + count);
            this.size += count;
            offset += count;
        }
        return accepted === chunk.length;
    }
    toBuffer() {
        return Buffer.concat(this.blocks, this.size);
    }
}

// Collect a whole stream within a byte limit. Input beyond the limit is
// discarded instead of destroying the stream, so an HTTP request can still
// receive its error response. Resolves null when the limit was exceeded.
function readBoundedStream(stream, limit) {
    return new Promise((resolve, reject) => {
        const buffer = new BoundedBuffer(limit);
        const settle = (error, value) => {
            stream.off('data', onData);
            stream.off('end', onEnd);
            stream.off('error', onError);
            stream.off('close', onClose);
            if (error) reject(error);
            else resolve(value);
        };
        const onData = chunk => {
            if (buffer.append(chunk)) return;
            settle(null, null);
            stream.resume();
        };
        const onEnd = () => settle(null, buffer.toBuffer());
        const onError = error => settle(error);
        const onClose = () => settle(new Error('The stream closed before it ended.'));
        stream.on('data', onData);
        stream.once('end', onEnd);
        stream.once('error', onError);
        stream.once('close', onClose);
    });
}

module.exports = { BoundedBuffer, readBoundedStream };
