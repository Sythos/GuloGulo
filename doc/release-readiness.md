# Release readiness and the M10 boundary

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This is the slightly boring document that keeps a release honest. M10 does not
turn a fixture into a mail provider by changing the wording around it. It
packages the review into a repeatable evidence object, runs the security and
tenant-boundary checks, and makes the remaining external work visible to the
operator.

The useful result at this point is a **V1 contract preview**: a clean checkout
can be installed, tested, inspected, and used as the application/runtime
foundation. A production mail service still needs the provider adapters and a
rehearsal against real Postfix, Dovecot, LDAP, PostgreSQL, CalDAV, CardDAV,
certificate, scanner, backup, and traffic-switching services. Those are
explicit residuals, not hidden assumptions.

## What M10 checks

The M10 gate covers five evidence domains:

| Domain | What is checked in this checkout | What still needs an external rehearsal |
|---|---|---|
| Security | tenant/RBAC boundaries, session and CSRF contracts, MFA primitives, HTML sanitization, abuse limits, secret-free audit events, and the SHA256 checksum sidecar/aggregate for each package | provider secret rotation, real TLS/LDAP/DB configuration, vulnerability disposition, and package signing (GPG/minisign not built yet — see "Artifact provenance" below) |
| Data | quota allocation, 28-day purge, backup authorization, encrypted archive shape, idempotent lifecycle operations | an actual restore, deletion runbook execution, external-volume snapshots, measured RPO/RTO |
| Interoperability | SMTP/IMAP/IDLE, Sieve, DAV object semantics, discovery, ICS/vCard, and timezone contracts | vendor client matrix and real protocol endpoints |
| Operations | health, metrics, logging, alerts, queue visibility, each target's per-package in-place upgrade script, and the shared read-only scanner-signature boundary | host-side scanner feed publication, a real upgrade/rollback rehearsal on each of the three packaging targets, and incident tabletop |
| Governance | role and delegation policy, default-deny master access, optional Plesk/cPanel tenant-tool boundary, read-only API/MCP, ADRs, and documentation inventory | owner approval of the deployment and disaster-recovery runbooks, package signing/attestation (see "Artifact provenance" below), and any provider-specific panel adapter |

The source of truth for the checklist remains Section 30 of `GULOGULO.md`.
The repository copy is deliberately an evidence boundary, not a second product
specification.
The root README now tracks repository implementation only: checked entries have
code or a tested contract, while deployment and consumer verification are
listed in [INSTALL.md](../INSTALL.md). The release evidence object
continues to distinguish verified, contract, conditional, and deferred
external evidence.

LP8 packaged this boundary in
[`release/lp8-local-proof-bundle.json`](../release/lp8-local-proof-bundle.json)
and a `doc/lp8-evidence-operator.md` operator note. That note has since been
archived to `old_docs/lp-proof-records/lp8-evidence-operator.md` as part of the
ADR-002 packaging move; the JSON bundle still exists but several of its
indexed `doc/...` paths (including `lp8-evidence-operator.md`,
`local-proof-scope.md`, and `local-proof-topology.md`) are now stale pointers
into files that no longer live under `doc/`. Live provider evidence and
provider-specific Plesk/cPanel adapters remain outside this checkout.

## Artifact provenance

The GHCR/container release lane (`container-release.yml`, GHCR image
publication, and the numeric-tag automation that went with it) was retired
when the project moved off Docker/OCI — it no longer exists, and the
security principles it used to provide (checksum, provenance, attestation,
least-privilege permissions) were readapted to the current
cPanel/Plesk/standalone packages, not carried over automatically.

Checksums have applied to every package since the tar.gz-based targets
shipped: each of the three `.tar.gz` files gets its own `.sha256` sidecar
(`packaging/shared/stage-application.ts`'s `writeChecksumFile`), aggregated
into one `checksums.txt` per release.

Since release 0.1.6, `.github/workflows/release.yml`'s `publish-release` job
also generates a signed build provenance attestation for all three packages
(`actions/attest-build-provenance`, GitHub's own Sigstore-backed
attestation) before they are uploaded to the release — verifiable with
`gh attestation verify <file> --repo Sythos/GuloGulo`. This did not exist for
any earlier tag; there is no attestation for 0.1.5 or earlier. An SBOM is
still not generated — that readaptation has not happened yet.

The current, real CI gates for a release are `.github/workflows/quality-gates.yml`
(repository entry points, MIT/SPDX headers, and the full test suite) plus the
three packaging workflows, each of which builds, actually installs
(`install.sh --non-interactive`), and boots the package, polling
`/health/ready` and `/` — on cPanel and Plesk the systemd
enable/start step is stubbed since their CI containers have no init system;
see `../INSTALL.md` for the exact verification depth of each target.

## Running the gate

From a clean checkout, install the locked dependencies and run the complete
suite:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

The focused M10 checks can be run while iterating:

```text
npm run test:m10
```

That command runs `src/core/release/release-evidence.test.ts` through Node's native
TypeScript stripping mode and then audits the portable example at
`release/v1-release-evidence.template.json`. The audit
prints only a sanitized decision summary. It never prints credentials, raw
deployment output, mailbox content, or local workstation paths.

## Evidence object

The canonical validator lives in `src/core/release/release-evidence.ts`; there
is no `.mjs` compatibility bridge. Its public API is
small on purpose:

```js
import {
  createReleaseEvidence,
  evaluateReleaseEvidence,
  REQUIRED_SECTION30_ITEMS,
} from './src/core/release/release-evidence.ts';

const evidence = createReleaseEvidence({
  evidenceVersion: '1.0',
  product: 'Gulo Gulo',
  version: '0.1.7',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  generatedAt: '2026-08-23T00:00:00Z',
  releaseDecision: 'conditional',
  section30: [/* every REQUIRED_SECTION30_ITEMS entry */],
  securityFindings: [],
  tests: [],
  artifacts: [{
    name: 'operator guide',
    path: 'doc/release-readiness.md',
    purpose: 'Release boundary and evidence instructions.',
  }],
  residualRisks: ['External service rehearsal is still required.'],
  nextCandidates: ['Wire provider adapters.'],
});

const summary = evaluateReleaseEvidence(evidence);
```

`createReleaseEvidence` returns a frozen, normalized object. It enforces the
following rules before a release can be discussed:

- all 46 applicable Section 30 item IDs must occur exactly once;
- `verified` and `contract` entries must point to repository-relative evidence;
- `deferred` and `exception` entries must name an owner, mitigation, rationale,
  and dated approval;
- critical or high findings cannot remain `open`;
- failed tests block the release;
- artifacts, rationale, commands, and residual risks are scanned for secrets,
  private keys, tokens, and workstation paths;
- an `approved` decision is rejected when the checklist still contains a
  deferred or exception item.

There are four checklist statuses:

- `verified` means the local and CI evidence is sufficient for the stated
  contract;
- `contract` means the behavior is specified and tested at the boundary, but a
  vendor or deployment environment must still prove it;
- `deferred` means the item is intentionally left for the provider rehearsal;
- `exception` is the same kind of explicit deferral when the owner wants to
  call out a formal non-conformance.

`evaluateReleaseEvidence` reports `productionReady: false` whenever a contract,
deferred, exception, conditional test, or accepted security finding remains.
That conservative result is intentional: a green repository check is not a
certificate, a live LDAP bind, or a measured zero-downtime cutover.

## API and MCP handling

The tenant monitoring API and MCP stay read-only in V1. M10 adds a release
evidence vocabulary; it does not add a write-capable release endpoint.

The provider/operator plane may expose a sanitized read operation equivalent to
the following contract:

| Surface | Operation | Result |
|---|---|---|
| HTTP | `GET /provider/release/evidence` | current decision, checklist counts, test statuses, residual risks, and next candidates |
| MCP | `gulogulo.release.evidence` | the same read-only object, scoped to the provider deployment |
| HTTP | `GET /provider/release/capabilities` | evidence schema version and supported status values |
| MCP | `gulogulo.release.capabilities` | the same capability document |

The response must be derived from `createReleaseEvidence` before publication.
It must contain the release version, commit identifier, Section 30 status
counts, sanitized evidence references, and correlation metadata. It must not
contain passwords, tokens, private keys, mailbox content, raw command output,
Docker socket paths, unrestricted Kubernetes arguments, or absolute local
paths.

The tenant, master, and user audiences may read only the subset allowed by the
existing RBAC and log-visibility policy. They cannot approve an exception,
change a status, start an upgrade, or mark a live rehearsal complete. A
provider approval remains an auditable, separate operation.

## Login and browser boundary

The current HTML5/TypeScript shell is deliberately honest about its stage. It
uses secure-cookie and CSRF contracts, renders mail/calendar/contact views,
and refuses to treat realtime metadata or message HTML as trusted application
content. The authenticated `/login` route is wired to the real, provider-
backed identity client (`src/runtime/login.ts` resolves the configured
`GULOGULO_PLATFORM` target and calls its `PlatformAdapter` — LDAP or
DB-backed for standalone, UAPI for cPanel, REST for Plesk) for every login
outside `GULOGULO_FIXTURE_MODE=true`; this is not faked by the release audit.
That route keeps the Gulo Gulo artwork at the left of the login layout,
scaled to 128×128, with the form on the right, as recorded in the canonical
artwork memory.

## External-evidence checklist

Before calling a deployment production-ready, an operator should attach these
records to the release commit or release system:

The detailed hand-off procedure and the account-deletion, backup/restore,
scanner, migration, rollback, and incident/DR runbooks are collected in
[INSTALL.md](../INSTALL.md).

1. Package build evidence per target: each of `package-standalone.yml`,
   `package-cpanel.yml`, and `package-plesk.yml` builds, installs
   non-interactively, boots the compiled server, and polls
   `/health/ready`/`/`; on cPanel/Plesk the systemd enable/start step is
   stubbed (no init system in the CI container) — real field evidence for
   that part, and for the Apache/nginx reverse-proxy wiring, is still
   outstanding (see `../INSTALL.md`).
2. TLS/ACME issuance, renewal, expiry alert, LDAP bind, and PostgreSQL backup
   evidence.
3. Postfix, Rspamd, ClamAV, Dovecot, Sieve, CalDAV, CardDAV, and autodiscovery
   client results.
4. Encrypted backup, tenant/user restore, purge, and account deletion records.
5. Each target's real in-place upgrade and rollback rehearsal timings (see
   `doc/upgrade-and-migration.md`), including the pre-upgrade backup restore.
6. Approved RPO/RTO, incident, and disaster-recovery runbooks.

When these records exist, replace the corresponding `deferred` or `contract`
entries in a release evidence object with `verified`, use the actual release
commit SHA, and rerun `npm run test:m10` plus the GitHub Actions quality gates.

## Future work deliberately outside M10

Shared mailboxes, resource calendars, write-capable tenant API/MCP, assisted
IMAP migration, and provider-specific live adapters remain next-version or
deployment work. Keeping them out of this gate makes the product smaller and
safer to review; it does not prevent adding them later behind a new contract
and a new acceptance record.
