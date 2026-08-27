# LP8 evidence bundle and operator handbook

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

LP8 is the hand-off point for the local proof track. It collects the boring but
important bits that let another operator repeat the checks without guessing:
the Compose and Kubernetes contracts, synthetic fixtures, release manifests,
read-only API/MCP examples, and the exact commands used by CI. It is a portable
engineering bundle, not a production certificate.

The bundle is deliberately honest about what the checkout can prove. The
functional proof runs on `linux/amd64` first. Once that gate is green, the
explicit `multiarch` workflow builds and attests `linux/amd64` and
`linux/arm64` artifacts. It does not repeat the long, stateful Compose proof
under ARM emulation. A registry digest, vendor interoperability result, or
live Kubernetes timing is recorded only when an operator has actually run it.

## What is in the bundle

[`release/lp8-local-proof-bundle.json`](../release/lp8-local-proof-bundle.json)
is the machine-readable index. It contains:

- the LP8 identity, MIT/SPDX attribution, and synthetic/offline boundary;
- the AMD64-first and final multiarch architecture policy;
- the verified Ubuntu 26.04 base-image digest and its Actions evidence run;
- an explicit inventory of Compose, Dockerfile, fixture, protocol, operations,
  backup, migration, and API/MCP references;
- the commands that reproduce the local checks;
- passed GitHub Actions run links;
- every remaining `.mjs` compatibility bridge, its TypeScript canonical, and
  LP9 as the owner of the cleanup debt;
- residual risks that still need provider-side evidence.

The manifest does not contain mail bodies, passwords, tokens, private keys,
absolute workstation paths, raw command output, or public DNS/ACME data.

## Run the portable audit

Use a clean checkout with Node 26 (the repository's supported runtime):

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run test:lp8
```

`test:lp8` performs the following in order:

1. the strict server compiler check;
2. the LP8 compiler boundary check;
3. local-proof scope, topology, and release-evidence contract tests;
4. the LP0, LP1, LP2, LP3, and M10 static audits through their TypeScript
   canonicals;
5. the LP8 evidence-audit unit tests;
6. the final portable bundle audit.

For the shorter manifest-only check, run:

```text
node --experimental-strip-types scripts/lp8-evidence-audit.ts
```

The command prints a small sanitized summary. A successful result has
`milestone: "LP8"`, `status: "ready_for_lp9"`, at least one exact digest, and
the number of repository files and bridges checked. It never prints the
contents of a fixture, environment file, certificate, mailbox, or log.

`test:lp8:bundle` runs the audit and emits SHA-256 checksums and byte counts for
every indexed repository file. These checksums are useful when handing the
bundle to another operator; they are not registry image digests.

## How the audit keeps the hand-off safe

The validator in `scripts/lp8-evidence-audit.ts` is intentionally stricter than
the prose. It rejects:

- absolute paths, Windows drive paths, backslashes, and `..` traversal;
- private-key blocks and token/password-like assignments;
- non-synthetic or public-DNS/public-ACME claims;
- duplicate file references and missing repository files;
- a multiarch functional-proof claim (the policy is artifact/provenance only);
- unrecognised Actions URLs or failed run records;
- an unpublished image entry that nevertheless supplies a registry digest;
- an `.mjs` bridge that contains code rather than a direct `.ts` import/export;
- an omitted LP9 owner for a temporary bridge or an omitted residual risk.

The exact Ubuntu 26.04 base digest currently recorded is:

```text
sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b
```

The image-build workflow also creates OCI tar archives and signs their build
provenance with `actions/attest-build-provenance@v4` on trusted pushes or a
maintainer-triggered workflow dispatch. Pull-request validation retains
read-only permissions. The local bundle records that evidence run, while
registry manifest digests remain an explicit external-release task.

## AMD64 first, then multiarch artifacts

The normal development loop is intentionally quick:

```text
# Functional and static proof on the GitHub AMD64 runner
gh workflow run commit-tests.yml -f architecture_mode=amd64

# After the AMD64 run is green, build both OCI architectures and attest them
gh workflow run commit-tests.yml -f architecture_mode=multiarch
```

The exact UI or CLI invocation may vary with the caller's GitHub permissions.
The workflow itself is the source of truth for the permissions and conditions.
Do not run the multiarch workflow as a substitute for the functional AMD64
proof, and do not call a green artifact build a live ARM64 service test.

The final gate covers the root image and the LP1, LP2, and LP3 proof images. It
uses Ubuntu 26.04, Buildx, and the declared `linux/amd64,linux/arm64` platform
matrix. Provenance is attached to the immutable OCI archive, not to a floating
tag. A maintainer can verify a downloaded archive with:

```text
gh attestation verify PATH/TO/gulogulo-<image>-ubuntu-26.04.oci.tar --repo Sythos/GuloGulo
```

For a published registry reference, use the OCI form supported by the GitHub
CLI and record the resulting digest in a new, reviewed evidence entry. Never
replace the honest `not_published_local_proof` status with a guessed digest.

## Local CA, DNS, and Compose

The LP1–LP7 Compose profiles are disposable and offline. They use reserved
names such as `gulogulo.test` and loopback-only bindings where a browser probe
needs a host entry. The internal service network supports both IPv4 and IPv6;
the runtime does not mount the Docker socket. Mail, DAV, queue, backup, and
runtime state live in named volumes that can be declared external when an
operator moves to a new container.

The local certificate authority is generated by the LP1 network profile. It is
appropriate for a workstation or CI proof only. Install its CA certificate in
a disposable browser profile if you want to inspect HTTPS manually, and remove
that trust after the run. Never copy a local private key into the repository or
attach it to an issue.

The Compose checks are static before they are live. They verify profile names,
dual-stack IPAM, no host-network/privileged/socket shortcuts, volume mounts,
health checks, and the Ubuntu 26.04 image boundaries. The live proof then
starts only the profile it needs, waits for health, runs synthetic probes, and
tears the project and disposable volumes down.

## Fixtures and safe sharing

`test/fixtures/` is deterministic and synthetic. The tenant fixture has two
fake users and one alias on a reserved `.invalid` domain. Failure fixtures
describe loopback-only LDAP/PostgreSQL outages and a fixture-mode run without
external credentials. They are useful examples, not seed data for a real
tenant.

Before sharing an evidence bundle, check the following:

1. run `node --experimental-strip-types scripts/lp8-evidence-audit.ts`;
2. run `npm run test:lp8:bundle` and keep its checksum output with the hand-off;
3. inspect `git diff --check` and the staged file list;
4. remove any locally generated logs, archives, certificates, or `.env` files;
5. confirm that the bundle still says `syntheticDataOnly: true` and
   `publicDnsRequired: false`;
6. share only repository files and sanitized CI links.

## Protocol and operations evidence

The LP3 manual describes the local Postfix, Dovecot, IMAP IDLE, LMTP, Sieve,
Rspamd, and ClamAV proof. Scanner failures are fail-closed, and queue/retry/
bounce output is metadata-only. The LP4 manual covers the HTML5/TypeScript
browser shell, secure sessions, CSRF, DAV conditional semantics, discovery,
and restart continuity. LP5 and LP6 cover patch status, abuse limits,
observability, bounded capacity, encrypted backup metadata, restore
authorization, 28-day retention, holds, and idempotent purge. LP7 covers
Docker replacement and the Kubernetes blue/green state machine with readiness,
drain, queue hand-off, IMAP IDLE reconnect, rollback, and external-volume
continuity.

Those contracts are intentionally split from provider evidence. For example,
the repository can prove that a failed ClamAV adapter blocks delivery, but it
cannot prove a vendor's freshclam channel is healthy. It can verify that a
rollback preserves the blue slot in a simulator, but it cannot measure a real
cluster's traffic-switching time.

## Read-only API and MCP examples

The V1 monitoring surface stays read-only. The canonical examples are in
[`doc/api-and-mcp.md`](api-and-mcp.md): release evidence and capabilities,
health, metrics, patch state, queue metadata, backup metadata, and migration
plans. They are tenant-scoped and redact message content, credentials,
absolute paths, Docker socket details, and unrestricted Kubernetes arguments.

The release vocabulary is exposed conceptually as:

```text
GET /provider/release/evidence
MCP gulogulo.release.evidence
GET /provider/release/capabilities
MCP gulogulo.release.capabilities
```

These examples describe the contract; they do not grant a shell, a Docker
socket, or a write-capable deployment command. A tenant or master cannot use
them to approve an exception, start an upgrade, read another user's mailbox,
or alter a release status.

## Backup, restore, and migration records

LP6's records are local synthetic records. They demonstrate AES-256-GCM
metadata, SHA-256 manifests, isolated restore, source preservation, 28-day
retention, holds, and idempotent purge. A provider still needs to attach a
real encrypted backup target, restore timings, deletion-runbook evidence, and
approved RPO/RTO.

LP7's records describe the safe sequence for a Docker replacement or a
Kubernetes blue/green cutover:

1. validate source and target versions, digests, schema window, and external
   volume references;
2. expand/backfill without destructive cleanup;
3. bring the green target to readiness and observe it;
4. drain bounded connections and hand off queue/IDLE continuity;
5. switch the stable selector or service;
6. keep blue available during the observation window;
7. roll back on a controlled failure, or finalize only after restore and
   observability checks.

The API/MCP plan is read-only. An operator or provider controller owns the
actual Docker and Kubernetes mutation and must retain the operation ID,
sanitized timings, image digests, volume snapshot references, and rollback
decision.

## Temporary TypeScript bridges and LP9

LP8 moves the remaining release validators and LP0–LP3 audit/smoke entry
points to TypeScript. Their `.mjs` names remain as tiny compatibility shims so
older callers do not break in the middle of the migration. The bundle lists
each shim and its canonical `.ts` path. The audit checks that a shim contains
no business logic.

The `@ts-nocheck` comments retained in the migrated LP0–LP3 and release
contracts are temporary debt, not an excuse to add new untyped behavior. LP9
owns the final source audit: remove or explicitly re-home every shim, close
the remaining type debt, and rerun the complete test and evidence gates.

## Troubleshooting

**The audit says a file is missing.** Run it from the repository root, check
the path in the bundle, and verify that the file is tracked. Do not “fix” the
manifest by adding an absolute workstation path.

**The audit rejects a secret-like value.** Remove the value and rotate the
credential if it was real. The bundle should contain a reference to a secret
store or a fixture placeholder, never the secret itself.

**The Docker proof cannot start locally.** Docker Desktop is optional for the
repository checkout. Keep the static and typed checks local and use the
GitHub-hosted AMD64 Compose proof for live evidence. Report the environment
limitation instead of weakening the safety assertions.

**The ARM64 run is slow.** That is expected. Run the functional AMD64 gate
first; invoke `architecture_mode=multiarch` only after it is green. The final
run is intentionally artifact/provenance-only for ARM64.

**An Actions gate fails.** Read the complete remote log immediately, classify
the exact gate and cause, apply the smallest evidence-backed fix, and rerun the
same mode. The LP8 owner policy has no automatic model escalation. Stop after
the third consecutive occurrence of the same exact cause at the same gate and
ask the owner for a decision.

## What LP8 does not mean

A green LP8 run means the repository's local hand-off is complete and
repeatable. It does not mean that:

- a public domain or Let's Encrypt certificate has been provisioned;
- a real LDAP or PostgreSQL service has been configured;
- external mail/DAV clients have passed their interoperability matrix;
- registry image SBOMs, signatures, and vulnerability scans are complete;
- a live Kubernetes cutover or rollback has zero downtime;
- production RPO/RTO or capacity has been measured;
- the final authenticated provider login route is complete.

Those are named residuals. LP9 is the next local-proof gate, followed by the
owner's decision on whether to begin the external deployment phase.
