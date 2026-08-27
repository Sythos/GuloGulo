# LP7 local Docker replacement and blue/green rehearsal

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

LP7 is a bounded, synthetic local rehearsal of replacing one Gulo Gulo
container with the next. It exercises a blue source slot, a green target slot,
readiness-gated cutover, shared durable volumes, and rollback. It is local
proof only. It is not a production availability, zero-downtime, RPO/RTO, mail
delivery, LDAP, PostgreSQL, Kubernetes, or provider-integration claim.

## Topology and safety boundary

`gulogulo-lp7-blue` and `gulogulo-lp7-green` run the deterministic web/DAV
runtime on the private `lp7-runtime` Compose network. The network has explicit
IPv4 and IPv6 subnets and is marked `internal: true`. Neither slot publishes a
host port, uses host networking, mounts the Docker socket, or receives a host
path. The proof checker is another internal container and has the same network
and socket restrictions.

Both slots mount the same named volumes:

| Volume | Rehearsed state |
|---|---|
| `lp7-runtime-state` | runtime state |
| `lp7-mail-data` | synthetic mailbox state |
| `lp7-dav-data` | DAV continuity metadata and objects |
| `lp7-queue-data` | synthetic queue state |
| `lp7-backup-data` | synthetic backup state |

The checker writes only synthetic sentinels and phase evidence to these
disposable volumes and to `lp7-proof-state`. The volume declarations use
`GULOGULO_LP7_VOLUMES_EXTERNAL`; set it to `true` only when an operator has
created and independently protected the named volumes. The CI smoke harness
uses a unique prefix and keeps the volumes disposable.

The slot versions and digests are explicit environment values. The checker
verifies that the health response identifies the expected slot and that both
slots return the same tenant-scoped synthetic DAV and mail fixtures. It also
reads the application-created DAV continuity record and refuses a changed
record.

## Rehearsal sequence

The Compose smoke harness runs the following bounded sequence:

1. build and start blue and green on `linux/amd64`;
2. wait for both container health checks and run the baseline proof;
3. stop blue, record the cutover timestamp, and verify green serves the same
   synthetic traffic and shared state;
4. stop green, start blue again, record the rollback timestamp, and verify blue
   serves the original state and traffic signature;
5. remove the disposable containers, network, and volumes.

The checker records `lp7-baseline.json`, `lp7-cutover.json`, and
`lp7-rollback.json` in the proof-state volume. These records contain phase
metadata and synthetic signatures only; they never contain credentials or
message bodies. The smoke result prints the cutover and rollback timestamps.

This Compose topology uses slot-addressed internal URLs as a deterministic
traffic stand-in. It does not mutate a real reverse proxy, Docker host,
Kubernetes API, Gateway, Service, or external provider. The equivalent
provider-only control-plane contract remains in `src/upgrade/`; production
execution still requires an approved controller and external stores.

## Local commands

From the `git/` checkout, run the static contract and the strict TypeScript
check. The normal project gate is `npm run test:lp7`; the expanded command
below is also useful when checking only the LP7 proof files:

```powershell
npm run test:lp7
node --experimental-strip-types scripts/lp7-compose-audit.ts
npx tsc --ignoreConfig --types node --noEmit --strict --target ES2024 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck scripts/lp7-compose-audit.ts scripts/lp7-proof-check.ts scripts/lp7-compose-smoke.ts
```

The live AMD64 rehearsal generates synthetic credentials at runtime:

```powershell
npm run test:lp7:docker
node --experimental-strip-types scripts/lp7-compose-smoke.ts
```

The smoke script sets a unique Compose project, network, and volume prefix. Do
not run `docker system prune` as part of this proof. If Docker is unavailable,
run the static and typed commands locally and let the GitHub AMD64 gate provide
the live Compose evidence.

## Architecture policy

The functional default is AMD64: the Compose services default to
`linux/amd64`, the smoke rehearsal runs only in the default AMD64 workflow
mode, and its timestamps and continuity result are AMD64 evidence. The final
`multiarch` mode is intentionally not another functional rehearsal. It builds
separate AMD64 and ARM64 OCI artifacts and verifies their OCI build provenance
after the AMD64 functional gate is green. This keeps the expensive functional
rehearsal on AMD64 while still publishing evidence for both target
architectures. The ARM64 artifact/provenance evidence must be present before
merge or release; it must not be described as ARM64 functional or capacity
evidence.

## CI integration

The reusable quality workflow keeps all earlier gates and adds:

- LP7 entry-point, SPDX, Compose marker, and manifest checks;
- a strict direct TypeScript compilation and static LP7 audit in AMD64 mode;
- the live LP7 Compose replacement proof in AMD64 mode.

All LP7 functional steps are skipped when `architecture_mode=multiarch`. The
existing Buildx and OCI attestation steps then provide the AMD64 and ARM64
artifact/provenance-only gate. The repository integration includes the
`test:lp7` and `test:lp7:docker` package scripts, `tsconfig.lp7.json`, the
Compose/manifest proof files, the root README status, and the parent milestone
and memory records.

## Evidence boundary

A green LP7 result means that this checkout reproduced the bounded synthetic
blue/green and rollback sequence with shared disposable volumes, readiness
checks, and no host/socket exposure. It does not authorize a production
cutover. Before such a cutover, an owner must separately approve the image
digests, external volume snapshots, schema compatibility and rollback window,
queue and mail-session behavior, LDAP/PostgreSQL dependencies, traffic
controller, Kubernetes manifests, drain policy, restore check, audit sink,
and operator runbook.
