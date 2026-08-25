# Ubuntu 26.04 LTS and container patching

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
