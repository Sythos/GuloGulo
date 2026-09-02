// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { assertTenantContext } from '../../integrations/tenant-context.ts';

const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const USER_ID_PATTERN = ACTOR_ID_PATTERN;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,3}$/u;
const CONTENT_RESOURCES = new Set([
  'mail',
  'mailbox',
  'message',
  'calendar',
  'contacts',
  'dav',
  'user_session',
]);
const CONTENT_PERMISSIONS = new Set(['content.read', 'content.write']);

export const ADMIN_ROLES = Object.freeze(['provider', 'tenant_master', 'user', 'monitor']);

export const ADMIN_PERMISSIONS = Object.freeze({
  TENANT_READ: 'tenant.read',
  TENANT_MANAGE: 'tenant.manage',
  POLICY_READ: 'policy.read',
  POLICY_MANAGE: 'policy.manage',
  USER_READ: 'user.read',
  USER_MANAGE: 'user.manage',
  USER_READ_SELF: 'user.read.self',
  USER_UPDATE_SELF: 'user.update.self',
  ALIAS_READ: 'alias.read',
  ALIAS_MANAGE: 'alias.manage',
  QUOTA_READ: 'quota.read',
  QUOTA_MANAGE: 'quota.manage',
  DELEGATION_READ: 'delegation.read',
  DELEGATION_MANAGE: 'delegation.manage',
  DELEGATION_MANAGE_SELF: 'delegation.manage.self',
  QUEUE_READ: 'queue.read',
  QUEUE_ACTION: 'queue.action',
  SERVICE_READ: 'service.read',
  METRICS_READ: 'metrics.read',
  AUDIT_READ: 'audit.read',
  AUDIT_READ_SELF: 'audit.read.self',
  LOG_READ: 'log.read',
  CONTENT_READ: 'content.read',
  CONTENT_WRITE: 'content.write',
  SESSION_READ: 'session.read',
  SESSION_REVOKE: 'session.revoke',
  MFA_MANAGE_SELF: 'mfa.manage.self',
  MFA_RESET_USER: 'mfa.reset.user',
  RECOVERY_MANAGE_SELF: 'recovery.manage.self',
  RECOVERY_RESET_USER: 'recovery.reset.user',
  BACKUP_REQUEST_SELF: 'backup.request.self',
});

const PROVIDER_PERMISSIONS = [
  'tenant.read',
  'tenant.manage',
  'policy.read',
  'policy.manage',
  'user.read',
  'user.manage',
  'alias.read',
  'alias.manage',
  'quota.read',
  'quota.manage',
  'delegation.read',
  'delegation.manage',
  'queue.read',
  'queue.action',
  'service.read',
  'metrics.read',
  'audit.read',
  'log.read',
  'mfa.reset.user',
  'recovery.reset.user',
];

const MASTER_PERMISSIONS = [
  'tenant.read',
  'policy.read',
  'policy.manage',
  'user.read',
  'user.manage',
  'alias.read',
  'alias.manage',
  'quota.read',
  'quota.manage',
  'delegation.read',
  'delegation.manage',
  'queue.read',
  'service.read',
  'metrics.read',
  'audit.read',
  'log.read',
  'mfa.reset.user',
  'recovery.reset.user',
];

const USER_PERMISSIONS = [
  'user.read.self',
  'user.update.self',
  'quota.read',
  'content.read',
  'content.write',
  'session.read',
  'session.revoke',
  'mfa.manage.self',
  'recovery.manage.self',
  'backup.request.self',
  'delegation.manage.self',
  'audit.read.self',
];

const MONITOR_PERMISSIONS = [
  'tenant.read',
  'quota.read',
  'queue.read',
  'service.read',
  'metrics.read',
  'audit.read',
];

export const PERMISSION_MATRIX = Object.freeze({
  provider: Object.freeze([...PROVIDER_PERMISSIONS]),
  tenant_master: Object.freeze([...MASTER_PERMISSIONS]),
  user: Object.freeze([...USER_PERMISSIONS]),
  monitor: Object.freeze([...MONITOR_PERMISSIONS]),
});

function authorizationError(message, code = 'FORBIDDEN', status = 403) {
  const error = new Error(`Authorization error: ${message}`);
  error.name = 'AdminAuthorizationError';
  error.code = code;
  error.status = status;
  return error;
}

function assertSafeActorId(value, field = 'actorId') {
  if (typeof value !== 'string' || !ACTOR_ID_PATTERN.test(value)) {
    throw authorizationError(`${field} is invalid`, 'INVALID_ACTOR', 400);
  }
  return value;
}

function assertSafeUserId(value, field = 'userId') {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    throw authorizationError(`${field} is invalid`, 'INVALID_USER', 400);
  }
  return value;
}

function normalizeActor(actor) {
  if (actor !== null && typeof actor === 'object' && actor.role !== undefined && !ADMIN_ROLES.includes(actor.role)) {
    throw authorizationError('role is not supported', 'ROLE_DENIED');
  }
  let context;
  try {
    context = assertTenantContext(actor);
  } catch {
    throw authorizationError('authenticated tenant context is required', 'AUTHENTICATION_REQUIRED', 401);
  }

  if (!ADMIN_ROLES.includes(context.role)) {
    throw authorizationError('role is not supported', 'ROLE_DENIED');
  }

  const actorId = context.actorId ?? actor?.userId;
  assertSafeActorId(actorId);
  const userId = context.role === 'user' ? (actor?.userId ?? actorId) : null;
  if (context.role === 'user') {
    assertSafeUserId(userId);
    if (userId !== actorId) throw authorizationError('actor and user scope do not match', 'ACTOR_SCOPE_MISMATCH');
  }

  return Object.freeze({
    tenantId: context.tenantId,
    domain: context.domain,
    actorId,
    userId,
    role: context.role,
  });
}

function assertPermission(permission) {
  if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission)) {
    throw authorizationError('permission is invalid', 'INVALID_PERMISSION', 400);
  }
  return permission;
}

function targetMatchesActor(actor, targetUserId) {
  return targetUserId === null || targetUserId === undefined || targetUserId === actor.userId;
}

function isContentRequest(permission, resource, content = false) {
  return Boolean(content)
    || CONTENT_PERMISSIONS.has(permission)
    || (typeof resource === 'string' && CONTENT_RESOURCES.has(resource));
}

function canDelegateContent(actor, targetUserId, permission, delegationStore) {
  if (actor.role !== 'user' || !delegationStore || !CONTENT_PERMISSIONS.has(permission)) return false;
  const delegatePermission = permission === 'content.write' ? 'write' : 'read';
  try {
    return delegationStore.canAccess(actor, targetUserId, delegatePermission) === true;
  } catch {
    return false;
  }
}

/**
 * Normalize a server-side actor context before evaluating any administrative
 * operation. The browser, API, or MCP caller must not be allowed to invent a
 * role or a tenant context.
 */
export function assertAdminActor(actor) {
  return normalizeActor(actor);
}

/**
 * Authorize one operation against an explicit tenant and optional user scope.
 * A successful result is an immutable decision envelope suitable for passing
 * to an adapter. A failure never returns a partial decision.
 */
export function authorize(actor, {
  permission,
  targetTenantId = actor?.tenantId,
  targetUserId = null,
  resource = null,
  content = false,
  delegationStore = null,
  policy = {},
  policyField = null,
} = {}) {
  const canonical = normalizeActor(actor);
  const requestedPermission = assertPermission(permission);
  const requestedUserId = targetUserId === null || targetUserId === undefined
    ? null
    : assertSafeUserId(targetUserId, 'targetUserId');

  if (typeof targetTenantId !== 'string' || targetTenantId !== canonical.tenantId) {
    throw authorizationError('cross-tenant access denied', 'CROSS_TENANT_DENIED');
  }

  const requestsContent = isContentRequest(requestedPermission, resource, content);
  if (requestsContent && canonical.role !== 'user') {
    throw authorizationError('administrative roles cannot access user content', 'CONTENT_ACCESS_DENIED');
  }

  const matrix = PERMISSION_MATRIX[canonical.role];
  if (!matrix.includes(requestedPermission)) {
    throw authorizationError('permission is not granted to this role', 'PERMISSION_DENIED');
  }

  if (canonical.role === 'user') {
    const target = requestedUserId ?? canonical.userId;
    if (!targetMatchesActor(canonical, target)) {
      if (!canDelegateContent(canonical, target, requestedPermission, delegationStore)) {
        throw authorizationError('user scope is not authorized', 'USER_SCOPE_DENIED');
      }
    }

    if (!requestsContent && requestedUserId !== null && !targetMatchesActor(canonical, requestedUserId)) {
      throw authorizationError('user administration scope is not authorized', 'USER_SCOPE_DENIED');
    }
  }

  if (canonical.role === 'tenant_master'
    && (requestedPermission === 'audit.read' || requestedPermission === 'log.read')
    && policy?.masterLogAccess !== true) {
    throw authorizationError('master log visibility is disabled by tenant policy', 'MASTER_LOG_ACCESS_DISABLED');
  }

  if (canonical.role === 'tenant_master'
    && (policyField === 'masterLogAccess' || policyField === 'grossQuotaBytes')) {
    throw authorizationError('this tenant policy field is provider-controlled', 'POLICY_FIELD_DENIED');
  }

  return Object.freeze({
    allowed: true,
    tenantId: canonical.tenantId,
    actorId: canonical.actorId,
    actorRole: canonical.role,
    targetUserId: requestedUserId ?? canonical.userId,
    permission: requestedPermission,
    resource,
    content: requestsContent,
    policyField,
  });
}

export function canAuthorize(actor, request = {}) {
  try {
    authorize(actor, request);
    return true;
  } catch {
    return false;
  }
}

export function isContentResource(resource) {
  return typeof resource === 'string' && CONTENT_RESOURCES.has(resource);
}

export { authorizationError, assertSafeUserId, assertSafeActorId, normalizeActor };
