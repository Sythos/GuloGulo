// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { auditSbomDocument, auditWorkflowText } from './sbom-release-audit.ts';

const validWorkflow = 'on: workflow_dispatch: architecture_mode: publish: linux/amd64 linux/arm64 docker/build-push-action@v6 sbom: true anchore/sbom-action@v0.24.0 format: spdx-json actions/attest@v4 sbom-path: actions/attest-build-provenance@v4 subject-digest: push-to-registry: true packages: write id-token: write attestations: write gh attestation verify --predicate-type https://spdx.dev/Document/v2.3 github.ref == \'refs/heads/main\'';

test('workflow audit accepts the release contract', () => {
  assert.doesNotThrow(() => auditWorkflowText(validWorkflow));
});

test('workflow audit rejects automatic release triggers', () => {
  assert.throws(() => auditWorkflowText(`${validWorkflow}\npush:`), /must not run automatically/);
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
