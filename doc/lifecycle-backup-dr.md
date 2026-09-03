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
├── retention.ts               28-day trash purge and restore-safe locks
└── account-lifecycle.ts       deletion, recovery window, and purge states

src/core/backup/
└── backup-contract.ts         user/provider scope, encrypted manifests, restore

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

- external-volume/directory snapshots and encryption-key management;
- PostgreSQL, LDAP/panel identity, mailbox, DAV, and object-store backup
  connectors;
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
