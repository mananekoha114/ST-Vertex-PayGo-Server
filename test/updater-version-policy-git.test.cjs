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
const { spawnSync } = require('node:child_process');
const { selectReleaseTag, compareTags } = require('../src/updater/version-policy.cjs');

// System Git is only an independent test oracle, never a runtime dependency.
const available = spawnSync('git', ['--version']).status === 0;
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-policy-git-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    function git(args, { input, timestamp = 1000000000 } = {}) {
        const date = `${timestamp} +0000`;
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', input,
            env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    }
    git(['init', '-q']);
    const tree = git(['mktree'], { input: '' });
    const branchHistory = [];
    const tags = [];
    function commit(name, parents, timestamp) {
        const oid = git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], { input: name, timestamp });
        branchHistory.push({ oid, parents, timestamp });
        return oid;
    }
    function tag(name, oid, annotated = false) {
        git(['tag', ...(annotated ? ['-a', '-m', name] : []), name, oid]);
        tags.push({ name, commit: oid, annotated });
    }
    function compare(head) {
        const described = git(['describe', '--tags', '--abbrev=0', head]);
        const commit = git(['rev-parse', `${described}^{commit}`]);
        const name = git(['-c', 'versionsort.suffix=-', 'tag', '--points-at', commit, '--sort=-version:refname']).split('\n')[0];
        assert.deepEqual(selectReleaseTag({ tags, branchHistory, branchHead: head }), { name, commit });
    }
    return { git, commit, tag, compare };
}

for (const olderTag of [false, true]) {
    test(`tag selection agrees with Git on a merge with older tag=${olderTag}`, { skip: !available }, t => {
        const f = fixture(t);
        const base = f.commit('base', [], 1000000000);
        const a = f.commit('a', [base], 1000000010);
        const b = f.commit('b', [a], 1000000020);
        const c = f.commit('c', [b], 1000000030);
        const side = f.commit('side', [base], 1000000090);
        const head = f.commit('merge', [c, side], 1000000100);
        f.tag('v0.4.0', side);
        f.tag('v0.5.0', c);
        if (olderTag) f.tag('v0.1.0', base, true);
        f.compare(head);
    });
}

test('tag selection agrees with Git across a branched history and its candidate limit', { skip: !available }, t => {
    const f = fixture(t);
    const commits = [];
    for (let index = 0; index < 36; index++) {
        const parents = index === 0 ? [] : [commits[index - 1]];
        if (index > 4 && index % 4 === 0) parents.push(commits[index - 4]);
        const oid = f.commit(`commit ${index}`, parents, 1000000000 + index * 10);
        commits.push(oid);
        if (index % 2 === 0) f.tag(`v0.${index}.0`, oid, index % 3 === 0);
    }
    for (const head of commits.slice(1)) f.compare(head);
});

test('same-commit prerelease ordering agrees with Git version sort', { skip: !available }, t => {
    const f = fixture(t);
    const oid = f.commit('base', [], 1000000000);
    const names = ['v0.5.0', 'v0.5.0-rc2', 'v0.5.0-rc10', 'v0.5.0-rc01', 'v0.5.0-rc001',
        'v0.5.0-rc1', 'v0.5.0-alpha.10', 'v0.5.0-alpha.2', 'v0.4.1', 'v0.10.0'];
    for (const name of names) f.tag(name, oid);
    const expected = f.git(['-c', 'versionsort.suffix=-', 'tag', '--sort=version:refname']).split('\n');
    assert.deepEqual(names.slice().sort(compareTags), expected);
    f.compare(oid);
});
