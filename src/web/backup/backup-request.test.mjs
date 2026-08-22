// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import { createUserBackupRequest } from './backup-request.mjs';

const session = Object.freeze({ tenantId: 'acme', userId: 'alice', role: 'user' });

test('user backup hook is metadata-only and self-scoped', () => {
  const request = createUserBackupRequest({
    session,
    resources: ['mail', 'calendar', 'mail'],
    idempotencyKey: 'backup-2026-08-22-001',
    requestedAt: '2026-08-22T18:00:00Z',
  });

  assert.deepEqual(request, {
    schemaVersion: 1,
    operation: 'user_backup_request',
    mode: 'user-self-service',
    tenantId: 'acme',
    userId: 'alice',
    resources: ['mail', 'calendar'],
    idempotencyKey: 'backup-2026-08-22-001',
    requestedAt: '2026-08-22T18:00:00.000Z',
  });
  assert.equal(Object.hasOwn(request, 'content'), false);
  assert.equal(Object.hasOwn(request, 'sessionId'), false);
});

test('user backup hook rejects cross-user and malformed requests', () => {
  assert.throws(
    () => createUserBackupRequest({ session, requestedUserId: 'bob' }),
    (error) => error.code === 'USER_SCOPE_DENIED',
  );
  assert.throws(
    () => createUserBackupRequest({ session, resources: ['mail', 'unknown'] }),
    (error) => error.code === 'INVALID_RESOURCES',
  );
  assert.throws(
    () => createUserBackupRequest({ session, idempotencyKey: 'with spaces' }),
    (error) => error.code === 'INVALID_IDEMPOTENCY_KEY',
  );
});
