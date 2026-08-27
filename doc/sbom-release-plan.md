# SBOM and signed-image release plan

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

The local proof already produces OCI provenance attestations, but it currently
turns SBOM generation off for disposable tar exports. That is deliberate: the
local proof is testing the runtime image and keeps its output small. A real
release needs a separate, registry-oriented supply-chain lane that publishes
immutable image digests and an SBOM bound to each digest.

## Planned release lane

1. Build the release images with BuildKit on `linux/amd64` first, then run the
   final `linux/amd64` plus `linux/arm64` artifact gate after AMD64 is green.
2. Push each image to the public registry under an immutable release reference
   and capture its exact `sha256` digest. A mutable tag is never a release
   identity.
3. Enable BuildKit SBOM metadata (`--attest type=sbom` or `--sbom=true`) and
   retain the SPDX or CycloneDX document produced by the pinned generator.
4. Generate a GitHub Artifact Attestation for the SBOM with `actions/attest`;
   bind it to the exact image subject name and digest. Keep the existing build
   provenance attestation as a separate predicate.
5. Grant `id-token: write`, `attestations: write`, and `packages: write` only to
   the push/manual release caller. Pull-request validation remains read-only.
6. Verify the published image and its attestations from a clean job. The
   consumer check must confirm repository, workflow, commit, subject digest,
   SBOM predicate type, and the absence of secrets or local host paths.
7. Store a small release evidence record containing image name, platform,
   digest, SBOM format/generator, SBOM digest, attestation reference, scan
   result, and verification timestamp.

The amd64 functional proof remains the fast gate. The arm64 pass builds and
verifies artifacts and attestations; it does not repeat stateful Compose
rehearsals under emulation.

## Why the current workflow is not the final SBOM lane

The existing quality workflow builds local OCI tar files with
`--provenance=false --sbom=false`, then separately attests those files when the
caller has write permission. That is useful for offline proof and explains the
current README gap. It does not publish a consumer-verifiable registry image,
and a provenance statement is not an SBOM.

The implementation pass should therefore add a dedicated release workflow and
not silently change every local proof build. The release workflow can use the
same Ubuntu 26.04 Dockerfiles and the same amd64-first policy while producing
the extra registry evidence only when a release is intentionally requested.

## Verification rules

The release gate must fail if:

- the SBOM is missing, empty, malformed, or not tied to the published digest;
- a platform digest is mutable, omitted, or different from the attested subject;
- provenance or SBOM permissions are present in pull-request callers;
- an image or SBOM includes credentials, private keys, mailbox data, or a host
  path;
- the consumer-side `gh attestation verify` check cannot validate the exact
  repository and predicate type.

The repository is public, so the public-repository Artifact Attestations path
is available without treating an Enterprise-only private-repository rule as a
project requirement. The release gate still needs a registry package policy,
retention policy, vulnerability-scan policy, and owner approval before it can
close the README item.
## Handoff status

This document is a plan, not a claim that SBOM publication is already done.
The README keeps the SBOM/digest item open until the dedicated workflow,
consumer verification, and a green release run exist.
