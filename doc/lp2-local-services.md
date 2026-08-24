# LP2 local LDAP and PostgreSQL proof

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

LP2 adds a small, deliberately disposable dependency lab to the local Compose
checkout. It gives the Gulo Gulo adapters something real to talk to without
requiring a public DNS name, an Internet-facing service, an external LDAP
directory, or an operator PostgreSQL instance.

This is a proof environment, not a recommended production stack. The LDAP
directory contains one synthetic user and PostgreSQL contains one deterministic
probe row. The credentials in `.env.example` are placeholders and must never be
copied into a real deployment.

## What the profile starts

The profile is split into a runtime profile and a one-shot proof client:

| Service | What it does | Endpoint | Host publication |
|---|---|---|---|
| `lp2-ca` | Creates a seven-day synthetic CA and two leaf certificates | shared `lp2-tls-data` volume | none |
| `lp2-ldap` | Runs OpenLDAP with an LDAPS-only listener | `ldaps://lp2-ldap:636` | none |
| `lp2-postgres` | Runs PostgreSQL with TLS required for network clients | `postgresql://lp2-postgres:5432/gulogulo` | none |
| `gulogulo-lp2-proof-check` | Connects with `ldapts` and `pg`, validates TLS and fixture data | internal client only | none |

All four services use the `lp2-runtime` Compose network. It is marked
`internal: true` and has IPv4 and IPv6 enabled. Nothing in this profile uses
host networking, a privileged container, a Docker socket, or a host port. The
same network is therefore useful for testing endpoint configuration while
keeping the proof deliberately offline.

The machine-readable contract lives in
[`release/lp2-local-services.json`](../release/lp2-local-services.json). The
static audit is `scripts/lp2-compose-audit.mjs`; the live proof client is
`scripts/lp2-proof-smoke.mjs`, orchestrated from the host by
`scripts/lp2-compose-smoke.mjs`.

## Prerequisites

Use Docker Desktop or a Docker Engine with Compose v2. The images target the
project's Ubuntu 26.04 LTS baseline and are expected to build on both
`linux/amd64` and `linux/arm64`.

From the `git/` checkout:

```powershell
Copy-Item .env.example .env
node scripts/lp2-compose-audit.mjs
docker compose --profile lp2 --profile lp2-check --file compose.yaml --env-file .env config --quiet
```

The audit does not contact a registry and does not start a container. The
Compose config command only expands and validates the local topology; image
builds may still need the normal Docker base-image/package repositories.

## Run the live proof

The proof harness creates a unique Compose project, network name, and volume
prefix. It builds the three Ubuntu utility/dependency images and the Gulo Gulo
proof-client image, starts the dependency profile, runs the client, and removes
only that project and its disposable volumes:

```powershell
$env:GITHUB_RUN_ID = "local"
node scripts/lp2-compose-smoke.mjs
```

The proof client itself is executed from the `gulogulo-lp2-proof-check` service,
not directly on the host. To execute the same lifecycle manually:

```powershell
$project = "gulogulo-lp2-manual"
docker compose --project-name $project --profile lp2 --file compose.yaml --env-file .env up --detach --build
docker compose --project-name $project --profile lp2 --file compose.yaml --env-file .env ps
docker compose --project-name $project --profile lp2 --profile lp2-check --file compose.yaml --env-file .env run --rm --no-deps gulogulo-lp2-proof-check
docker compose --project-name $project --profile lp2 --profile lp2-check --file compose.yaml --env-file .env down --volumes --remove-orphans
```

The proof client checks all of these things:

1. The local CA signs both dependency certificates.
2. LDAP accepts a verified LDAPS bind using the synthetic root DN.
3. The deterministic `alice` fixture is present below the user base DN.
4. PostgreSQL accepts a `verify-full` TLS connection with the local CA.
5. The `lp2_probe` row has the expected deterministic value.
6. PostgreSQL reports that the client backend is using SSL.
7. A small JSON result is written to the disposable proof-state volume.

The output intentionally reports only endpoint hostnames and boolean proof
flags. It does not print passwords, DSNs, private keys, LDAP entries beyond the
expected fixture flag, or database content beyond the fixed probe status.

## Synthetic LDAP contract

The fixture uses:

```text
Base DN:       dc=gulogulo,dc=test
User base DN:  ou=users,dc=gulogulo,dc=test
Root DN:       cn=admin,dc=gulogulo,dc=test
User:          uid=alice
Mail:          alice@gulogulo.test
Endpoint:      ldaps://lp2-ldap:636
```

`slapd` is started with a generated `slapd.conf`, an MDB data directory, and
an LDAPS listener. The root password is used only by the local bootstrap and
health check. `LDAPTLS_REQCERT=demand` and the mounted synthetic CA make the
health check fail if certificate verification is disabled or the wrong leaf is
served.

The directory data is stored in `lp2-ldap-data`, separate from the application
mail/DAV volumes. The default harness destroys it with the temporary project.
Setting `GULOGULO_LP2_VOLUMES_EXTERNAL=true` is allowed only for an operator
who has created and backed up those volumes independently; it does not turn
the fixture into a production directory.

## Synthetic PostgreSQL contract

The PostgreSQL fixture uses:

```text
Host:       lp2-postgres
Port:       5432
Database:   gulogulo
User:       gulogulo
SSL mode:   verify-full
Probe row:  lp2_probe(deterministic) = lp2-postgres-ready
```

Network clients are accepted only through `hostssl` rules. Plain `host`
connections are rejected. The proof client's `pg` connection supplies the
synthetic CA and requires hostname verification against `lp2-postgres`.

The fixture data is held in `lp2-postgres-data`. On first startup the entrypoint
initializes the cluster, creates the role/database, and inserts the probe row.
On later starts it reuses the named volume and keeps the row deterministic.

## TLS lifecycle and limits

`lp2-ca` creates a short-lived CA and certificates for `lp2-ldap` and
`lp2-postgres`. The CA signing key is removed after both leaf certificates have
been created. LDAP and PostgreSQL mount only the resulting certificate bundle
read-only and copy their own leaf key into a service-local path with the
appropriate ownership/mode.

This is enough to exercise trust configuration and hostname verification. It is
not ACME, not a replacement for Let's Encrypt, and not a place to test a real
certificate renewal workflow. LP2 never contacts public DNS or a public ACME
endpoint.

## Troubleshooting

If a service fails health checks, inspect only the named project:

```powershell
docker compose --project-name $project --profile lp2 --file compose.yaml --env-file .env logs --no-color --tail 120 lp2-ca lp2-ldap lp2-postgres
```

A stale fixture can be removed safely when using a throwaway project:

```powershell
docker compose --project-name $project --profile lp2 --profile lp2-check --file compose.yaml --env-file .env down --volumes --remove-orphans
```

Do not run `docker system prune` as part of this proof. If Docker itself is not
available on the workstation, run the static audit and let CI perform the
multi-architecture live Docker rehearsal.
