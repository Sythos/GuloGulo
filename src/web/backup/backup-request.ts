// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { randomUUID } from 'node:crypto';

export const RESOURCE_TYPES = new Set<BackupResource>(['calendar', 'contacts', 'mail', 'preferences']);
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type BackupResource = 'calendar' | 'contacts' | 'mail' | 'preferences';

export interface BackupSession { tenantId: string; userId: string; role?: string }
export interface UserBackupRequestOptions {
  session?: BackupSession | null;
  requestedUserId?: string;
  resources?: readonly BackupResource[];
  idempotencyKey?: string;
  requestedAt?: Date | string | number;
}

export class BackupRequestError extends Error {
  readonly code: string;
  constructor(message: string, code = 'BACKUP_REQUEST_ERROR') {
    super(`Backup request error: ${message}`);
    this.name = 'BackupRequestError';
    this.code = code;
  }
}

function backupError(message: string, code = 'BACKUP_REQUEST_ERROR'): BackupRequestError { return new BackupRequestError(message, code); }

function assertUserId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) throw backupError(`${field} is invalid`, 'INVALID_IDENTITY');
  return value;
}

function assertSession(session: unknown): Readonly<Required<BackupSession>> {
  if (session === null || typeof session !== 'object') throw backupError('an authenticated session is required', 'SESSION_INVALID');
  const candidate = session as Partial<BackupSession>;
  return Object.freeze({ tenantId: assertUserId(candidate.tenantId, 'tenantId'), userId: assertUserId(candidate.userId, 'userId'), role: typeof candidate.role === 'string' ? candidate.role : 'user' });
}

export function createUserBackupRequest(options: UserBackupRequestOptions = {}) {
  const session = options.session;
  const identity = assertSession(session);
  const targetUserId = assertUserId(options.requestedUserId ?? identity.userId, 'requestedUserId');
  const resources = options.resources ?? ['mail', 'calendar', 'contacts', 'preferences'];
  const idempotencyKey = options.idempotencyKey ?? randomUUID();
  const requestedAt = options.requestedAt ?? new Date();
  if (targetUserId !== identity.userId) throw backupError('a user backup can target only the authenticated user', 'USER_SCOPE_DENIED');
  if (!Array.isArray(resources) || resources.length === 0 || resources.some((item) => !RESOURCE_TYPES.has(item))) throw backupError('resources must be a non-empty supported list', 'INVALID_RESOURCES');
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw backupError('idempotencyKey is invalid', 'INVALID_IDEMPOTENCY_KEY');
  const date = requestedAt instanceof Date ? new Date(requestedAt.getTime()) : new Date(requestedAt);
  if (Number.isNaN(date.getTime())) throw backupError('requestedAt is invalid', 'INVALID_TIMESTAMP');
  return Object.freeze({
    schemaVersion: 1 as const, operation: 'user_backup_request' as const, mode: 'user-self-service' as const,
    tenantId: identity.tenantId, userId: identity.userId,
    resources: Object.freeze([...new Set(resources)]), idempotencyKey, requestedAt: date.toISOString(),
  });
}

export { backupError };
