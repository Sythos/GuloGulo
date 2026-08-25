<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

# LP5 local operations and capacity proof

LP5 is a deterministic, synthetic local operations proof. Its capacity result
is a regression budget for the declared Compose fixture, not a production
capacity estimate or an availability promise. The machine-readable contract is
`release/lp5-local-operations-capacity.json`.

## Capacity measurement

The amd64 proof records startup and readiness time, p95 web and DAV request
duration, p95 queue and IMAP IDLE notification duration, HTTP error rate,
active IDLE connections, and container memory, CPU, and PID observations. The
measurement uses a monotonic clock and nearest-rank p95, so its calculation is
independent of wall-clock changes. Every measurement must meet the explicit
`amd64Budget` in the manifest; missing values fail closed.

The workload is deliberately bounded: 24 web requests, 16 DAV requests, 16
queue operations, and 8 simultaneous IDLE connections. It uses only synthetic
fixtures and the private dual-stack `lp5-runtime` network. No LP5 service may
publish a host port, use host networking, mount the Docker socket, or contact a
public endpoint.

## Architecture evidence

The normal functional proof is amd64-first. It is the only architecture that
has a local Compose capacity budget, because it executes the measured workload
on the GitHub-hosted runner. The final `multiarch` workflow is an ARM64 artifact
and attestation gate for the same commit; it verifies ARM64 buildability and
provenance but does not represent an ARM64 capacity measurement. Production-like
tenant volume, external services, and host-class benchmarking remain required
before making any capacity claim.

## Local commands

`scripts/lp5-compose-audit.ts` validates the static manifest, Compose safety,
typed source, and explicit budgets without starting Docker. The integrated
smoke script measures the internal runtime and emits a redacted JSON summary;
`scripts/lp5-proof-check.ts` performs the same bounded probes inside the
private network and fails closed if a metric is missing or exceeds a budget.
The intended project entry points are `npm run test:lp5` and
`npm run test:lp5:docker`.

## Explicit non-claims

LP5 does not prove production capacity, public DNS or ACME, public Internet
reachability, external SMTP/IMAP/DAV interoperability, real tenant workloads,
backup/restore, or production readiness.
