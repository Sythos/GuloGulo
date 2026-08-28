# SBOM and signed-image release workflow

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

This document describes the release lane that is now part of the repository.
The local Compose proofs remain deliberately small and offline; the release
lane is the place where a field-test container or a registry image gets an
SBOM, an immutable digest, GitHub Artifact Attestations, and (for a version tag)
a GitHub Release with downloadable evidence.

## What is implemented

The workflow lives at
[`.github/workflows/container-release.yml`](../.github/workflows/container-release.yml)
and supports a manual field mode, a manual trusted publish mode, and an
automatic version-tag release mode:

1. **Field container (`publish=false`)** builds one `linux/amd64` image, emits
   a Docker archive and SHA-256 checksum, and writes an SPDX JSON SBOM with
   [`anchore/sbom-action@v0.24.0`](https://github.com/anchore/sbom-action).
   The archive is the disposable container package used for the first field
   tests. It never receives registry credentials or a signing permission.
2. **Manual registry release (`publish=true`)** is allowed only from `main`
   and requires `architecture_mode=multiarch`. It builds the final
   `linux/amd64,linux/arm64` image and pushes it to GHCR under a caller-supplied
   immutable tag. An amd64-only registry publication is rejected; amd64 remains
   the separate field-test archive path.
3. **Automatic version release** runs when a numeric semver tag such as
   `0.1.4` is pushed. The tag must exactly match `package.json.version`; the
   job goes directly to the final `linux/amd64,linux/arm64` target, publishes
   the image to GHCR, and creates or updates the matching GitHub Release with
   the SPDX SBOM and digest-bound release evidence. Buildx enables provenance
   and SBOM metadata in both registry paths.

After the push, Syft (through the pinned SBOM action) scans the exact
`image@sha256:...` subject. The workflow validates the SPDX document, creates
an SBOM attestation with [`actions/attest@v4`](https://github.com/actions/attest),
creates the separate build-provenance attestation with
[`actions/attest-build-provenance@v4`](https://github.com/actions/attest-build-provenance),
and verifies the SBOM attestation through the GitHub CLI consumer path. The
release evidence artifact records repository, commit, image, tag, digest,
platforms, format, and verification status without including credentials or
mail data. The GitHub Release assets are generated only after the exact pushed
digest has passed the consumer verification gate.

The static contract is checked by
[`scripts/sbom-release-audit.ts`](../scripts/sbom-release-audit.ts), and its
unit tests run as `npm run test:sbom` and as part of `npm test`. The audit
requires a tag-only automatic trigger, an exact package-version check, the
multiarch and attestation gates, and the GitHub Release commands. It rejects
pull-request triggers, unapproved secrets, disabled SBOM generation, missing
digest binding, and invalid or path-leaking SPDX output.

## Recommended invocation

Start with the fast field package:

```text
Actions → Container release (SBOM and attestations) → Run workflow
architecture_mode = amd64
publish = false
```

Download both artifacts: the `docker.tar` plus checksum for the container and
the SPDX JSON SBOM. Verify the checksum before importing the image, then follow
the operator preparation and external-dependency checks in
[`READ_BEFORE_USE.md`](READ_BEFORE_USE.md). In particular, configure external
volumes, LDAP, PostgreSQL, TLS/ACME, DNS, reverse proxy, scanner feeds, and the
optional Plesk/cPanel tenant boundary before calling the package operational.

For a final release, update `package.json.version`, commit the change to
`main`, create an annotated numeric tag with the same value, and push both the
commit and tag. The tag path starts the multiarch build directly; it does not
repeat a separate AMD64 publication. For example:

```text
git tag -a 0.1.4 -m "Gulo Gulo 0.1.4"
git push origin main 0.1.4
```

The manual registry mode remains available for a trusted rehearsal:
`publish=true` with `architecture_mode=multiarch`. A manual publish request
with `architecture_mode=amd64` fails before registry login.

## Permissions and trust boundary

The workflow has only `contents: read` by default. The registry job receives
`contents: write`, `packages: write`, `id-token: write`, and
`attestations: write` because it must publish the GHCR subject and create or
update the GitHub Release. Manual publication remains restricted to
`refs/heads/main`; automatic publication is restricted to a pushed numeric
semver tag whose value equals `package.json.version`. It uses the built-in
`GITHUB_TOKEN`; no personal token, registry password, LDAP secret, database
password, private key, or mailbox data is stored in the repository.

The field job cannot publish or attest. The registry job pushes only the image
digest returned by Buildx and binds both predicates to that digest. A mutable
tag is a convenience lookup, never the release identity; the release evidence
and attestation subject remain the immutable digest. The optional GitHub
environment protection for production releases should be enabled by the
repository owner before using the manual publish path. Creating and pushing a
version tag remains an explicit owner action even though the release build is
automatic once that tag exists.

## Why local proofs still disable BuildKit SBOM metadata

The existing LP0–LP9 Compose checks export disposable OCI archives with the
smallest possible metadata and do not publish them. They still have their own
provenance checks where appropriate. That choice is independent from this
release workflow: the field job produces a real SBOM with Syft, while the
registry job enables BuildKit SBOM/provenance metadata and then scans the exact
published digest. No local proof is silently turned into a public release.

## Verification commands

For a published image, the workflow itself runs the consumer verification. A
release operator can repeat it from a clean machine after downloading the
release evidence:

```text
docker buildx imagetools inspect ghcr.io/Sythos/GuloGulo@sha256:<digest>
gh attestation verify oci://ghcr.io/Sythos/GuloGulo@sha256:<digest> \
  --repo Sythos/GuloGulo \
  --predicate-type https://spdx.dev/Document/v2.3
```

The second command verifies the SPDX SBOM predicate. Run the same command
without `--predicate-type` to inspect the default build-provenance predicate.
Keep the digest, SBOM checksum, attestation bundle reference, scanner result,
and verification timestamp in the provider release record.

## What remains an operator check

The implementation is complete, but a green workflow run is not a production
deployment. The owner/operator still has to verify package visibility and
retention in GHCR, the selected base-image and package policy, vulnerability
scan disposition, attestation verification from a clean identity, image import
on both supported architectures, and the external storage/scanner/LDAP/
PostgreSQL/Plesk-or-cPanel setup described in `READ_BEFORE_USE.md`.
