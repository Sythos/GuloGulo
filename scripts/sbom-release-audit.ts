// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;

const root = resolve(process.cwd());
const workflowPath = resolve(root, '.github/workflows/container-release.yml');

function fail(message: string): never {
  throw new Error(`SBOM release audit failed: ${message}`);
}

function requireText(source: string, marker: string): void {
  if (!source.includes(marker)) fail(`missing workflow marker: ${marker}`);
}

export function auditWorkflowText(source: string): void {
  if (!/^\s*push:\s*\r?\n\s+tags:\s*$/mu.test(source)) fail('release workflow must use a tag-only automatic trigger');
  if (/^\s*pull_request:\s*$/mu.test(source)) fail('release workflow must not run automatically on pull request');

  for (const marker of [
    'push:',
    'tags:',
    "'[0-9]+.[0-9]+.[0-9]+'",
    'workflow_dispatch:',
    'architecture_mode:',
    'publish:',
    'linux/amd64',
    'linux/arm64',
    'docker/build-push-action@v6',
    'sbom: true',
    'anchore/sbom-action@v0.24.0',
    'format: spdx-json',
    'actions/attest@v4',
    'sbom-path:',
    'actions/attest-build-provenance@v4',
    'subject-digest:',
    'push-to-registry: true',
    'packages: write',
    'id-token: write',
    'attestations: write',
    'contents: write',
    "inputs.architecture_mode != 'multiarch'",
    'Registry publication is reserved for the final linux/amd64 + linux/arm64 target.',
    'gh attestation verify',
    '--predicate-type https://spdx.dev/Document/v2.3',
    "github.event_name == 'push'",
    "github.ref_type == 'tag'",
    "jq -r '.version' package.json",
    'must exactly match package.json version',
    'gh release create',
    'gh release upload',
    '--verify-tag',
    "github.ref == 'refs/heads/main'",
  ]) requireText(source, marker);

  if (/--sbom=false/mu.test(source)) fail('release workflow disables SBOM generation');
  if (/secrets\.(?!GITHUB_TOKEN\b)[A-Z0-9_]+/u.test(source)) fail('release workflow references an unapproved secret');
}

export function auditSbomDocument(document: unknown): void {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) fail('SBOM is not a JSON object');
  const data = document as JsonRecord;
  if (typeof data.spdxVersion !== 'string' || !/^SPDX-2\.[23]$/u.test(data.spdxVersion)) fail('SBOM is not SPDX 2.2 or 2.3');
  if (typeof data.SPDXID !== 'string' || data.SPDXID.length === 0) fail('SBOM has no document SPDX identifier');
  if (typeof data.documentNamespace !== 'string' || !/^https?:\/\//u.test(data.documentNamespace)) fail('SBOM namespace is missing or unsafe');
  if (!Array.isArray(data.creationInfo) && (data.creationInfo === undefined || data.creationInfo === null)) fail('SBOM creation metadata is missing');
  if (!Array.isArray(data.packages)) fail('SBOM package list is missing');
  const serialized = JSON.stringify(data);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|password\s*[:=]|secret\s*[:=]/iu.test(serialized)) fail('SBOM contains a credential-like value');
  if (serialized.includes('C:\\\\Users\\\\') || serialized.includes('/home/runner/')) fail('SBOM contains a workstation path');
}

const sbomArgumentIndex = process.argv.indexOf('--sbom');
if (sbomArgumentIndex >= 0) {
  const sbomPath = process.argv[sbomArgumentIndex + 1];
  if (!sbomPath) fail('--sbom requires a file path');
  auditSbomDocument(JSON.parse(await readFile(resolve(sbomPath), 'utf8')));
  console.log(JSON.stringify({ subject: resolve(sbomPath), format: 'spdx-json', status: 'pass' }));
} else {
  auditWorkflowText(await readFile(workflowPath, 'utf8'));
  console.log(JSON.stringify({ workflow: '.github/workflows/container-release.yml', status: 'pass' }));
}
