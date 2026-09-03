# Release readiness and the M10 boundary

> **⚠️ Documento in transizione.** Il workflow `container-release.yml` descritto nella sezione "Artifact provenance in GitHub Actions" qui sotto non esiste più nel repository — è stato rimosso in una milestone precedente. Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

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
| Security | tenant/RBAC boundaries, session and CSRF contracts, MFA primitives, HTML sanitization, abuse limits, secret-free audit events, and the SBOM/digest release workflow | provider secret rotation, real TLS/LDAP/DB configuration, vulnerability disposition, registry policy, and clean-consumer release verification |
| Data | quota allocation, 28-day purge, backup authorization, encrypted archive shape, idempotent lifecycle operations | an actual restore, deletion runbook execution, external-volume snapshots, measured RPO/RTO |
| Interoperability | SMTP/IMAP/IDLE, Sieve, DAV object semantics, discovery, ICS/vCard, and timezone contracts | vendor client matrix and real protocol endpoints |
| Operations | health, metrics, logging, alerts, queue visibility, Docker/Kubernetes migration contracts, and the shared read-only scanner-signature boundary | host-side scanner feed publication, Docker host replacement, Kubernetes cutover, rollback, and incident tabletop |
| Governance | role and delegation policy, default-deny master access, optional Plesk/cPanel tenant-tool boundary, read-only API/MCP, ADRs, documentation inventory, and GitHub Artifact Attestations/SBOM workflow for trusted releases | owner approval of the deployment and disaster-recovery runbooks plus any provider-specific panel adapter |

The source of truth for the checklist remains Section 30 of `GULOGULO.md`.
The repository copy is deliberately an evidence boundary, not a second product
specification.
The root README now tracks repository implementation only: checked entries have
code or a tested contract, while deployment and consumer verification are
listed in [READ_BEFORE_USE.md](READ_BEFORE_USE.md). The release evidence object
continues to distinguish verified, contract, conditional, and deferred
external evidence.

LP8 packages this boundary in
[`release/lp8-local-proof-bundle.json`](../release/lp8-local-proof-bundle.json)
and [`doc/lp8-evidence-operator.md`](lp8-evidence-operator.md). The bundle
indexes the local proof manifests, fixtures, operator notes, and CI
provenance. It remains safe to share because it contains
synthetic references and sanitized links only; live provider evidence and
provider-specific Plesk/cPanel adapters remain outside this checkout. The
repository now contains the manual field lane plus an automatic numeric-tag
SBOM/container release lane; its field, registry, and clean-consumer
verification still belongs to the operator.

## Artifact provenance in GitHub Actions

Trusted push builds generate signed GitHub Artifact Attestations for every OCI
tar archive produced by the image build gate. The reusable quality
workflow uses `actions/attest-build-provenance@v4` (the build-provenance wrapper
around `actions/attest`) with the minimum OIDC and attestation permissions, then
verifies every generated subject with the GitHub CLI before
the remaining release checks continue. Pull-request validation still runs all
tests and image checks, but does not mint attestations from untrusted PR code.

The workflow intentionally attests the exact OCI archive produced by Buildx,
not a floating tag. This binds the provenance record to the immutable digest of
the tested artifact. A maintainer can verify a downloaded archive from a
connected checkout with:

```text
gh attestation verify PATH/TO/gulogulo-<image>-ubuntu-26.04.oci.tar --repo Sythos/GuloGulo
```

The `container-release.yml` workflow generates an SPDX SBOM with
`anchore/sbom-action@v0.24.0`, binds it to the exact GHCR digest with
`actions/attest@v4`, and keeps the separate build-provenance wrapper
`actions/attest-build-provenance@v4`. A numeric semver tag whose value matches
`package.json.version` starts the final `linux/amd64` build directly;
after verification the workflow creates or updates the matching GitHub Release
with the SBOM and digest-bound evidence. The trusted manual `main` publish path
remains available for rehearsals. Verify a registry subject with the OCI form
documented by GitHub (`gh attestation verify
oci://REGISTRY/IMAGE@sha256:DIGEST --repo Sythos/GuloGulo
--predicate-type https://spdx.dev/Document/v2.3`). Artifact attestations do not
replace image vulnerability scanning, SBOM review, signatures, or the external
deployment rehearsal.

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
  version: '0.1.4',
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
content. The complete authenticated `/login` route and its provider LDAP
adapter are not faked by the release audit. When that route is wired, it must
keep the Gulo Gulo artwork at the left of the login layout, scale it to
128×128, and keep the form on the right as recorded in the canonical artwork
memory.

## External-evidence checklist

Before calling a deployment production-ready, an operator should attach these
records to the release commit or release system:

The detailed hand-off procedure and the account-deletion, backup/restore,
scanner, migration, rollback, and incident/DR runbooks are collected in
[READ_BEFORE_USE.md](READ_BEFORE_USE.md).

1. Docker `linux/amd64` image digest, SBOM, and signature.
2. TLS/ACME issuance, renewal, expiry alert, LDAP bind, and PostgreSQL backup
   evidence.
3. Postfix, Rspamd, ClamAV, Dovecot, Sieve, CalDAV, CardDAV, and autodiscovery
   client results.
4. Encrypted backup, tenant/user restore, purge, and account deletion records.
5. Docker replacement and Kubernetes blue/green timings, including rollback
   and connection-drain evidence.
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
