// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSbomDocument, auditWorkflowText } from './sbom-release-audit.ts';

const validWorkflow = `on:
  push:
    tags:
      - '[0-9]+.[0-9]+.[0-9]+'
  workflow_dispatch:
    inputs:
      architecture_mode:
      publish:
  linux/amd64 linux/arm64 docker/build-push-action@v6 sbom: true
  anchore/sbom-action@v0.24.0 format: spdx-json actions/attest@v4 sbom-path:
  actions/attest-build-provenance@v4 subject-digest: push-to-registry: true
  packages: write id-token: write attestations: write contents: write
  inputs.architecture_mode != 'multiarch'
  Registry publication is reserved for the final linux/amd64 + linux/arm64 target.
  gh attestation verify --predicate-type https://spdx.dev/Document/v2.3
  github.event_name == 'push' github.ref_type == 'tag'
  jq -r '.version' package.json
  must exactly match package.json version
  gh release create gh release upload --verify-tag
  github.ref == 'refs/heads/main'`;

test('workflow audit accepts the release contract', () => {
  assert.doesNotThrow(() => auditWorkflowText(validWorkflow));
});

test('workflow audit accepts the automatic version-tag trigger', () => {
  assert.doesNotThrow(() => auditWorkflowText(validWorkflow));
});

test('workflow audit rejects pull-request triggers', () => {
  assert.throws(() => auditWorkflowText(`${validWorkflow}\npull_request:`), /pull request/);
});

test('workflow audit rejects a broad push trigger without tag filtering', () => {
  assert.throws(() => auditWorkflowText(validWorkflow.replace("  push:\n    tags:", '  push:')), /tag-only automatic trigger/);
});

test('SBOM audit accepts a minimal SPDX document', () => {
  assert.doesNotThrow(() => auditSbomDocument({
    spdxVersion: 'SPDX-2.3',
    SPDXID: 'SPDXRef-DOCUMENT',
    documentNamespace: 'https://example.invalid/sbom/1',
    creationInfo: { created: '2026-08-28T00:00:00Z' },
    packages: [],
  }));
});

test('SBOM audit rejects private keys and workstation paths', () => {
  assert.throws(() => auditSbomDocument({
    spdxVersion: 'SPDX-2.3',
    SPDXID: 'SPDXRef-DOCUMENT',
    documentNamespace: 'https://example.invalid/sbom/1',
    creationInfo: {},
    packages: [{ name: 'C:\\Users\\runner\\private-key' }],
  }), /credential-like|workstation path/);
});
