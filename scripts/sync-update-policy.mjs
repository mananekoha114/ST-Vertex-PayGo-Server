#!/usr/bin/env node
/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = 'scripts/update-channel.cjs';
const target = path.join(root, 'vendor/update-channel.cjs');
const recordPath = path.join(root, 'vendor/update-channel.source.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

let check = false;
let source;
for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--source' && process.argv[index + 1]) source = path.resolve(process.argv[++index]);
    else throw new Error('Usage: node scripts/sync-update-policy.mjs [--check] [--source FRONTEND_REPOSITORY]');
}

function git(args) {
    return execFileSync('git', ['-C', source, ...args], { windowsHide: true, timeout: 10000 });
}

if (check) {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const snapshot = fs.readFileSync(target);
    if (record.schema !== 1 || record.component !== 'st-vertex-paygo' || record.path !== sourcePath
        || !/^[0-9a-f]{40}$/.test(record.commit) || !/^[0-9a-f]{64}$/.test(record.sha256)
        || digest(snapshot) !== record.sha256) {
        throw new Error('The update policy snapshot or its source record is invalid. Sync it from the frontend repository.');
    }
    if (source) {
        const pinned = git(['show', `${record.commit}:${sourcePath}`]);
        const current = fs.readFileSync(path.join(source, sourcePath));
        if (!snapshot.equals(pinned) || !snapshot.equals(current)) {
            throw new Error('The update policy snapshot does not match its pinned and current frontend source.');
        }
        console.log(`Update policy matches frontend source at ${record.commit}.`);
    } else {
        console.log(`Update policy snapshot integrity verified (${record.commit}); use --source to compare frontend source.`);
    }
} else {
    if (!source) throw new Error('--source FRONTEND_REPOSITORY is required to sync the update policy.');
    const commit = git(['rev-parse', 'HEAD']).toString('utf8').trim();
    const bytes = git(['show', `${commit}:${sourcePath}`]);
    if (!bytes.equals(fs.readFileSync(path.join(source, sourcePath)))) {
        throw new Error('Commit the frontend update policy before syncing its snapshot.');
    }
    const record = { schema: 1, component: 'st-vertex-paygo', path: sourcePath, commit, sha256: digest(bytes) };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Synced update policy from frontend ${commit}.`);
}
