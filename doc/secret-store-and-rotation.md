# Secret store and rotation

> **⚠️ Documento in transizione.** Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Gulo Gulo resolves credential references through the provider-neutral contract
in `src/core/secrets/`. The contract deliberately keeps secret delivery separate
from LDAP, PostgreSQL, and control-panel configuration: configuration contains
references such as `ldap-bind` or `postgres-dsn`, while the selected store owns
the corresponding values.

No secret value appears in a status object, rotation result, rollback result,
or audit event. A read returns a `SecretLease`; its value is stored in a private
field, ordinary JSON serialization contains metadata only, and callers should
dispose the lease as soon as they have passed the value to the target client.
`createSecretResolver()` is the narrow compatibility adapter for the existing
LDAP and PostgreSQL integration factories.

## Contracts and sources

`SecretStore` provides allowlisted `get()` and metadata-only `status()`
operations. `RotatableSecretStore` adds compare-and-swap `rotate()` and
`rollback()` operations. Unknown, malformed, missing, expired, oversized, or
unsafe references fail closed with a stable error code; arbitrary filesystem
paths and command execution are not accepted.

Two concrete source families are included:

- `VersionedFileSecretStore` is a managed, versioned store for a provider-owned
  persistent directory. It uses immutable value files, an atomically replaced
  active-state file, bounded read retries, a bounded cross-process rotation
  lock, expiry, a rollback window, and bounded retained history.
- `ProjectedSecretFileStore` reads an explicit map of Docker or Kubernetes
  secret files. It resolves the real target beneath the configured root,
  rejects traversal, non-files, writable group/world files, empty files, and
  oversized files, and reads every request afresh so orchestrator projection
  updates become visible. Rotation is intentionally reported as `external`:
  Docker or Kubernetes remains the writer and performs the atomic projection.

The projected adapter uses the opaque version label `projected`. A deployment
that needs durable version history, in-process rollback, or application-managed
expiry should use the versioned store or a future provider adapter that
implements `RotatableSecretStore`.

## Managed versioned layout

The allowlist maps a public reference to one safe storage key. A representative
provider-owned directory looks like this:

```text
/var/lib/gulogulo/secrets/
└── ldap-bind/
    ├── active.json
    ├── .rotation.lock
    └── versions/
        ├── v1.json
        ├── v1.secret
        ├── v2.json
        └── v2.secret
```

The root must be a persistent Docker volume, Kubernetes persistent volume, or
equivalent provider-owned secret-capable filesystem. It must not live only in
the writable layer of an application container. Restrict the root directory to
the Gulo Gulo service identity; version and state files are created with mode
`0600` and directories with mode `0700` on POSIX systems. Windows ACLs remain a
provider responsibility.

Construct the store at the application composition boundary and inject only
the resolver into clients:

```ts
import {
  VersionedFileSecretStore,
  createSecretResolver,
} from '../src/core/secrets/index.ts';

const secretStore = new VersionedFileSecretStore({
  rootDirectory: '/var/lib/gulogulo/secrets',
  references: {
    'ldap-bind': 'ldap-bind',
    'postgres-dsn': 'postgres-dsn',
  },
  audit: appendDurableSecretAuditEvent,
});

const resolveSecret = createSecretResolver(secretStore);
```

Do not build the allowlist from an untrusted request. It is deployment
configuration and must contain only references used by that service instance.

## Rotation and rollback

The first rotation supplies `expectedVersion: null`. Every later rotation must
supply the active version returned by `status()` or the preceding mutation.
This compare-and-swap check prevents a stale operator from overwriting a newer
secret.

```ts
const first = await secretStore.rotate('ldap-bind', candidate, {
  expectedVersion: null,
  expiresAt: '2026-09-27T10:00:00.000Z',
  correlationId: 'change-1042',
});

const next = await secretStore.rotate('ldap-bind', replacement, {
  expectedVersion: first.activeVersion,
  correlationId: 'change-1088',
});
```

When no expiry is supplied, the default lifetime is 30 days. The default
maximum is 90 days. Both can be tightened when the store is constructed.
Reads can also require a minimum remaining validity period. An expired or
soon-to-expire secret is never returned when it cannot satisfy that request.

Each successful replacement opens a default seven-day rollback window for the
immediately previous retained version. Rollback requires both the expected
current version and the exact previous version. It refuses stale callers,
expired target values, missing history, and elapsed rollback windows. A
rollback changes only the active metadata pointer and returns metadata; it does
not return either secret value.

Version identifiers are generated internally and validated. Version files are
created exclusively and never overwritten. The store retains five versions by
default, always preserving the active and immediately previous versions.

## Docker and Kubernetes projected files

For Docker secrets, set the root to the mounted secrets directory and map each
reference to a relative file. For Kubernetes, use a dedicated projected-secret
directory and set `defaultMode: 0400` or another non-writable group/world mode.

```ts
const projectedStore = new ProjectedSecretFileStore({
  source: 'kubernetes-secret-file',
  rootDirectory: '/var/run/secrets/gulogulo',
  references: {
    'ldap-bind': 'ldap-bind',
    'postgres-dsn': 'postgres-dsn',
  },
  audit: appendDurableSecretAuditEvent,
});
```

Projected sources do not write, invoke Docker, invoke `kubectl`, or attempt to
roll back orchestrator state. Rotate the Kubernetes Secret or Docker secret
through the provider's approved control plane, wait for the projected file to
change, then verify `get()` and dependency health. Keep the former provider
version available until the service-level verification window closes.

## Audit and operations

Reads, rotations, and rollbacks emit schema-versioned metadata with action,
result, timestamp, reference, source, correlation ID, version, and a stable
reason code. The audit payload cannot accept arbitrary error strings or secret
values. Supply a durable append-oriented sink in field deployments; audit-sink
failure is surfaced as `AUDIT_UNAVAILABLE` rather than ignored.

Monitor `status()` for `ready`, `expired`, or `unavailable`. The status surface
contains expiry and rollback timestamps but never file paths or values. Alert
before expiry, rotate with an idempotent operator change record, verify LDAP or
PostgreSQL connectivity, and use rollback only inside the recorded window.

## Current boundary

This implementation supplies the repository baseline and deterministic tests.
It does not configure a cloud vault, KMS, HSM, automatic rotation scheduler,
Kubernetes API writer, Docker control-plane writer, Windows ACL, or production
audit database. JavaScript strings cannot be reliably zeroized; the lease
reduces accidental serialization and lifetime but callers must still avoid
retaining or logging the revealed string. Providers must supply persistent
storage protection, backups where appropriate, durable audit, alerting,
rotation ownership, and field rehearsal before treating the deployment as
production-ready.
