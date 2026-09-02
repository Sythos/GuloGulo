# Compose profiles and deterministic fixtures

> **⚠️ Documento in transizione.** Il modello di distribuzione container/Docker descritto in questo documento è stato rimosso dal repository. Il progetto sta migrando a tre pacchetti di distribuzione (cPanel, Plesk, archivio standalone) — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Questo documento verrà riscritto in una milestone successiva; nel frattempo le istruzioni Docker/compose qui sotto non sono più applicabili.

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

`compose.yaml` is the first operator experience. It runs the unprofiled
`gulogulo` service by default and provides disposable `local`, `test`, and
`fixture` profiles for checks.

## Start the scaffold

```powershell
Copy-Item .env.example .env
docker compose --env-file .env config --quiet
docker compose --env-file .env up --build -d gulogulo
docker compose --env-file .env ps
```

The service listens on `127.0.0.1:8080` by default. The image is non-root,
read-only at the root filesystem, drops all Linux capabilities, and keeps
runtime state in named volumes. Set `GULOGULO_VOLUMES_EXTERNAL=true` only when
the volumes were created and backed up independently of Compose; this keeps
user data safe across container replacement and blue/green upgrades. The mail,
DAV, and backup paths are persistent mounts even while their higher-level
protocol services are still future milestones.

## Profiles

The `local` and `test` services run `npm test` inside the same image. The
`fixture` service validates the committed manifest without contacting an
external service.

```powershell
docker compose --profile local config --quiet
docker compose --profile test run --rm --no-deps gulogulo-test
docker compose --profile fixture run --rm --no-deps gulogulo-fixture
```

Use a unique `GULOGULO_VOLUME_PREFIX` in CI. The fixture smoke script does this
automatically and removes its project and volumes unless `-KeepRunning` is
requested.

## Fixture contents

`test/fixtures/manifest.json` is the entry point. The tenant fixture contains
two fake users, one alias, a gross quota, and explicit no-catch-all/no-forwarding
flags. The failure fixture describes loopback-only LDAP/PostgreSQL outage cases
and the safe no-dependency mode. There are no real addresses, passwords,
message bodies, cookies, or private keys.

Run the deterministic local checks (Docker is required for the final part):

```powershell
./scripts/m1-fixture-smoke.ps1 -RequireMetrics
```

The script validates JSON and metadata first, then checks the Compose model,
builds the image with a refreshed Ubuntu base, runs the fixture validator,
waits for a healthy runtime, probes liveness/readiness/metrics, and tears down
the isolated project.

The ordinary Compose smoke path runs on the host architecture. Multi-architecture
image coverage is a separate Buildx gate: CI builds and validates the same
Ubuntu 26.04 image for both `linux/amd64` (x86_64) and `linux/arm64` (ARM64)
before the profile and fixture checks run.
