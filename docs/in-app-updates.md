# In-app component updates

The frontend panel can update both PayGo components without a terminal. The
rules it follows are the command-line installer's, so a panel update and a CLI
update reach the same release; what differs is the environment, because the
panel works inside a running host, without system Git and without npm.

## Why the panel needs its own implementation

`scripts/install.mjs` requires a stopped host and a system Git whose clone, tag
and ancestry commands do the version reasoning. Neither holds here: the host is
running, the plugin is itself one of the directories being replaced, and on
Android there is no system Git at all. The panel therefore keeps the installer's
*decisions* and replaces its *machinery*:

- Default channel and mode decisions come from the frontend installer's
  `scripts/update-channel.cjs`, carried as an exact snapshot in
  `vendor/update-channel.cjs`. The adjacent source record pins the frontend
  commit and SHA-256. Git tag selection and history protection are adapted in
  `src/updater/version-policy.cjs` and checked against native Git.
- Git work is done by isomorphic-git, bundled into
  `vendor/isomorphic-git.bundle.cjs` by `scripts/build-vendor.mjs`. The bundle
  is committed so that users still install nothing; `npm run vendor:check`
  fails when it no longer matches the pinned versions. The adjacent
  `vendor/THIRD_PARTY_NOTICES.txt` preserves bundled package licenses and source
  notices, generated and checked from the same build inputs. This includes the
  LGPL-3.0-or-later notice for isomorphic-git's embedded `@zenfs/core/path`
  implementation and the complete LGPL/GPL texts. The unminified bundle and
  locked build inputs remain available in this repository.
- The replacement transaction keeps the installer's shape: one lock, a staging
  directory on the same filesystem, a timestamped backup with a restore record,
  activation by rename, and rollback from that record.

After changing the frontend policy, commit it there and run
`npm run policy:sync -- --source ../ST-Vertex-PayGo` in this repository.
`npm run policy:check` verifies snapshot integrity;
`npm run policy:check -- --source ../ST-Vertex-PayGo` additionally compares the
snapshot with that exact Git commit and the current frontend source. Neither
command downloads or executes remote code. Users do not run these development
commands when installing the plugin.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/plugins/vertex-paygo/update` | Check both components and report what would change. |
| POST | `/api/plugins/vertex-paygo/update` | Start the update. Answers `202` and keeps working in the background. |
| GET | `/api/plugins/vertex-paygo/update/status` | The running job's phase and the last outcome. |

All three require an authenticated administrator, and the host's CSRF middleware
covers the write. The `/health` response advertises `capabilities.updater`,
where an absent field means this backend predates the feature, `false` means the
caller is not an administrator, and `true` means the panel may use it.

A check writes nothing to an installation. It resolves both directories, reads
their Git state, lists remote tags, clones both repositories into a staging
directory, and removes that directory again. The extension asks for a check only
when an administrator clicks, so nothing polls a remote on its own.

## Version rules

The policy follows `scripts/install.mjs`:

- The current checked-out branch takes priority over the branch recorded in
  `.git/paygo-updater.json`. With neither, a detached HEAD sitting exactly on a
  release tag identifies `main`, decided by Git and never by `package.json`.
  Each default update follows tags on `main` and commits on other branches;
  metadata from a previous one-off CLI `--mode commit` cannot pin that choice.
- On the tag channel the target follows `git describe --tags --abbrev=0`,
  including its bounded, date-ordered candidate search through merges. Two tags on one
  commit are separated by version, and a release outranks its own prereleases,
  matching `git -c versionsort.suffix=- tag --sort=-version:refname`.
- A release tag that does not look like `vMAJOR.MINOR.PATCH` is refused instead
  of ordered, because guessing could pick a different release than the CLI.
- Tracked changes, new untracked files, commits absent from the remote history, and a selected
  release older than the installed revision all stop the update. An installed
  revision that is ahead of the newest tag is kept, never downgraded.
- When both components follow tags, their selected tags must match. If either
  component is blocked the whole update stops before activation.

Native Git comparison tests cover merge history, candidate limits and same-commit
tag ordering. They require Git only on the development machine; runtime selection
uses the bundled JavaScript implementation. Unsupported tag names fail explicitly.

## What an update does

Directory resolution follows the running host's resolved startup options,
including `--dataRoot` and `--configPath`, and Luker's configurable plugin
directories. The panel does not reread a separate root `config.yaml`; changing
that file without restarting does not change the running host's paths.

Directory hosts keep the CLI's lock, staging and backups in the program root.
Luker APKs can keep both plugin directories outside the extracted program, under
the configured `dataRoot`. That data root becomes the update storage boundary
only when both directories are inside it and the running server plugin was
loaded from its configured plugin directory. A filesystem root, mixed external
roots and symlink paths are refused. Each operation resolves this layout once;
staging and `.paygo-install-backups` then stay in the same storage as the APK's
installed components. Recovery uses the targets recorded in `restore.json`.

Before downloading, both component locations are checked together. A component
must not contain the configured data root, its real path or the active config
file. Components must not overlap each other or the code-backup directory.
Components inside a data root, as used by APKs and per-user extensions, are valid.
The layout is checked again before replacement.

1. Take the installer's lock, check both components and clone the target revisions into a staging
   directory, still without touching an installation.
2. Verify each prepared copy is the component it claims to be, still has its
   entry point, and contains no symlink.
3. Write the channel record into the prepared copy.
4. Recheck the installed revisions, branches, local changes and metadata. If
   any changed during preparation, stop before replacing either component.
5. Create the backup and its `restore.json`, then rename each
   target aside and the prepared copy into place.
6. Publish the result through the status endpoint and existing server log, then
   release the lock. `restore.json` and the saved components are the on-disk
   recovery material.

An error during preparation changes nothing. An error during activation rolls
back from the backup; if rollback itself fails, the reply names the backup
directory to recover from by hand. The manual recovery steps documented for the
installer apply here too, except that the panel never rewrites `config.yaml`.

A forced process stop cannot run rollback. It may leave a mixed pair or a missing
component, together with `.paygo-install.lock`, staging and the backup's
`restore.json`. Keep the host stopped, inspect the recorded targets, and restore
each saved `frontend`/`server` directory to its recorded target; a component with
no saved directory may not have moved yet. Remove the stale lock only after
confirming no installer is running and recovery is complete. The interruption
test kills an isolated process between renames and verifies this manual recovery;
it does not demonstrate Android APK crash recovery.

## Boundaries

- **The plugin cannot repair itself.** A replacement that leaves the new plugin
  unable to load needs a host-side or manual recovery path. Automatic recovery
  from a failed start is not part of this feature.
- **Restarting is required.** Files on disk are updated while the host runs, so
  the running code is the previous version until the host restarts.
- **Non-Git installations are refused.** A copy installed from a ZIP has no
  revision to compare, so the panel reports it and points at the installer
  script instead of guessing.
- **The host has its own update channels.** Upstream SillyTavern and Luker both
  pull plugin repositories at startup when `enableServerPluginsAutoUpdate` is
  enabled (default `true`), and Luker additionally offers an extension update
  button. Those paths do not understand the paired-tag release and can move a
  component to `main` independently. The panel reports the situation but never
  edits the host configuration; pinning a release means disabling that setting.
- **Windows and macOS activation are untested.** On Windows an open handle can
  make a rename fail; the failure is reported and rollback is attempted.
  POSIX permission modes do not establish Windows ACLs. Platform-specific test
  assertions are not a substitute for running an update on those systems.
