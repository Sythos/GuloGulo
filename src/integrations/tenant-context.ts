// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import type { TenantContext, TenantContextInput, TenantRole } from './types.ts';

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const ROLES: ReadonlySet<TenantRole> = new Set<TenantRole>(['provider', 'tenant_master', 'user', 'monitor']);

function contextError(message: string): Error {
  return new Error(`Tenant context error: ${message}`);
}

function requiredString(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw contextError(`${name} is invalid`);
  }
  return value;
}

function asInput(context: unknown): TenantContextInput {
  if (context === null || typeof context !== 'object') {
    throw contextError('a tenant context is required');
  }
  return context;
}

export function createTenantContext({ tenantId, domain, actorId = null, role = 'user' }: TenantContextInput = {}): TenantContext {
  const canonicalDomain = requiredString(domain, 'domain', DOMAIN_PATTERN).toLowerCase();
  if (typeof role !== 'string' || !ROLES.has(role as TenantRole)) {
    throw contextError('role is invalid');
  }
  const context: TenantContext = {
    tenantId: requiredString(tenantId, 'tenantId', TENANT_ID_PATTERN),
    domain: canonicalDomain,
    actorId: actorId === null ? null : requiredString(actorId, 'actorId', ACTOR_ID_PATTERN),
    role: role as TenantRole,
  };
  return Object.freeze(context);
}

export function assertTenantContext(context: unknown): TenantContext {
  const input = asInput(context);
  if (input.tenantId === undefined) {
    throw contextError('a tenant context is required');
  }

  const canonical = createTenantContext(input);
  if (canonical.domain !== input.domain || canonical.role !== input.role || canonical.actorId !== input.actorId) {
    throw contextError('tenant context is not canonical');
  }
  return canonical;
}

export function assertTenantAccess(context: unknown, requestedTenantId: unknown): TenantContext {
  const canonical = assertTenantContext(context);
  if (requestedTenantId !== canonical.tenantId) {
    throw contextError('cross-tenant access denied');
  }
  return canonical;
}

export function tenantScope(context: unknown): Readonly<{ tenantId: string }> {
  const canonical = assertTenantContext(context);
  return Object.freeze({ tenantId: canonical.tenantId });
}

export const tenantContextPatterns = Object.freeze({
  tenantId: TENANT_ID_PATTERN,
  domain: DOMAIN_PATTERN,
  actorId: ACTOR_ID_PATTERN,
});
