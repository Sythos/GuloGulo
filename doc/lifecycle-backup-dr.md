# Retention, backups, restore, and operational observability

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

M7 is the point where Gulo Gulo starts treating deletion, recovery, and
operations as first-class product behavior. The modules in this guide are
deliberately adapter-friendly contracts. They can be tested on a workstation
without mounting a user's mailbox, while still making the dangerous decisions
explicit before a PostgreSQL, object-storage, or platform-specific adapter is
connected.

## The M7 map

```text
src/core/lifecycle/
├── retention.ts                28-day trash purge and restore-safe locks
├── account-lifecycle.ts        deletion, recovery window, and purge states
├── account-lifecycle-wiring.ts wires the state machine to real backup/purge adapters
└── run-purge-batch.ts          CLI entry point for a systemd-timer-driven purge worker

src/core/backup/
├── backup-contract.ts          user/provider scope, encrypted manifests, restore
└── filesystem-backup-adapter.ts real local-disk storage for the manifests/archives above

src/core/observability/
├── log-policy.ts               bounded log-rotation policy (Docker json-file
│                                driver, journald, or a sidecar collector)
├── structured-event.ts         redacted audit and operational envelopes
└── alert-policy.ts             deterministic health and capacity alerts
```

Run the focused suite with:

```text
npm run test:m7
```

The regular `npm test` command runs it as part of the repository gate. The
tests are sequential and deterministic. They prove policy and privacy
contracts; they do not claim that a live storage backend, mail service, or
backup target is attached.

## Trash retention and purge

`createRetentionStore()` uses a 28-day server-side retention boundary. The
client's empty-trash action is not a request to erase immediately: it marks an
item with a tenant and user scope, a resource type, a deletion timestamp, and
an idempotency key. A bounded worker later calls `runPurgeBatch()`.

The worker contract is intentionally conservative:

- the 28-day boundary is checked on the server clock;
- batches have a hard item limit;
- a lease lock prevents two workers from processing the same scope;
- operation IDs make retries return the original result;
- legal/operational retention holds block selection;
- a restore or new hold is re-checked after the adapter callback;
- an adapter failure leaves the item recoverable and emits metadata-only audit;
- metrics cover candidates, purges, skips, failures, and restores.

The adapter must delete the actual message, folder, calendar, or contact only
after the contract has returned a selected item. It must never derive tenant or
user scope from a mailbox path supplied by the browser.

```js
const result = store.runPurgeBatch({
  workerId: 'retention-worker-01',
  operationId: 'purge-2026-08-22-0001',
  tenantId: 'example.test',
  userId: 'ada@example.test',
  limit: 100,
});
```

### Scheduled purge worker (`run-purge-batch.ts`)

`runPurgeBatch()` above was, until now, called only from tests — nothing in
the repository invoked it periodically. `src/core/lifecycle/run-purge-batch.ts`
is a small CLI entry point meant to be triggered by
`packaging/shared/gulogulo-purge.timer` (a daily systemd timer) running
`packaging/shared/gulogulo-purge.service` (a `oneshot` unit), the same
"the host owns scheduling" model already used for the main
`gulogulo.service` unit.

**VERIFY BEFORE USE.** Two things are true at the same time here, and both
matter:

- The process/timer/exit-code plumbing is real and tested
  (`run-purge-batch.test.ts`): it resolves a retention store through an
  injectable `resolveStore()` seam, runs one batch, logs a one-line summary,
  and exits non-zero if the batch reported failures.
- `createRetentionStore()` itself (above) keeps its state in a process-local
  `Map`. It has no persistent backing store in this repository today. A
  fresh `node run-purge-batch.ts` invocation therefore always starts with
  zero trashed items and purges nothing, regardless of what an earlier run
  did — this is the honest current behavior, not a bug in the script.
  `resolveDefaultRetentionStore()` reports `persistent: false` for exactly
  this reason, and the script logs "no persistent retention store
  configured; nothing to purge" and exits `0`, mirroring how
  `packaging/standalone/scripts/run-migrations.mjs` already exits cleanly
  when `POSTGRES_ENABLED=false`. The day a persistent retention store exists
  (e.g. PostgreSQL-backed, following the same pattern as
  `src/core/dav/caldav/postgres-caldav-store.ts`), swapping it into
  `resolveStore()` is the only change needed — the timer, the service unit,
  and this script's process/exit-code plumbing do not.
- Neither `src/core/lifecycle/**/*.ts` nor the two new unit files are wired
  into `npm run build:server` or any `packaging/*/build-*-package.ts` /
  `install.sh` script yet — deliberately out of scope for this change (see
  the top-of-file comment in `run-purge-batch.ts` and in
  `gulogulo-purge.service`). Until that follow-up lands, the systemd units
  reference a `dist/server/...` path that does not exist yet in a built
  package.

## Account deletion lifecycle

`createAccountLifecycleStore()` keeps account deletion separate from item
retention. The normal state flow is:

```text
active
  -> deletion_requested
  -> soft_deleted
  -> purge_pending
  -> purged
```

There is a 28-day recovery window by default. A strong confirmation string,
tenant/user scope, and a request ID are required before the final purge. Legal
or operational holds stop both the transition and the per-resource purge plan.
The cleanup plan names aliases, delegations, factors, backup links, mailbox,
and DAV collections individually, so a partially completed adapter can be
retried without silently skipping a resource.

The contract does not erase LDAP or PostgreSQL rows itself. The integration
service must execute the plan transactionally where possible, record a
metadata-only event for every resource result, and make a failed plan visible
to the tenant's operational tooling.

### Wiring to real adapters (`account-lifecycle-wiring.ts`)

`createAccountLifecycleWiring()` is the "integration service" the paragraph
above calls for — a thin composition layer over `account-lifecycle.ts`,
`filesystem-backup-adapter.ts`, and `retention.ts`'s `runPurgeBatch()`. It
does not implement deletion itself; `account-lifecycle.ts`'s own rule
("adapters own permanent resource deletion") is unchanged. What it does:

- `completePurge()` re-checks state (`purge_pending`), the strong
  `PURGE:<userId>` confirmation, and active holds itself, before calling any
  adapter — so a caller mistake fails closed without any real deletion
  happening, not only when the underlying store finally rejects it.
- For every resource in the account's `cleanupPlan`: the `'backups'`
  resource is purged by calling `deleteAccountArchives()` on the injected
  `BackupStorageAdapter` directly (Compito 1 already provides a real
  implementation for it); every other resource type (aliases, delegations,
  factors, mailbox, dav_collections, preferences) is routed through an
  injected `purgeResource` callback that the caller supplies — the actual
  LDAP/PostgreSQL/mailbox/DAV deletion logic still lives with those
  adapters, not here.
- Once every resource reports `'purged'`, and only then, it calls
  `retentionStore.runPurgeBatch()` scoped to the same tenant/user (when a
  `retentionStore` was injected) so any of that user's still-trashed items
  do not linger past the account's own purge, and finally calls the
  underlying `lifecycleStore.completePurge()` with the collected
  `resourceResults`.
- `queuePurge()` is a thin wrapper that, when a `backupAdapter` is
  injected, also logs how many backup archives already exist for the
  account at the moment its recovery window elapses — informational only,
  never blocking.

This composition lives in its own file rather than as hooks inside
`account-lifecycle.ts` on purpose: `account-lifecycle.ts` and
`backup-contract.ts` are deliberately pure, dependency-free contracts (see
their own file comments), and importing a filesystem adapter into either
would break that property for every caller, including ones that never touch
a filesystem.

## User backup

`createUserBackupScope()` is self-service by default. The caller can request
mail, folders, iCalendar, vCard, and preferences only for the same tenant and
user. Session IDs, cookies, access tokens, password hashes, recovery codes,
factor secrets, and private keys are excluded before an archive manifest is
created.

`createArchiveManifest()` records canonical member paths and SHA-256 checksums.
Metadata is encrypted with AES-256-GCM using a reference to an external key;
the raw key is never serialized in the manifest. A user download is represented
by an opaque HTTPS link with a short expiry and revocation state. The link is a
capability for the already-authorized archive, not a new login mechanism.

The storage adapter should place archives outside the live application
process's own filesystem (outside the install/extension directory on any of
the three packaging targets) and apply its own encryption-at-rest, access
logging, lifecycle, and malware scanning policy. A failed checksum or
expired/revoked link must fail closed.

### The local filesystem backup adapter — and why it is not disaster recovery

`src/core/backup/filesystem-backup-adapter.ts` is a real, disk-writing
implementation of the storage side of the contract above: every method
performs actual `node:fs/promises` I/O (manifest JSON, raw entry bytes, and
the encrypted-metadata envelope, all written under a
`<tenantId>/<userId>/<archiveId>/` layout), not a mock or a
validation-only stub. `BackupStorageAdapter` is the generic interface it
implements — deliberately storage-agnostic, so a future remote adapter
(rsync to another host, an S3-compatible object store) can be dropped in
without `backup-contract.ts`, `account-lifecycle-wiring.ts`, or any other
caller changing.

Every current `PlatformAdapter` (`standalone`, `cpanel`, `plesk`) exposes
this local adapter through the new `createBackupStorage(config)` contract
method, defaulting to `/var/lib/gulogulo/backups` — the same
`%{_localstatedir}`-style data directory `mail.mailboxRoot` and the patch
status file already default to — and overridable per-install via
`contract.backup.path` in the loaded configuration.

**This default is a fast-recovery convenience, not disaster recovery, and
that distinction must stay explicit rather than implied:**

- **What it protects against:** accidental deletion, a bad restore, or
  needing an earlier version of an archive within the retention window. The
  data is on disk, in a known layout, with checksummed manifests, ready to
  read back immediately.
- **What it does NOT protect against:** a failed disk, a lost host, or
  anything else that takes the machine the live data lives on down with
  it — because, without a remote/external adapter, the backup is on the
  *same* disk (or at least reachable from the same host) as the data it is
  backing up.
- **The adapter tells you when this applies.** On first use, if the
  configured backup path and the application's live data directory
  (`mail.mailboxRoot`, or an explicit `contract.backup.liveDataPath`
  override) resolve to the same filesystem device
  (`fs.statSync(path).dev`, reliable on Linux; treated as inconclusive
  elsewhere), the adapter logs one explicit warning through the injected
  logger (falling back to `console.warn` if none was given) naming exactly
  this limitation. It never blocks the write — an operator may have a
  second physical disk mounted under the same host that the configured
  `liveDataPath` simply was not told about — but it makes sure nobody
  mistakes "a backup exists" for "disaster recovery exists."
- **Real disaster recovery requires external/remote storage** — a second
  host, a second disk that is not just a different directory on the same
  device, or an object store — which is exactly the pluggable seam
  `BackupStorageAdapter` exists for. No such adapter is implemented yet;
  see "Still requiring production adapters" below.

## Provider backup and restore

`createProviderBackupScope()` represents tenant-level infrastructure backup.
Provider operations can cover encrypted application data and configuration, but
the contract deliberately excludes plaintext sessions, cookies, password
values, factor secrets, private keys, and arbitrary user content access through
an administrative actor.

`createRestorePlan()` validates the target tenant/user, archive scope, requested
resource set, integrity status, and overwrite policy before an adapter is
called. A user restore cannot overwrite existing data by default. A provider
restore must use an isolated target or an explicitly approved cutover plan.

The initial operational objectives are recorded as data rather than hidden in a
runbook: RPO and RTO are supplied, retention is at least 28 days, and a DR
rehearsal record must show integrity and privacy checks before it is marked
passed. Production operations still need to connect this evidence to the actual
external volume/directory, object store, PostgreSQL dump, mailbox snapshot, and
each packaging target's real restore/upgrade-rollback procedure (see
`doc/upgrade-and-migration.md`).

## Log rotation and audit-safe events

`createLogRotationPolicy()` supports bounded policies for Docker's `json-file`
driver, `journald`, or a sidecar collector. A policy specifies maximum record
size, file count, byte size, retention, compression, and a separate audit
retention floor. Audit preservation cannot be disabled accidentally, and a
policy that would create unbounded logs is rejected.

`createStructuredEvent()` and `createAuditEvent()` provide one safe envelope for
runtime, API, MCP, worker, and backup events. The sanitizer removes credentials,
tokens, cookies, bodies, payloads, private key material, and other content-like
fields while retaining request IDs, tenant/user scope, actor role, operation,
result, and timestamps. These events are metadata, not a second mailbox.

On a Docker-based deployment, the profile may render the bounded `json-file`
options, forward structured records to journald, or use a sidecar. On any of
the three current packaging targets (standalone, cPanel, Plesk), the process
runs under systemd (or the operator's own supervisor on standalone) and the
same policy shape applies to journald or file-based log rotation instead. The
choice belongs to the deployment profile; the application contract stays the
same.

## Alerts and monitoring

`createAlertPolicy()` turns already-sanitized health snapshots into stable,
ordered alerts. It covers failed dependencies, queue depth and age, certificate
expiry, storage and quota pressure, and authentication abuse. Thresholds are
validated so warning cannot be higher than critical, and alert subjects contain
safe identifiers rather than endpoints or secrets.

The read-only API/MCP monitor may expose the resulting alert summary, health
state, metrics, backup rehearsal status, retention lag, and patch status inside
the caller's tenant scope. It must not expose archive bodies, passwords, session
cookies, raw log lines, factor secrets, or a provider's other tenant data.

## External storage and install-directory lifecycle

The application's own install/extension directory is disposable and must not
be where user data lives. Mailbox data, DAV data, PostgreSQL data,
configuration exports, and backup archives belong on explicitly configured
external volumes/directories or external services, entirely outside the
directory that each target's install/upgrade script backs up, replaces, or
(on uninstall) removes — see `../INSTALL.md` and
`doc/upgrade-and-migration.md` for what each of the three packaging targets
actually replaces in place.

For any of the three targets, the restore rehearsal should prove:

1. a fresh install can be started with no user data inside its own
   install/extension directory;
2. the external storage (mailbox, DAV, PostgreSQL) is mounted or reachable
   with the expected owner and permissions;
3. an archive or database snapshot can be verified before import;
4. tenant/user scope remains unchanged after restore;
5. the previous install can be rolled back to (from its own pre-upgrade
   backup) without deleting the external storage.

A Docker or Kubernetes deployment remains a separately justified,
non-baseline option per ADR-002 and would follow the equivalent
container/rolling-update version of the same proof. M7 supplies the
retention, backup, integrity, and observability contracts that any of these
restore or upgrade procedures call.

## Still requiring production adapters

The following work is intentionally visible rather than implied:

- a **remote/external** `BackupStorageAdapter` implementation (rsync to
  another host, an S3-compatible object store) — real disaster recovery, as
  opposed to the local filesystem adapter now implemented (see above),
  which is fast same-host recovery only;
- a **persistent** `retention.ts` store — `run-purge-batch.ts` and its
  systemd timer/service now exist (see above), but `createRetentionStore()`
  itself is still the in-memory contract it always was, so the scheduled
  worker is currently a safe no-op in production;
- staging `src/core/lifecycle/**` and the new systemd units into
  `npm run build:server` / the three `packaging/*/build-*-package.ts`
  scripts, so `gulogulo-purge.service` actually finds a compiled
  `run-purge-batch.js` to run;
- encryption-key management for archives at rest beyond the reference
  passed to `encryptArchiveMetadata()`;
- PostgreSQL, LDAP/panel identity, mailbox, and DAV adapters wired as the
  `purgeResource` callback `account-lifecycle-wiring.ts` now expects for
  every non-`'backups'` resource type;
- a scheduled worker with durable lease storage;
- log rotation/retention installation and rehearsal for the target's actual
  log destination (journald/systemd on cPanel and Plesk, the operator's own
  choice on standalone, or Docker's log driver on a non-baseline container
  deployment);
- alert delivery, paging, and incident ownership;
- a real restore rehearsal with measured RPO/RTO on each of the three
  packaging targets;
- each target's real in-place upgrade and rollback rehearsal (see
  `doc/upgrade-and-migration.md`).

This keeps M7 honest: the repository now has executable boundaries for deletion,
backup, restore, logs, and alerts, while the infrastructure-specific evidence
still has a named place to land.
