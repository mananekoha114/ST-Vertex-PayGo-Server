/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

// Shared by the installer and the server plugin's verified vendor snapshot.
// Callers validate refs and read Git/metadata; this module makes no I/O calls.
function selectUpdateMode({ branch, mode, tag, commit, defaultBranch = 'main' }) {
    return mode || (tag ? 'tag' : commit ? 'commit' : branch === defaultBranch ? 'tag' : 'commit');
}

function inferUpdateChannel({
    symbolicBranch = null,
    recordedBranch = null,
    recordedTag = null,
    headTag = null,
    defaultBranch = 'main',
    allowUnmanaged = false,
} = {}) {
    const source = symbolicBranch ? 'branch' : recordedBranch ? 'metadata' : headTag ? 'tag' : null;
    const branch = symbolicBranch || recordedBranch || (headTag || allowUnmanaged ? defaultBranch : null);
    if (!branch) return null;
    const mode = selectUpdateMode({ branch, defaultBranch });
    return Object.freeze({
        branch,
        mode,
        tag: mode === 'tag' ? (source === 'metadata' ? recordedTag : source === 'tag' ? headTag : null) : null,
        source: source ?? 'unmanaged',
    });
}

module.exports = { inferUpdateChannel, selectUpdateMode };
