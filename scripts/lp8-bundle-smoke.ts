#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { auditBundle, safeRepositoryPath } from './lp8-evidence-audit.ts';

const root = process.cwd();
const bundlePath = process.argv[2] ?? 'release/lp8-local-proof-bundle.json';
const summary = await auditBundle(root, bundlePath);
const bundle = JSON.parse(await readFile(resolve(root, safeRepositoryPath(bundlePath, 'bundlePath')), 'utf8')) as {
  manifests: Array<{ path: string }>;
  fixtures: Array<{ path: string }>;
  protocolEvidence: Array<{ path: string }>;
  operationsEvidence: Array<{ path: string }>;
  apiMcpExamples: Array<{ path: string }>;
  backupRestore: Array<{ path: string }>;
  migration: Array<{ path: string }>;
};

const paths = [
  ...bundle.manifests,
  ...bundle.fixtures,
  ...bundle.protocolEvidence,
  ...bundle.operationsEvidence,
  ...bundle.apiMcpExamples,
  ...bundle.backupRestore,
  ...bundle.migration,
].map((entry) => safeRepositoryPath(entry.path, 'bundle reference'));

const checksums = [] as Array<{ path: string; sha256: string; bytes: number }>;
for (const path of new Set(paths)) {
  const content = await readFile(resolve(root, path));
  checksums.push({
    path,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  });
}

process.stdout.write(`${JSON.stringify({
  ...summary,
  checksumAlgorithm: 'sha256',
  checksums,
}, null, 2)}\n`);
