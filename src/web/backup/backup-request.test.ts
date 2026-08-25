// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { BackupRequestError, createUserBackupRequest } from './backup-request.ts';

const session = Object.freeze({ tenantId: 'acme', userId: 'alice', role: 'user' });
const hasCode = (code: string) => (error: unknown) => error instanceof BackupRequestError && error.code === code;

test('user backup hook is metadata-only, immutable, and self-scoped', () => {
  const request = createUserBackupRequest({ session, resources: ['mail', 'calendar', 'mail'], idempotencyKey: 'backup-2026-08-22-001', requestedAt: '2026-08-22T18:00:00Z' });
  assert.deepEqual(request.resources, ['mail', 'calendar']);
  assert.equal(request.tenantId, 'acme');
  assert.equal(request.userId, 'alice');
  assert.equal(Object.hasOwn(request, 'content'), false);
  assert.equal(Object.hasOwn(request, 'sessionId'), false);
});

test('user backup hook rejects missing sessions, cross-user scope, and malformed input', () => {
  assert.throws(() => createUserBackupRequest(), hasCode('SESSION_INVALID'));
  assert.throws(() => createUserBackupRequest({ session, requestedUserId: 'bob' }), hasCode('USER_SCOPE_DENIED'));
  assert.throws(() => createUserBackupRequest({ session, resources: ['mail', 'unknown' as never] }), hasCode('INVALID_RESOURCES'));
  assert.throws(() => createUserBackupRequest({ session, idempotencyKey: 'with spaces' }), hasCode('INVALID_IDEMPOTENCY_KEY'));
});
