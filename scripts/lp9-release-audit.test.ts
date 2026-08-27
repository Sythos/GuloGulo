// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { auditReleaseManifest, validateReleaseManifest } from './lp9-release-audit.ts';

test('LP9 local release manifest passes source and boundary validation', async () => {
  const summary = await auditReleaseManifest(process.cwd());
  assert.equal(summary.milestone, 'LP9');
  assert.ok(['ready_for_owner_review', 'complete'].includes(summary.status));
  assert.equal(summary.source.executableJavaScriptSources, 0);
  assert.equal(summary.source.bridgeSources, summary.source.bridgePaths.length);
  assert.ok(summary.ciRuns.length >= 1);
  assert.ok(summary.deferredEvidence >= 3);
});

test('LP9 release manifest rejects a production-looking status', async () => {
  const manifest = JSON.parse(await readFile('release/lp9-local-proof.json', 'utf8')) as Record<string, unknown>;
  assert.throws(() => validateReleaseManifest({ ...manifest, status: 'production_ready' }), /LP9_RELEASE_STATUS_INVALID/);
});
