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
const { PluginError } = require('../errors.cjs');
const { METADATA_FILE } = require('./locations.cjs');

// The Git side of the updater. isomorphic-git is bundled into one committed
// file and loaded lazily, so an installation that never updates pays nothing
// and users never install a package.
//
// Two behaviours of the library shape this module:
//
// - `isDescendent` answers false for two equal object ids, so equality is
//   answered here before the library is asked. It also stops at a shallow
//   boundary, which is why ancestry is only ever asked inside the staged full
//   clone, never inside a depth-limited installation.
// - Cached pack indexes and index data live on a caller-supplied object. A
//   repository whose files the updater replaces must never reuse one, so every
//   call gets a fresh cache.

const BUNDLE_PATH = path.join(__dirname, '..', '..', 'vendor', 'isomorphic-git.bundle.cjs');
const METADATA_SCHEMA = 1;

let cachedBundle;

function loadVendoredGit() {
    if (cachedBundle === undefined) {
        const bundle = require(BUNDLE_PATH);
        if (!bundle?.git || !bundle?.http) {
            throw new PluginError(500, 'UPDATER_VENDOR_UNAVAILABLE', 'The bundled Git implementation is missing or incomplete.');
        }
        cachedBundle = bundle;
    }
    return cachedBundle;
}

function isNotFound(error) {
    return error?.code === 'NotFoundError' || error?.name === 'NotFoundError';
}

function gitFailure(action, error) {
    if (error instanceof PluginError) return error;
    const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error);
    return new PluginError(502, 'UPDATER_GIT_FAILED', `Git ${action} failed: ${message}`, { cause: error });
}

function createGitOperations({ loadBundle = loadVendoredGit, fsModule = fs } = {}) {
    // A fresh cache per call, never shared: see the note above.
    const freshCache = () => ({});

    async function readInstallation(directory) {
        const { git } = loadBundle();
        let head;
        try {
            head = await git.resolveRef({ fs: fsModule, dir: directory, ref: 'HEAD', cache: freshCache() });
        } catch (error) {
            // A directory without a repository is a normal, reportable state:
            // the host UI can install an extension from a ZIP without Git.
            if (isNotFound(error)) {
                return Object.freeze({ isRepository: false, head: null, branch: null, dirtyTrackedCount: 0, metadata: null, remoteUrl: null });
            }
            throw gitFailure('revision read', error);
        }

        let branch = null;
        try {
            branch = (await git.currentBranch({ fs: fsModule, dir: directory, fullname: false, cache: freshCache() })) ?? null;
        } catch (error) {
            throw gitFailure('branch read', error);
        }

        let dirtyTrackedCount = 0;
        try {
            const rows = await git.statusMatrix({ fs: fsModule, dir: directory, cache: freshCache() });
            // Keep the response field name for compatibility; also protect new
            // files, as the installer's status --porcelain does.
            dirtyTrackedCount = rows.filter(([, head1, workdir, stage]) => Number(workdir) !== Number(head1)
                || Number(stage) !== Number(head1)).length;
        } catch (error) {
            throw gitFailure('work tree status read', error);
        }

        return Object.freeze({
            isRepository: true,
            head,
            branch,
            dirtyTrackedCount,
            metadata: readMetadata(directory),
            remoteUrl: await readRemoteUrl(directory),
        });
    }

    function readMetadata(directory) {
        try {
            const text = fsModule.readFileSync(path.join(directory, '.git', METADATA_FILE), 'utf8');
            const record = JSON.parse(text);
            if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid record');
            return record;
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw new PluginError(409, 'UPDATER_INVALID_METADATA', 'The PayGo updater metadata could not be read as a JSON object.', { cause: error });
        }
    }

    function writeMetadata(directory, { branch, mode, tag, commit }) {
        const target = path.join(directory, '.git', METADATA_FILE);
        const record = { schema: METADATA_SCHEMA, branch, mode, tag: tag ?? null, commit: commit ?? null };
        fsModule.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
        return record;
    }

    async function readRemoteUrl(directory) {
        const { git } = loadBundle();
        try {
            const url = await git.getConfig({ fs: fsModule, dir: directory, path: 'remote.origin.url', cache: freshCache() });
            return typeof url === 'string' && url.length > 0 ? url : null;
        } catch (error) {
            if (isNotFound(error)) return null;
            throw gitFailure('remote configuration read', error);
        }
    }

    async function listRemoteTags(url) {
        const { git, http } = loadBundle();
        try {
            const refs = await git.listServerRefs({ http, url, prefix: 'refs/tags/', peelTags: true });
            return refs
                .map(entry => ({
                    name: String(entry.ref ?? '').replace(/^refs\/tags\//u, ''),
                    // An annotated tag points at its own object; the peeled id is
                    // the commit a checkout would land on.
                    commit: typeof entry.peeled === 'string' ? entry.peeled : entry.oid,
                }))
                .filter(entry => entry.name.length > 0 && typeof entry.commit === 'string' && entry.commit.length > 0);
        } catch (error) {
            throw gitFailure('tag listing', error);
        }
    }

    async function stagedClone({ url, directory, branch }) {
        const { git, http } = loadBundle();
        try {
            // No depth: the whole history is what ancestry needs. No checkout:
            // files are written only after every check has passed.
            await git.clone({ fs: fsModule, http, dir: directory, url, noCheckout: true, singleBranch: true, ref: branch, cache: freshCache() });
        } catch (error) {
            throw gitFailure('staged clone', error);
        }
        const ref = `refs/remotes/origin/${branch}`;
        let branchHead;
        try {
            branchHead = await git.resolveRef({ fs: fsModule, dir: directory, ref, cache: freshCache() });
        } catch (error) {
            throw gitFailure('staged branch resolution', error);
        }
        let history;
        try {
            history = (await git.log({ fs: fsModule, dir: directory, ref, cache: freshCache() }))
                .map(({ oid, commit }) => ({ oid, parents: commit.parent, timestamp: commit.committer.timestamp }));
        } catch (error) {
            throw gitFailure('staged history read', error);
        }
        return Object.freeze({ branchHead, history });
    }

    async function materialize({ directory, oid, branch = null }) {
        const { git } = loadBundle();
        try {
            // Tag channels detach; commit channels keep their tracking branch
            // so the next check and the command-line installer see that channel.
            await git.checkout({ fs: fsModule, dir: directory, ref: branch ?? oid, force: true, cache: freshCache() });
            const checkedOut = await git.resolveRef({ fs: fsModule, dir: directory, ref: 'HEAD', cache: freshCache() });
            if (checkedOut !== oid) throw new Error('The prepared checkout does not match the selected revision.');
        } catch (error) {
            throw gitFailure('staged checkout', error);
        }
    }

    async function isAncestor({ directory, older, newer }) {
        const { git } = loadBundle();
        if (older === newer) return true;
        try {
            return await git.isDescendent({ fs: fsModule, dir: directory, oid: newer, ancestor: older, cache: freshCache() });
        } catch (error) {
            // An object the staged clone does not have cannot be an ancestor.
            // That is how the CLI reads the same situation: a local commit is
            // absent from a fresh clone, so the ancestry test fails and the
            // update stops.
            if (isNotFound(error)) return false;
            throw gitFailure('ancestry check', error);
        }
    }

    return Object.freeze({
        isAncestor,
        listRemoteTags,
        materialize,
        readInstallation,
        readMetadata,
        readRemoteUrl,
        stagedClone,
        writeMetadata,
    });
}

module.exports = { createGitOperations, isNotFound, loadVendoredGit };
