/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

// Components update independently, so release tags no longer have to match.
// What must still match is the wire protocol: the extension refuses a server
// with another protocol version, and that refusal also hides this panel, so a
// mismatched pair could not be repaired from here. An update that would leave
// the two components on different protocol versions is therefore held back.
//
// The command-line installer applies the same rule; keep both in step.

const PROTOCOL_FILES = Object.freeze({
    frontend: 'src/constants.js',
    server: 'src/protocol.cjs',
});

function parseProtocolVersion(text) {
    const match = typeof text === 'string' ? /\bPROTOCOL_VERSION\s*=\s*(\d+)\s*;/u.exec(text) : null;
    return match ? Number(match[1]) : null;
}

function consistent(protocols) {
    const known = protocols.filter(protocol => protocol !== null);
    return known.every(protocol => protocol === known[0]);
}

/**
 * Chooses the largest set of pending updates that keeps every installed
 * component on one protocol version.
 * @param {{ name: string, changing: boolean, installed: number|null, target: number|null }[]} entries
 *   `installed` is null for a missing component; an unknown version never constrains.
 * @returns {Map<string, { protocol: number, other: string, otherProtocol: number }>} held-back updates
 */
function holdBackIncompatible(entries) {
    const changing = entries.filter(entry => entry.changing).map(entry => entry.name);
    const resulting = applied => entries.map(entry => (applied.has(entry.name) ? entry.target : entry.installed));
    // All updates first, then each single update, then none.
    const candidates = [new Set(changing), ...changing.map(name => new Set([name])), new Set()];
    // An installation that is already mismatched cannot get worse by updating,
    // and updating is the only way out of it.
    const applied = candidates.find(candidate => consistent(resulting(candidate))) ?? new Set(changing);
    const held = new Map();
    const final = new Map(entries.map((entry, index) => [entry.name, resulting(applied)[index]]));
    for (const name of changing.filter(candidate => !applied.has(candidate))) {
        const entry = entries.find(item => item.name === name);
        const other = entries.find(item => item.name !== name && final.get(item.name) !== null);
        if (other) held.set(name, { protocol: entry.target, other: other.name, otherProtocol: final.get(other.name) });
    }
    return held;
}

module.exports = { PROTOCOL_FILES, holdBackIncompatible, parseProtocolVersion };
