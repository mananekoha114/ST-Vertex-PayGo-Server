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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGitOperations, loadVendoredGit } = require('../src/updater/git-operations.cjs');

async function repository(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-git-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { git } = loadVendoredGit();
    await git.init({ fs, dir: directory, defaultBranch: 'dev' });
    fs.writeFileSync(path.join(directory, 'index.js'), 'old\n');
    fs.writeFileSync(path.join(directory, '.gitignore'), 'ignored.txt\n');
    for (const filepath of ['index.js', '.gitignore']) await git.add({ fs, dir: directory, filepath });
    const author = { name: 'fixture', email: 'fixture@example.invalid' };
    const first = await git.commit({ fs, dir: directory, author, message: 'old' });
    fs.writeFileSync(path.join(directory, 'index.js'), 'new\n');
    await git.add({ fs, dir: directory, filepath: 'index.js' });
    const last = await git.commit({ fs, dir: directory, author, message: 'new' });
    return { directory, git, first, last, operations: createGitOperations() };
}

test('the bundled Git distinguishes branch checkouts, detached tags and ancestry', async t => {
    const { directory, git, first, last, operations } = await repository(t);
    assert.equal(await operations.isAncestor({ directory, older: first, newer: last }), true);
    assert.equal(await operations.isAncestor({ directory, older: last, newer: first }), false);
    assert.equal(await operations.isAncestor({ directory, older: last, newer: last }), true);
    await operations.materialize({ directory, oid: first });
    assert.equal((await operations.readInstallation(directory)).branch, null);
    await operations.materialize({ directory, oid: last, branch: 'dev' });
    assert.equal(await git.currentBranch({ fs, dir: directory }), 'dev');
    assert.equal((await operations.readInstallation(directory)).head, last);
    await assert.rejects(operations.materialize({ directory, oid: first, branch: 'dev' }), error => error.code === 'UPDATER_GIT_FAILED');
});

test('new untracked and staged files block replacement while ignored files do not', async t => {
    const { directory, git, operations } = await repository(t);
    fs.writeFileSync(path.join(directory, 'ignored.txt'), 'ignored\n');
    assert.equal((await operations.readInstallation(directory)).dirtyTrackedCount, 0);
    fs.writeFileSync(path.join(directory, 'new.txt'), 'keep my work\n');
    assert.equal((await operations.readInstallation(directory)).dirtyTrackedCount, 1);
    await git.add({ fs, dir: directory, filepath: 'new.txt' });
    assert.equal((await operations.readInstallation(directory)).dirtyTrackedCount, 1);
});

test('corrupt updater metadata fails explicitly without echoing file contents', async t => {
    const { directory, operations } = await repository(t);
    fs.writeFileSync(path.join(directory, '.git/paygo-updater.json'), '{ fixture-private-text');
    await assert.rejects(operations.readInstallation(directory), error => {
        assert.equal(error.code, 'UPDATER_INVALID_METADATA');
        assert.equal(error.message.includes('fixture-private-text'), false);
        return true;
    });
});

test('a Git branch read failure is not interpreted as detached HEAD', async t => {
    const { directory } = await repository(t);
    const operations = createGitOperations({ loadBundle: () => ({ git: {
        resolveRef: async () => 'a'.repeat(40),
        currentBranch: async () => { throw new Error('fixture branch read failure'); },
        statusMatrix: async () => [],
        getConfig: async () => undefined,
    } }) });
    await assert.rejects(operations.readInstallation(directory), error => error.code === 'UPDATER_GIT_FAILED');
});
