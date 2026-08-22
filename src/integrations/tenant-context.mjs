// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ROLES = new Set(['provider', 'tenant_master', 'user', 'monitor']);

function contextError(message) {
  return new Error(`Tenant context error: ${message}`);
}

function requiredString(value, name, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw contextError(`${name} is invalid`);
  }
  return value;
}

export function createTenantContext({ tenantId, domain, actorId = null, role = 'user' } = {}) {
  const canonicalDomain = requiredString(domain, 'domain', DOMAIN_PATTERN).toLowerCase();
  const context = {
    tenantId: requiredString(tenantId, 'tenantId', TENANT_ID_PATTERN),
    domain: canonicalDomain,
    actorId: actorId === null ? null : requiredString(actorId, 'actorId', ACTOR_ID_PATTERN),
    role: ROLES.has(role) ? role : (() => { throw contextError('role is invalid'); })(),
  };
  return Object.freeze(context);
}

export function assertTenantContext(context) {
  if (context === null || typeof context !== 'object' || context.tenantId === undefined) {
    throw contextError('a tenant context is required');
  }

  const canonical = createTenantContext(context);
  if (canonical.domain !== context.domain || canonical.role !== context.role || canonical.actorId !== context.actorId) {
    throw contextError('tenant context is not canonical');
  }
  return canonical;
}

export function assertTenantAccess(context, requestedTenantId) {
  const canonical = assertTenantContext(context);
  if (requestedTenantId !== canonical.tenantId) {
    throw contextError('cross-tenant access denied');
  }
  return canonical;
}

export function tenantScope(context) {
  const canonical = assertTenantContext(context);
  return Object.freeze({ tenantId: canonical.tenantId });
}

export const tenantContextPatterns = Object.freeze({
  tenantId: TENANT_ID_PATTERN,
  domain: DOMAIN_PATTERN,
  actorId: ACTOR_ID_PATTERN,
});
