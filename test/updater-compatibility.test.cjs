/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdBackIncompatible, parseProtocolVersion } = require('../src/updater/compatibility.cjs');

const entry = (name, changing, installed, target = null) => ({ name, changing, installed, target });

test('protocol versions are read from both component sources', () => {
    assert.equal(parseProtocolVersion('export const PROTOCOL_VERSION = 2;\n'), 2);
    assert.equal(parseProtocolVersion("const PROTOCOL_VERSION = 13;\nconst PLUGIN_ID = 'vertex-paygo';"), 13);
    assert.equal(parseProtocolVersion('const OTHER = 2;'), null);
    assert.equal(parseProtocolVersion(null), null);
});

test('updates that keep one protocol are all applied', () => {
    assert.deepEqual([...holdBackIncompatible([entry('frontend', true, 2, 2), entry('server', true, 2, 2)])], []);
    assert.deepEqual([...holdBackIncompatible([entry('frontend', true, 2, 3), entry('server', true, 2, 3)])], []);
    assert.deepEqual([...holdBackIncompatible([entry('frontend', true, 2, 2), entry('server', false, 2)])], []);
});

test('the update that would split the pair is held back, not the compatible one', () => {
    assert.deepEqual(holdBackIncompatible([entry('frontend', true, 2, 3), entry('server', false, 2)]),
        new Map([['frontend', { protocol: 3, other: 'server', otherProtocol: 2 }]]));
    // The server cannot move to v3 alone, but the frontend can still take a v2 release.
    assert.deepEqual(holdBackIncompatible([entry('frontend', true, 2, 2), entry('server', true, 2, 3)]),
        new Map([['server', { protocol: 3, other: 'frontend', otherProtocol: 2 }]]));
});

test('unknown or missing components never constrain, and a broken pair may still update', () => {
    assert.equal(holdBackIncompatible([entry('frontend', true, 2, null), entry('server', false, 2)]).size, 0);
    assert.equal(holdBackIncompatible([entry('frontend', false, null), entry('server', true, 2, 3)]).size, 0);
    assert.equal(holdBackIncompatible([entry('frontend', true, 3, 4), entry('server', true, 2, 5)]).size, 0);
});
