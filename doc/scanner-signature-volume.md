# Shared scanner-signature volume

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the practical contract for Rspamd and ClamAV definition data. The
short version is simple: images stay immutable, one provider-controlled data
volume holds the current verified definitions, and every scanner mounts that
volume read-only. The updater lives on the host (or in a provider-managed
maintenance job), not in the scanner process.

The repository proves the boundary with deterministic fixtures. The fixture is
not a Rspamd map distribution and it is not a ClamAV database.

## Why the data is outside the images

Spam maps, reputation feeds, fuzzy data, and antivirus databases change much
more often than the scanner image. Baking them into an image would mean
rebuilding and rolling every scanner for each feed update, while mutating a
running read-only container would make rollback, replication, and audit much
harder. The image contains the reader and its policy; the provider owns the
definition lifecycle.

The two scanner services and both LP3 proof clients use this path:

```text
/var/lib/gulogulo/scanner-signatures/
├── rspamd/
│   ├── active.json
│   └── versions/<generation>/manifest.json + map files
└── clamav/
    ├── active.json
    └── versions/<generation>/manifest.json + database files
```

`active.json` is a tiny metadata pointer. It is the only file that changes at
activation time. A pointer contains the scanner name, a safe generation name,
and exactly `versions/<generation>`; it never contains an absolute path.

Each generation manifest contains:

- schema version `1`;
- scanner name and generation;
- UTC publication time;
- a safe source identifier;
- one SHA-256 digest over the sorted file descriptors;
- an allowlisted relative path, byte length, and SHA-256 for every file;
- status `ready`.

The scanner reader verifies the pointer, manifest, every listed file, the
metadata digest, and the freshness window (seven days by default). It exposes
only status, generation, digest, and file count. It never returns map rules,
database bytes, or a host path through an HTTP response.

## Host-side publication workflow

The writer is a single provider-controlled job. It can be a systemd timer,
Windows Task Scheduler job, Kubernetes CronJob, or another approved host
maintenance mechanism. It must follow this sequence:

1. acquire a host-side lock so two writers cannot publish at once;
2. download the provider feed over an explicitly allowed network path;
3. verify the provider signature or checksum and the expected file type/size;
4. write a new directory under `rspamd/versions/<generation>` or
   `clamav/versions/<generation>`;
5. write and validate the generation manifest, including every file digest;
6. flush the files and directory as supported by the host filesystem;
7. atomically replace that scanner's `active.json` (write a temporary pointer,
   flush it, then rename it over the old pointer);
8. retain at least one previous generation for rollback and garbage-collect
   only generations outside the provider's retention policy;
9. record a metadata-only audit event and publish freshness/age metrics.

The old pointer remains valid until the final rename. A failed download,
signature check, manifest check, or reload never becomes the active generation.
If the active generation is missing, corrupt, or stale, the scanner health
check fails and the mail policy remains fail-closed.

Do not replace the pointer by editing it in place. Do not delete the previous
generation before the new one is active. Do not put credentials, feed tokens,
message content, or raw database bytes in the status endpoint or audit log.

## Compose setup

The LP3 Compose topology declares:

```yaml
lp3-scanner-signatures:
  name: ${GULOGULO_LP3_SCANNER_SIGNATURES_VOLUME:-gulogulo-lp3-scanner-signatures}
  external: ${GULOGULO_LP3_VOLUMES_EXTERNAL:-false}
```

`lp3-rspamd`, `lp3-clamav`, `gulogulo-lp3-proof-check`, and
`gulogulo-lp3-proof-node` mount the volume at
`/var/lib/gulogulo/scanner-signatures:ro`. Postfix and Dovecot do not need raw
scanner databases, so they do not receive this mount; that is intentional
least privilege, not a second copy of the data.

For a deployed instance, pre-create the provider-owned volume, set
`GULOGULO_LP3_SCANNER_SIGNATURES_VOLUME` to its stable name, set
`GULOGULO_LP3_VOLUMES_EXTERNAL=true`, and populate the layout before starting
the scanners. The local LP3 smoke harness creates a disposable volume and
copies `test/fixtures/scanner-signatures` into it before the services start.

The scanner containers remain non-root, read-only, capability-dropped, and
without a Docker socket. The shared volume is the only mutable input they
need, and it is mounted read-only.

## Health and monitoring

Rspamd's proof endpoint returns `signatureStatus`, `signatureGeneration`,
`signatureDigest`, and `signatureFileCount` in health metadata. ClamAV exposes
the same readiness through its `VERSIONCOMMAND` contract. A non-ready
generation returns a non-healthy result and a scanner verdict cannot be
treated as clean.

The future production adapter should map these fields into the existing
read-only API/MCP status surface and audit events such as
`scanner.definitions.activated`, `scanner.definitions.rollback`, and
`scanner.definitions.stale`. Those events contain metadata only.

## What still needs field verification

The code proves the reader, digest rules, freshness gate, read-only mounts, and
offline fixture. A provider still has to choose the supported Rspamd/ClamAV
feed sources, verify their licensing and signatures, implement the host-side
single-writer job, rehearse rollback, set filesystem ownership/SELinux or
AppArmor policy, and wire alert delivery. Those checks belong in
`READ_BEFORE_USE.md`; they are not hidden inside the container image.
