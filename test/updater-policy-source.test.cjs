/*
 * Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-policy-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'frontend');
    const server = path.join(root, 'server');
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(server, 'scripts'), { recursive: true });
    const policy = path.join(source, 'scripts/update-channel.cjs');
    fs.copyFileSync(require.resolve('../vendor/update-channel.cjs'), policy);
    const script = path.join(server, 'scripts/sync-update-policy.mjs');
    fs.copyFileSync(require.resolve('../scripts/sync-update-policy.mjs'), script);
    for (const args of [['init', '-q'], ['add', 'scripts/update-channel.cjs'],
        ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'policy']]) {
        const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
    }
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const result = run('--source', source);
    assert.equal(result.status, 0, result.stderr);
    return { source, policy, run, snapshot: path.join(server, 'vendor/update-channel.cjs') };
}

test('the policy checker verifies a snapshot against its exact committed source', t => {
    const f = fixture(t);
    assert.equal(f.run('--check').status, 0);
    assert.equal(f.run('--check', '--source', f.source).status, 0);
    fs.appendFileSync(f.snapshot, '\n// stale snapshot\n');
    const result = f.run('--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /snapshot or its source record is invalid/u);
});

test('source comparison rejects drift even when the recorded snapshot is intact', t => {
    const f = fixture(t);
    fs.appendFileSync(f.policy, '\n// source changed\n');
    const result = f.run('--check', '--source', f.source);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match its pinned and current frontend source/u);
});

test('an uncommitted source cannot replace the recorded policy snapshot', t => {
    const f = fixture(t);
    const before = fs.readFileSync(f.snapshot);
    fs.appendFileSync(f.policy, '\n// uncommitted source\n');
    assert.equal(f.run('--source', f.source).status, 1);
    assert.deepEqual(fs.readFileSync(f.snapshot), before);
});
