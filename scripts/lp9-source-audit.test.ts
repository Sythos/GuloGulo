// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { auditSource, canonicalPathForBridge, validateBridgeText } from './lp9-source-audit.ts';

test('LP9 source audit finds only documented behavior-free JavaScript bridges', async () => {
  const summary = await auditSource(process.cwd());
  assert.equal(summary.milestone, 'LP9');
  assert.equal(summary.status, 'passed');
  assert.equal(summary.executableJavaScriptSources, 0);
  assert.equal(summary.bridgeSources, summary.bridgePaths.length);
  assert.ok(summary.typescriptSources > 100);
  assert.ok(summary.bridgeSources > 50);
});

test('LP9 maps every bridge to its TypeScript canonical', () => {
  assert.equal(canonicalPathForBridge('web/build.mjs'), 'web/build.ts');
  assert.equal(canonicalPathForBridge('src/runtime/index.mjs'), 'src/runtime/index.ts');
});

test('LP9 rejects bridge code that carries product behavior', () => {
  assert.throws(
    () => validateBridgeText(`// ${'SPDX-License-Identifier: MIT'}\n// Author: Sythos (https://www.sythos.net)\n// compatibility bridge\nconst unsafe = true;`, 'unsafe.mjs'),
    /LP9_BRIDGE_NOT_THIN/,
  );
});
