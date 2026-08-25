// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PATCH_STATUS_SCHEMA_VERSION,
  parsePatchStatus,
  sanitizePatchStatus,
} from './status.ts';

test('sanitizes an allowlisted read-only patch DTO', () => {
  const status = sanitizePatchStatus({
    schemaVersion: PATCH_STATUS_SCHEMA_VERSION,
    state: 'updates_available',
    checkedAt: '2026-08-25T12:00:00Z',
    baseImage: 'ubuntu:26.04',
    nodeVersion: '26.7.0',
    aptOutput: 'password=never-expose-this',
    token: 'never-expose-this',
    reason: 'apt_apply_failed',
  });

  assert.deepEqual(status, {
    schemaVersion: 1,
    state: 'updates_available',
    checkedAt: '2026-08-25T12:00:00Z',
    baseImage: 'ubuntu:26.04',
    nodeVersion: '26.7.0',
  });
  assert.equal(Object.isFrozen(status), true);
  assert.equal(JSON.stringify(status).includes('never-expose-this'), false);
});

test('represents an absent or corrupt patch status as fail-closed unknown state', () => {
  assert.deepEqual(parsePatchStatus(undefined), {
    schemaVersion: 1,
    state: 'unknown',
    reason: 'status_unavailable',
  });
  assert.deepEqual(parsePatchStatus('{not json'), {
    schemaVersion: 1,
    state: 'unknown',
    reason: 'invalid_status',
  });
  assert.deepEqual(sanitizePatchStatus({ schemaVersion: 2, state: 'current' }), {
    schemaVersion: 1,
    state: 'unknown',
    reason: 'invalid_status',
  });
});

test('retains recognized patch failures without carrying arbitrary error text', () => {
  const failed = parsePatchStatus(JSON.stringify({
    schemaVersion: 1,
    state: 'failed',
    checkedAt: '2026-08-25T12:00:00.000Z',
    reason: 'apt_apply_failed',
    stderr: 'apt failed while reading password=super-secret',
  }));
  assert.deepEqual(failed, {
    schemaVersion: 1,
    state: 'failed',
    checkedAt: '2026-08-25T12:00:00.000Z',
    reason: 'apt_apply_failed',
  });

  const unrecognizedReason = sanitizePatchStatus({
    schemaVersion: 1,
    state: 'failed',
    reason: 'repository password is exposed',
  });
  assert.deepEqual(unrecognizedReason, {
    schemaVersion: 1,
    state: 'failed',
    reason: 'patch_failed',
  });
});
