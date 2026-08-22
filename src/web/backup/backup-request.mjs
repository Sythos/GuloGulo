// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';

const RESOURCE_TYPES = new Set(['calendar', 'contacts', 'mail', 'preferences']);
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function backupError(message, code = 'BACKUP_REQUEST_ERROR') {
  const error = new Error(`Backup request error: ${message}`);
  error.code = code;
  return error;
}

function assertUserId(value, field) {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    throw backupError(`${field} is invalid`, 'INVALID_IDENTITY');
  }
  return value;
}

function assertSession(session) {
  if (session === null || typeof session !== 'object') {
    throw backupError('an authenticated session is required', 'SESSION_INVALID');
  }
  return Object.freeze({
    tenantId: assertUserId(session.tenantId, 'tenantId'),
    userId: assertUserId(session.userId, 'userId'),
    role: typeof session.role === 'string' ? session.role : 'user',
  });
}

/**
 * Build a metadata-only user backup request.
 *
 * This hook deliberately does not read mailbox/DAV data or start a provider
 * job. A later backup worker can consume the returned immutable envelope while
 * preserving the user/session binding and an idempotency key.
 */
export function createUserBackupRequest({
  session,
  requestedUserId = session?.userId,
  resources = ['mail', 'calendar', 'contacts', 'preferences'],
  idempotencyKey = randomUUID(),
  requestedAt = new Date(),
} = {}) {
  const identity = assertSession(session);
  const targetUserId = assertUserId(requestedUserId, 'requestedUserId');
  if (targetUserId !== identity.userId) {
    throw backupError('a user backup can target only the authenticated user', 'USER_SCOPE_DENIED');
  }
  if (!Array.isArray(resources) || resources.length === 0 || resources.some((item) => !RESOURCE_TYPES.has(item))) {
    throw backupError('resources must be a non-empty supported list', 'INVALID_RESOURCES');
  }
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw backupError('idempotencyKey is invalid', 'INVALID_IDEMPOTENCY_KEY');
  }
  const date = requestedAt instanceof Date ? new Date(requestedAt.getTime()) : new Date(requestedAt);
  if (Number.isNaN(date.getTime())) throw backupError('requestedAt is invalid', 'INVALID_TIMESTAMP');
  return Object.freeze({
    schemaVersion: 1,
    operation: 'user_backup_request',
    mode: 'user-self-service',
    tenantId: identity.tenantId,
    userId: identity.userId,
    resources: Object.freeze([...new Set(resources)]),
    idempotencyKey,
    requestedAt: date.toISOString(),
  });
}

export { backupError, RESOURCE_TYPES };
