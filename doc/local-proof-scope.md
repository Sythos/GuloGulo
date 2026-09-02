# LP0 local proof scope

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

LP0 is the deliberately boring freeze before the first local deployment
rehearsal. It says exactly what the local proof is allowed to prove, what it
must never accidentally touch, and which services LP1 and the later local
milestones will add. It is a contract, not a claim that the current scaffold is
already a complete mail provider.

## The short version

The local proof is an isolated, synthetic-data-only deployment of Gulo Gulo.
It uses reserved names, an internal certificate authority, and an offline
runtime network. It does not need a real domain, public DNS, public ACME, real
mailboxes, or a connection to an external mail system. The local release label
is `v0.1.0-local-proof.1`.

The machine-readable source for this boundary is
[`release/local-proof-scope.json`](../release/local-proof-scope.json). The
validator and its tests live in `src/core/release/local-proof-scope.ts` and
`src/core/release/local-proof-scope.test.ts`; `npm run test:lp0` and
`npm run test:lp0:audit` are the two convenient entry points.

## What LP0 freezes

### Names and certificates

- `gulogulo.test` is the synthetic tenant/domain name.
- `webmail.localhost`, `calendar.localhost`, and `contacts.localhost` are
  local browser endpoints.
- `.test` and `.localhost` are reserved for this rehearsal. They must not be
  replaced with a real public domain during LP1–LP9.
- TLS is terminated with a locally trusted CA generated for the proof. Public
  Let's Encrypt and generic public ACME are explicitly disabled here.
- Host-file or local DNS entries may point these names at IPv4/IPv6 loopback or
  the private Compose/Kubernetes test network. No public DNS record is created.

### Data and identities

- Every account, message, attachment, calendar object, contact, quota, and
  audit event is synthetic.
- No production credentials, private keys, mailbox exports, real recipient
  addresses, or user-generated personal data may enter the proof.
- LDAP and PostgreSQL are local disposable dependencies in LP1 and later. They
  are not the provider's external identity or application database.
- The local tenant remains isolated from every other test run by project name,
  network, and external-volume namespace.

### Runtime network boundary

The build may download pinned or latest-stable build inputs when the operator
explicitly runs a build. Once the proof is running, application and dependency
containers use an `offline_runtime` policy: no Internet egress, no public DNS,
no public ACME challenges, and no access to a Docker socket. A local network is
allowed only for the declared Gulo Gulo services and their health checks.

The policy is intentionally stronger than “we promise not to send mail”. It
prevents an accidental update check, telemetry call, public certificate
request, or real SMTP delivery from turning a local test into an external
operation.

## Service inventory for LP1–LP9

LP0 freezes the inventory; it does not claim that each service is already
implemented. The local proof will add and exercise these components in later
milestones:

| Service | Local proof role |
|---|---|
| `gulogulo` | WebWare/API, session, tenant and read-only monitoring surface |
| `ldap` | Disposable local identity directory |
| `postgresql` | Disposable local application state and quota ledger |
| `postfix` | Local SMTP ingress/egress simulation with no public delivery |
| `dovecot` | Local IMAP and IMAP IDLE mailbox behavior |
| `rspamd` | Local message-scanning verdicts and queue metadata |
| `clamav` | Local antivirus scanning contract and safe failure mode |
| `caldav` | Local calendar protocol endpoint |
| `carddav` | Local address-book protocol endpoint |
| `local-dns` | Reserved-name resolution inside the test boundary |
| `local-ca` | Disposable trust root and endpoint certificates |

The implementation can package more than one logical role in a container when
that is useful for the first rehearsal, but the role boundaries and health
contracts remain visible. The final provider deployment may split them again.

## Architecture targets

Images and Compose/Kubernetes manifests target `linux/amd64` (x86_64). A
developer may run the host architecture locally; CI validates the same image
target on Ubuntu 26.04 LTS (AMD64). The LP0 manifest is the source of truth
for this platform and the local-only release identity.

## Acceptance criteria

LP0 is complete when all of these remain true in a clean checkout:

1. `release/local-proof-scope.json` validates without network access.
2. The manifest declares only reserved local names and synthetic data.
3. Public DNS and public ACME are false, and the runtime policy is
   `offline_runtime`.
4. The required service inventory and both architecture targets are complete.
5. The LP0 test and audit commands pass locally and in the pull-request and
   post-merge GitHub Actions gates.
6. No container is started and no external system is contacted as part of LP0.

## Explicitly deferred

The following belong to a later external/public phase and must not be smuggled
into the local proof:

- registration or use of a real domain and public DNS;
- public ACME/Let's Encrypt challenges and public certificate renewal;
- delivery to or acceptance from real Internet mail systems;
- production LDAP, PostgreSQL, storage, backup, or monitoring endpoints;
- public registry publication, signed production image release, and live
  Kubernetes traffic switching;
- production RPO/RTO evidence, incident rehearsal, and standard-client testing
  against real provider infrastructure.

When that phase is eventually approved, it gets a separate release identity and
separate evidence. It does not overwrite the local proof manifest.
