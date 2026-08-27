// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { auditBundle, safeRepositoryPath, validateBundle } from './lp8-evidence-audit.ts';

const root = process.cwd();

test('LP8 evidence bundle passes the portable audit', async () => {
  const summary = await auditBundle(root);
  assert.equal(summary.milestone, 'LP8');
  assert.equal(summary.status, 'ready_for_lp9');
  assert.equal(summary.exactDigests, 1);
  assert.ok(summary.filesChecked > 30);
  assert.ok(summary.bridgesChecked > 10);
});

test('LP8 rejects absolute and traversal paths', () => {
  assert.throws(() => safeRepositoryPath('C:/Users/example/secret.json', 'path'), /LP8_UNSAFE_PATH/);
  assert.throws(() => safeRepositoryPath('../outside.json', 'path'), /LP8_UNSAFE_PATH/);
});

test('LP8 rejects a bundle that claims an unpublished registry digest', async () => {
  const bundle = JSON.parse(await readFile('release/lp8-local-proof-bundle.json', 'utf8')) as Record<string, unknown>;
  const imageDigests = (bundle.imageDigests as Array<Record<string, unknown>>).map((entry) => ({ ...entry }));
  imageDigests[1].digest = 'sha256:' + 'a'.repeat(64);
  assert.throws(() => validateBundle({ ...bundle, imageDigests }, root), /LP8_DIGEST_CLAIM_INVALID/);
});
