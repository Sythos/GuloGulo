# Ubuntu 26.04 LTS and container patching

> **⚠️ Documento in transizione.** Il modello di distribuzione container/Docker descritto in questo documento è stato rimosso dal repository. Il progetto sta migrando a tre pacchetti di distribuzione (cPanel, Plesk, archivio standalone) — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Questo documento verrà riscritto in una milestone successiva; nel frattempo le istruzioni Docker/compose qui sotto non sono più applicabili.

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

Gulo Gulo-owned images target Ubuntu 26.04 LTS (Resolute Raccoon) on both
`linux/amd64` (x86_64) and `linux/arm64` (ARM64). The current runtime image
installs the current stable Node.js release on top of Ubuntu and runs
`apt-get update` followed by `apt-get upgrade` during the image build. That
makes the build repeatable enough to audit while keeping the running container
immutable.

The Dockerfile validates the BuildKit `TARGETARCH` value against
`dpkg --print-architecture` inside the Ubuntu target rootfs before selecting the
official Node.js archive. This catches accidental x86/ARM mismatches instead
of producing an image that only fails when it starts.

## Runtime context and image boundary

The repository root `.dockerignore` is intentionally default-deny. Docker may
read the repository as a build context, but only the following inputs are
allowed through that boundary:

- `package.json` and `package-lock.json` for the reproducible install;
- the two compiler projects needed to build the server and browser bundle;
- canonical server TypeScript and PostgreSQL migration SQL;
- the browser shell (`web/index.html`, `web/styles.css`, `web/manifest.json`,
  `web/build.ts`, and `web/src/app.ts`);
- the login artwork at `assets/gulo-gulo-calendar-mail.png`;
- the root-only `scripts/container-patch.sh` helper.

Documentation, READMEs, tests, fixtures, release evidence, Compose files, CI
metadata, synthetic Docker contexts, compatibility bridges, and local tooling
are excluded. They remain available in the checkout for maintainers and for a
future GitHub Pages site or project wiki, but they are not sent into the
application image.

The image compiles the TypeScript sources and browser bundle, prunes
development dependencies, and then removes build-only sources, compiler
projects, tests, declarations, and helper scripts. The runtime layer retains
the compiled server, compiled browser assets, static shell, login artwork,
production `node_modules`, `package.json`, and migration SQL. The external
configuration, mailbox, DAV, queue, scanner-signature, backup, and patch-state
volumes remain outside the image and are mounted according to the deployment
profile.

The disposable `gulogulo-test` Compose profile sets `INSTALL_DEV=true` so its
development dependencies and generated test output remain available. Because
the default-deny context excludes repository tests, fixtures, release
manifests, Compose helpers, and CI metadata, the profile mounts those inputs
read-only from the checkout (including the TypeScript projects used by the
milestone suites). It is never used as a release or production image. The
default (`INSTALL_DEV=false`) build applies the runtime-only cleanup above.

The one-shot `gulogulo-fixture` profile follows the same rule while retaining
the production-cleaned image: it mounts only `test/fixtures` at
`/app/test/fixtures` as read-only input from the checkout. This exposes the
deterministic, non-secret M1 fixture set to the disposable validator without
copying fixtures into a release or production image.

The LP1 disposable proof checker follows the same boundary: its `scripts/`
helpers are mounted read-only from the checkout only for the proof run. They
are not copied into, or retained by, the production image. This keeps the
verification path honest without widening the runtime image.

The base image and Node release are recorded in the Dockerfile and rechecked
against authoritative upstream sources when they change. A clean security
rebuild uses a fresh base and avoids stale builder cache:

```powershell
docker build --pull --no-cache --build-arg NODE_VERSION=26.7.0 -t gulogulo:local .
```

To exercise both supported OCI targets with Buildx (the same shape used by
GitHub Actions):

```powershell
docker buildx build --pull --platform linux/amd64,linux/arm64 `
  --build-arg NODE_VERSION=26.7.0 --provenance=false --sbom=false .
```

## Why updates happen at build time

The application container is non-root, has a read-only root filesystem, drops
capabilities, and does not have the Docker socket. Mutating it in place with
APT would defeat those boundaries and make rollback difficult. The safe
operator action is therefore:

1. build a new image with the Ubuntu security update step;
2. run the full tests, image scan, and smoke checks;
3. deploy it through the blue/green process;
4. keep the previous image available for rollback;
5. record the image digest, package changes, SBOM, scan result, timestamp, and
   cutover outcome.

Every future Gulo Gulo-owned Dockerfile follows the same Ubuntu base and
build-time APT policy. Vendor images for Postfix, Dovecot, Rspamd, or ClamAV
must pass a compatibility review; when a vendor does not publish Ubuntu 26.04,
we build an Ubuntu-based image or record an owner-approved exception.

## Maintenance helper

The image contains `/usr/local/sbin/gulogulo-container-patch`. It is meant for
a short-lived, explicitly privileged maintenance container, not for the
running application process:

```text
gulogulo-container-patch status
gulogulo-container-patch check
gulogulo-container-patch apply
```

`check` and `apply` require root and perform `apt-get update`; `apply` then
performs `apt-get upgrade -y`. The helper writes a small allowlisted JSON status
file to `/var/lib/gulogulo/patch/status.json`. It never writes APT output,
credentials, or arbitrary command text into that file.

On an APT failure the helper atomically replaces the transient `checking` or
`applying` state with `state: "failed"` and a short allowlisted reason such as
`apt_update_failed` or `apt_apply_failed`. The application reads the file
through the typed `src/ops/patch/status.ts` sanitizer, so absent, corrupt, or
unrecognised state is exposed as a fail-closed `unknown` DTO.

The LP5 Compose proof makes the ownership boundary visible: the disposable
`gulogulo-lp5-maintenance` service is the only writer, while
`gulogulo-lp5-web` mounts `lp5-patch-state` read-only. The helper is exercised
with `status` in the offline proof; real `check`/`apply` runs belong to an
operator-controlled maintenance environment with explicitly reviewed egress.

In production, prefer a disposable maintenance image or a CI/CD rebuild over
running `apply` against a live application container. The helper exists to make
the patch contract explicit and testable, not to turn Gulo Gulo into a mutable
package manager appliance.

## Monitoring and control boundary

`GET /ops/patch/status` and the future read-only MCP monitoring tool expose the
allowlisted state, base image, Node version, and timestamps. They do not execute
APT and they do not accept shell commands. This is intentional: the current
V1 API/MCP contract is read-only for tenant monitoring. Provider-side patch
control belongs to the deployment pipeline or an authenticated, allowlisted
operator control plane introduced by a later security-reviewed milestone.
