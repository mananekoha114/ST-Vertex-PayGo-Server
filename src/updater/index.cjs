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
const { isDeepStrictEqual } = require('node:util');
const { PluginError } = require('../errors.cjs');
const { createGitOperations } = require('./git-operations.cjs');
const {
    OFFICIAL_REMOTES,
    assertSafeLayout,
    locateComponent,
    resolveDirectories,
    serverDirectory,
} = require('./locations.cjs');
const transaction = require('./transaction.cjs');
const {
    ACTION_UPDATE,
    inferChannel,
    planUpdate,
    selectReleaseTag,
} = require('./version-policy.cjs');

// Orchestration: decide what both components should become, prepare them both,
// and only then touch the installed copies.
//
// A check never writes to an installation. Everything a check learns comes from
// a staged clone that is removed again, so a failed check cannot leave a
// half-updated host. The panel asks for a check only when the administrator
// clicks, so no polling happens behind the user's back.

const COMPONENTS = Object.freeze([
    Object.freeze({ name: 'frontend', label: 'frontend extension', remote: OFFICIAL_REMOTES.frontend }),
    Object.freeze({ name: 'server', label: 'server plugin', remote: OFFICIAL_REMOTES.server }),
]);

// The activated tree must still be the component it claims to be, must still
// have its entry point, and must not smuggle symlinks into the host.
function verifyPayload(component, directory) {
    if (component.name === 'frontend') {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        if (manifest?.display_name !== 'Vertex AI PayGo Tiers') {
            throw new PluginError(409, 'UPDATER_PAYLOAD_MISMATCH', 'The prepared frontend copy is not the PayGo extension.');
        }
        for (const field of ['js', 'css']) {
            const entry = manifest[field];
            if (typeof entry !== 'string' || !isFileInside(directory, entry)) {
                throw new PluginError(409, 'UPDATER_PAYLOAD_INCOMPLETE', `The prepared frontend copy is missing its ${field} entry point.`);
            }
        }
    } else {
        const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        if (pkg?.name !== 'st-vertex-paygo-server') {
            throw new PluginError(409, 'UPDATER_PAYLOAD_MISMATCH', 'The prepared server copy is not the PayGo server plugin.');
        }
        if (typeof pkg.main !== 'string' || !isFileInside(directory, pkg.main)) {
            throw new PluginError(409, 'UPDATER_PAYLOAD_INCOMPLETE', 'The prepared server copy is missing its main entry point.');
        }
    }
    assertNoSymlinks(directory);
}

function isFileInside(directory, relative) {
    if (typeof relative !== 'string' || relative.length === 0) return false;
    const resolved = path.resolve(directory, relative);
    return resolved.startsWith(`${path.resolve(directory)}${path.sep}`)
        && fs.existsSync(resolved)
        && fs.statSync(resolved).isFile();
}

function assertNoSymlinks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const child = path.join(directory, entry.name);
        if (entry.isSymbolicLink() || fs.lstatSync(child).isSymbolicLink()) {
            throw new PluginError(409, 'UPDATER_PAYLOAD_SYMLINK', `The prepared copy contains a symlink: ${child}`);
        }
        if (entry.isDirectory()) assertNoSymlinks(child);
    }
}

function createUpdater({
    logStore = null,
    dataBackups = null,
    gitOperations = createGitOperations(),
    commandLine = globalThis.COMMAND_LINE_ARGS,
    rootDir = null,
    pluginDirectory = serverDirectory(),
    now = () => new Date(),
} = {}) {
    const hostRoot = rootDir ?? process.cwd();
    let job = null;
    let lastResult = null;

    function note(level, event, context = undefined) {
        try {
            logStore?.server?.(level, event, context);
        } catch {
            // Diagnostics must never change the outcome of an update.
        }
    }

    function directories() {
        return resolveDirectories(hostRoot, { commandLine, pluginDirectory });
    }

    function locate(component, resolved) {
        const found = locateComponent(component.name, resolved);
        if (found.length === 0) {
            throw new PluginError(
                409,
                'UPDATER_COMPONENT_MISSING',
                `The ${component.label} could not be found where this host installs it. Install it with the host's own installer, then retry.`,
            );
        }
        if (found.length > 1) {
            throw new PluginError(
                409,
                'UPDATER_COMPONENT_AMBIGUOUS',
                `Several copies of the ${component.label} exist: ${found.join(', ')}. Remove the extra copies and retry.`,
            );
        }
        return found[0];
    }

    // Everything a decision needs, with nothing written to the installation.
    async function planComponent(component, staging, tags) {
        const directory = component.directory;
        const installation = await gitOperations.readInstallation(directory);
        const base = {
            name: component.name,
            label: component.label,
            directory,
            originMismatch: Boolean(installation.remoteUrl) && installation.remoteUrl !== component.remote,
        };
        if (!installation.isRepository) {
            return { ...base, status: 'not-a-repository', reason: 'This copy is not a Git checkout, so the panel cannot update it. Use the installer script for a ZIP installation.' };
        }
        const channel = inferChannel({
            symbolicBranch: installation.branch,
            metadata: installation.metadata,
            headTags: tags.namesByCommit.get(installation.head) ?? [],
        });
        const staged = path.join(staging, component.name);
        const { branchHead, history } = await gitOperations.stagedClone({ url: component.remote, directory: staged, branch: channel.branch });
        const target = channel.mode === 'tag'
            ? selectReleaseTag({ tags: tags.entries, branchHistory: history, branchHead })
            : { name: null, commit: branchHead };
        const decision = await planUpdate({
            installedHead: installation.head,
            installedBranch: installation.branch,
            dirtyTrackedCount: installation.dirtyTrackedCount,
            channel,
            metadata: installation.metadata,
            target,
            branchHead,
            isAncestor: (older, newer) => gitOperations.isAncestor({ directory: staged, older, newer }),
        });
        return {
            ...base,
            status: decision.action,
            channel: { branch: channel.branch, mode: channel.mode, source: channel.source },
            installed: { commit: installation.head, branch: installation.branch, dirtyTrackedCount: installation.dirtyTrackedCount },
            target: { tag: decision.tag, commit: decision.commit },
            reason: decision.reason ?? null,
            staged,
            originalMetadata: installation.metadata ?? null,
        };
    }

    async function planAll(resolved) {
        const located = COMPONENTS.map(component => ({ ...component, directory: locate(component, resolved) }));
        assertSafeLayout(resolved, located.map(component => component.directory), path.join(resolved.updateRoot, transaction.BACKUP_ROOT));
        const staging = transaction.createStaging(resolved.updateRoot);
        try {
            const planned = [];
            for (const component of located) {
                const entries = await gitOperations.listRemoteTags(component.remote);
                const namesByCommit = new Map();
                for (const entry of entries) {
                    namesByCommit.set(entry.commit, [...(namesByCommit.get(entry.commit) ?? []), entry.name]);
                }
                planned.push(await planComponent(component, staging, { entries, namesByCommit }));
            }
            const tagged = planned.filter(component => component.channel?.mode === 'tag');
            if (tagged.length === 2 && tagged[0].target.tag !== tagged[1].target.tag) {
                throw new PluginError(409, 'UPDATER_TAG_MISMATCH',
                    `Frontend/server tags are not aligned (${tagged[0].target.tag} / ${tagged[1].target.tag}). Wait for matching tags.`);
            }
            return { staging, components: planned };
        } catch (error) {
            transaction.removePath(staging);
            throw error;
        }
    }

    function summarise(components) {
        const blocked = components.filter(component => !['update', 'unchanged', 'keep-ahead'].includes(component.status));
        const updatable = components.filter(component => component.status === ACTION_UPDATE);
        return {
            status: blocked.length > 0 ? 'blocked' : updatable.length > 0 ? 'update-available' : 'up-to-date',
            upToDate: updatable.length === 0 && blocked.length === 0,
        };
    }

    async function check() {
        const plan = await planAll(directories());
        try {
            return { ...summarise(plan.components), checkedAt: now().toISOString(), components: plan.components.map(publicComponent) };
        } finally {
            transaction.removePath(plan.staging);
        }
    }

    function publicComponent(component) {
        return {
            name: component.name,
            label: component.label,
            status: component.status,
            reason: component.reason ?? null,
            originMismatch: component.originMismatch === true,
            channel: component.channel ?? null,
            installed: component.installed ?? null,
            target: component.target ?? null,
        };
    }

    // One update at a time. The work continues after the starting request has
    // been answered, because a host restart or a client timeout must not abort
    // a replacement that is already moving files.
    function start() {
        if (job !== null) {
            throw new PluginError(409, 'UPDATER_IN_PROGRESS', 'An update is already running.');
        }
        job = { phase: 'checking', startedAt: now().toISOString() };
        lastResult = null;
        // Both outcomes resolve with the recorded result: the caller that
        // started the job is answered immediately, and the panel reads the
        // outcome from the status route.
        const running = run().catch(error => {
            lastResult = {
                status: 'failed',
                finishedAt: now().toISOString(),
                code: error?.code ?? 'UPDATER_FAILED',
                message: error?.message ?? String(error),
            };
            note('error', 'updater_failed', { errorCode: lastResult.code });
        }).then(() => lastResult).finally(() => {
            job = null;
        });
        return running;
    }

    async function run() {
        let plan = null;
        let lock = null;
        try {
            // Share the installer's lock throughout preparation, then recheck
            // snapshots to catch edits by tools that do not honor this lock.
            const resolved = directories();
            lock = transaction.acquireLock(resolved.updateRoot);
            plan = await planAll(resolved);
            // The two components ship as one release. Updating only the half that
            // happens to be updatable would leave a host running mismatched
            // versions, so a blocked component stops the whole update, exactly as
            // the command-line installer stops when a component is missing.
            const blocked = plan.components.filter(component => !['update', 'unchanged', 'keep-ahead'].includes(component.status));
            if (blocked.length > 0) {
                throw new PluginError(
                    409,
                    'UPDATER_COMPONENT_BLOCKED',
                    `The update was not started: ${blocked.map(component => `${component.label}: ${component.reason ?? component.status}`).join(' ')}`,
                );
            }
            const changing = plan.components.filter(component => component.status === ACTION_UPDATE);
            if (changing.length === 0) {
                lastResult = {
                    status: 'no-change',
                    finishedAt: now().toISOString(),
                    components: plan.components.map(publicComponent),
                };
                return lastResult;
            }

            job.phase = 'preparing';
            for (const component of changing) {
                await gitOperations.materialize({ directory: component.staged, oid: component.target.commit,
                    branch: component.channel.mode === 'commit' ? component.channel.branch : null });
                verifyPayload(component, component.staged);
                gitOperations.writeMetadata(component.staged, {
                    branch: component.channel.branch,
                    mode: component.channel.mode,
                    tag: component.target.tag,
                    commit: component.target.commit,
                });
            }

            job.phase = 'activating';
            for (const component of plan.components) {
                const directory = locate(component, resolved);
                const current = await gitOperations.readInstallation(directory);
                if (directory !== component.directory || !current.isRepository || current.dirtyTrackedCount > 0
                    || current.head !== component.installed.commit || current.branch !== component.installed.branch
                    || !isDeepStrictEqual(current.metadata ?? null, component.originalMetadata)) {
                    throw new PluginError(409, 'UPDATER_INSTALLATION_CHANGED',
                        `The ${component.label} changed during preparation. Nothing was replaced; check again.`);
                }
            }
            const entries = changing.map(component => ({
                name: component.name,
                target: component.directory,
                staged: component.staged,
            }));
            assertSafeLayout(resolved, plan.components.map(component => component.directory), path.join(resolved.updateRoot, transaction.BACKUP_ROOT));
            await dataBackups?.beforeUpdate();
            const backup = transaction.createBackup(resolved.updateRoot, entries);
            transaction.activate({ rootDir: resolved.updateRoot, backup, entries });

            const components = plan.components.map(component => (component.status === ACTION_UPDATE
                ? { ...publicComponent(component), status: 'updated' }
                : publicComponent(component)));
            lastResult = {
                status: 'updated',
                finishedAt: now().toISOString(),
                backup,
                restartRequired: true,
                components,
            };
            note('info', 'updater_updated', { components: changing.map(component => component.name).join(',') });
            return lastResult;
        } finally {
            if (lock !== null) {
                try {
                    transaction.releaseLock(lock);
                } catch (error) {
                    note('warn', 'updater_lock_release_failed', { detail: String(error?.message ?? error).slice(0, 256) });
                }
            }
            if (plan !== null) transaction.removePath(plan.staging);
        }
    }

    function status() {
        return {
            running: job !== null,
            job: job === null ? null : { phase: job.phase, startedAt: job.startedAt },
            lastResult,
        };
    }

    return Object.freeze({ check, start, status });
}

module.exports = { COMPONENTS, createUpdater, verifyPayload };
