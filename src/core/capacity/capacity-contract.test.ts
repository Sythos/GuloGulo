// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { AMD64_LOCAL_PROOF_BUDGET, evaluateCapacity, percentile } from './capacity-contract.ts';

function passingMeasurement() {
  return {
    platform: 'linux/amd64' as const,
    startupMs: 1,
    readinessMs: 1,
    webP95Ms: 1,
    davP95Ms: 1,
    queueP95Ms: 1,
    idleNotifyP95Ms: 1,
    httpErrorRate: 0,
    activeIdleConnections: 8,
    memoryMiB: 1,
    cpuMillis: 1,
    pids: 1,
  };
}

test('percentile is deterministic and uses the documented nearest-rank calculation', () => {
  assert.equal(percentile([40, 10, 30, 20], 50), 20);
  assert.equal(percentile([40, 10, 30, 20], 95), 40);
  assert.throws(() => percentile([], 95), /samples/);
});

test('capacity report passes only when every explicit AMD64 local-proof budget is met', () => {
  const report = evaluateCapacity(passingMeasurement());
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.budget, AMD64_LOCAL_PROOF_BUDGET);
});

test('capacity report treats IDLE as a minimum and resource measurements as maxima', () => {
  const report = evaluateCapacity({ ...passingMeasurement(), activeIdleConnections: 7, memoryMiB: 769 });
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.violations, [
    { metric: 'activeIdleConnections', actual: 7, expected: 8, comparison: 'minimum' },
    { metric: 'memoryMiB', actual: 769, expected: 768, comparison: 'maximum' },
  ]);
});

test('capacity report rejects incomplete or malformed measurements', () => {
  const incomplete = passingMeasurement();
  delete (incomplete as Partial<typeof incomplete>).pids;
  assert.throws(() => evaluateCapacity(incomplete), /pids is required/);
  assert.throws(() => evaluateCapacity({ ...passingMeasurement(), platform: 'darwin/arm64' } as never), /platform/);
});
