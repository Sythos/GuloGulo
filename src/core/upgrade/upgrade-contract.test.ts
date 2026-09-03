// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPATIBILITY_WINDOWS,
  MIGRATION_PHASES,
  createMigrationCheckpoint,
  createSchemaMigrationPlan,
  evaluateCompatibility,
} from './index.ts';

const SOURCE_DIGEST = `sha256:${'1'.repeat(64)}`;
const TARGET_DIGEST = `sha256:${'2'.repeat(64)}`;

test('migration compatibility follows expand, backfill, switch, contract', () => {
  const plan = createSchemaMigrationPlan({ sourceVersion: '1.2.0', targetVersion: '1.3.0' });
  assert.deepEqual(plan.phases, MIGRATION_PHASES);
  assert.equal(plan.compatibilityWindow, COMPATIBILITY_WINDOWS[0]);
  assert.equal(plan.rollbackSafe, true);
  assert.throws(
    () => createSchemaMigrationPlan({ sourceVersion: '1.2.0', targetVersion: '1.3.0', phases: ['expand', 'switch', 'backfill', 'contract'] }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_MIGRATION_PHASES',
  );
  assert.throws(
    () => createSchemaMigrationPlan({ sourceVersion: '1.2.0', targetVersion: '1.3.0', destructiveChanges: true }),
    (error: unknown) => (error as { code?: string }).code === 'DESTRUCTIVE_MIGRATION_FORBIDDEN',
  );
});

test('checkpoints require forward compatibility and are auditable', () => {
  const checkpoint = createMigrationCheckpoint({
    operationId: 'upgrade-000001',
    phase: 'backfill',
    completedAt: '2026-08-23T00:00:00.000Z',
    processedItems: 100,
    remainingItems: 20,
    forwardCompatible: true,
  });
  assert.equal(checkpoint.forwardCompatible, true);
  assert.throws(
    () => createMigrationCheckpoint({ ...checkpoint, forwardCompatible: false }),
    (error: unknown) => (error as { code?: string }).code === 'INCOMPATIBLE_CHECKPOINT',
  );
  const compatibility = evaluateCompatibility({
    sourceVersion: '0.0.0',
    sourceDigest: SOURCE_DIGEST,
    targetVersion: '0.1.0',
    targetDigest: TARGET_DIGEST,
  });
  assert.equal(compatibility.rollbackKeepsSourceReadable, true);
  assert.equal(compatibility.contractDeferredUntilFinalize, true);
});
