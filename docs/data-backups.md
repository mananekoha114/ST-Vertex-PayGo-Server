# PayGo data recovery points

The server plugin snapshots the per-user usage ledger and persisted bridge
configuration at startup, before a panel update actually replaces components,
and before applying a restore. Unchanged contents do not create another
snapshot. Checking for updates or finding no update creates no snapshot.

These are local recovery points. There is no timer or continuous backup while
the host remains running, and a copy on the same device does not protect
against losing that device. Chat, host settings, Google credentials and request
logs remain under their existing host or plugin policies.

## Storage and retention

Active data stays in its existing location:

- `<user>/vertex-paygo/usage-ledger.jsonl`
- `<user>/vertex-paygo/openai-bridge-state.json`

Snapshots are `vertex-paygo-data_<timestamp>_<uuid>.pgbak` files in the
host's per-user `backups` directory. Each has a versioned JSON metadata header
followed by a gzip body, with exact-byte sizes and SHA-256 checksums. The body
may contain the bridge access key; protect snapshots like the original bridge
configuration. List responses expose metadata only.

On POSIX systems, snapshots are created with mode `0600`. On Windows, access
depends on the host user directory's inherited ACL; the POSIX mode does not
establish a private Windows ACL. Keep host user directories and exported
snapshots restricted to their intended owner.

Retention follows the host's positive integer
`backups.common.numberOfBackups`. Only verified PayGo snapshot headers belonging
to that user participate in rotation. A new snapshot is written and verified
before older ones are removed. A queued restore target stays pinned until it is
applied or cancelled, so the count can temporarily exceed the configured limit.
Damaged or foreign headers are left untouched. This is a file-count policy,
not a disk quota.

A disabled or invalid retention value is reported explicitly. Startup backup
errors are recorded and visible in the recovery dialog. A failed pre-update
snapshot stops component replacement. Each source file is limited to 64 MiB;
the snapshot body and archive are bounded at 96 MiB. Oversized data fails
explicitly rather than being truncated. Cold-path snapshot reads are
synchronous so the plugin cannot append ledger records between their reads.

## Restore

Open **Restore PayGo data** in the PayGo panel, choose a recovery point and
confirm. The server records the request; current data continues to be used until
the host restarts. The dialog also allows cancelling a pending request.

At the next startup, before PayGo listeners, ledger caches or bridge restoration
start, the plugin validates the selected snapshot, saves current files, and
applies the selected bytes. A replacement failure rolls back. An interrupted
replacement is detected by its per-user journal and rolled back on the next
startup; an incomplete rollback prevents PayGo from starting against a mixed
pair. The failure remains visible and can be cancelled. Even damaged current
files are preserved as raw rollback material; those snapshots are not offered
as valid restore targets.

Restoring replaces the selected ledger and bridge configuration; newer ledger
entries are not merged. The pre-restore snapshot can undo the operation when
the previous files existed. The bridge's saved enabled state and access key are
restored too. Its existing credential-binding checks still decide whether it
can start; Google credentials themselves are never restored by this feature.

Luker's full-data ZIP includes these snapshot files when **Settings** is selected.
Restoring that ZIP puts the snapshots back into the backups directory. Apply a
snapshot separately through the PayGo recovery dialog. The restore journal is
outside the host backup directory so importing a ZIP cannot import a pending
restore instruction.

## HTTP contract

All operations use the authenticated user's trusted host directories. The host
authenticates requests and applies CSRF protection to writes. No caller-supplied
user or path is accepted. `/health` advertises `capabilities.dataBackups`; older
backends omit it and the frontend hides the recovery entry.

| Method | Route under `/api/plugins/vertex-paygo` | Result |
| --- | --- | --- |
| GET | `/data-backups?limit=20&cursor=...` | `ok`, metadata `entries`, restore `pending`, `errorCode`, `nextCursor`; limit 1–100. |
| POST | `/data-restore` | Body `{ "backupId": "..." }`; validates the snapshot and returns `ok`, `restartRequired: true`. Repeating the same queued target is idempotent; a different target requires cancellation. |
| POST | `/data-restore/cancel` | Cancels an unapplied request. Repeating cancellation is harmless. |

Errors use the existing plugin HTTP status, `code`, and safe `message` contract.
Snapshots and recovery are independent of the code directories retained by the
component updater or command-line installer. This feature does not change the
installer, update version policy, or code-backup retention.
