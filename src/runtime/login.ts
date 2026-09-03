// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createCpanelAdapter } from '../platform/cpanel/cpanel-adapter.ts';
import { createPleskAdapter } from '../platform/plesk/plesk-adapter.ts';
import { createStandaloneAdapter } from '../platform/standalone/standalone-adapter.ts';
import { createTenantContext } from '../integrations/tenant-context.ts';
import type { IntegrationConfig, IntegrationLogger, LdapIdentityClient, SecretResolver, TenantContext, TenantIdentity } from '../integrations/types.ts';
import type { PlatformAdapter } from '../platform/contract/platform-adapter.ts';
import type { SessionIdentity } from '../web/security/session-manager.ts';

/** The three ADR-002 packaging targets, selected at runtime via `GULOGULO_PLATFORM`. */
export type PlatformTarget = 'standalone' | 'cpanel' | 'plesk';

export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
  readonly rememberMe?: boolean;
}

export type ProvisionedLoginAuthenticator = (credentials: LoginCredentials) => Promise<SessionIdentity | null>;

const PLATFORM_TARGETS: ReadonlySet<PlatformTarget> = new Set(['standalone', 'cpanel', 'plesk']);
const PLATFORM_TARGET_ENVIRONMENT_VARIABLE = 'GULOGULO_PLATFORM';
const SECRET_ENVIRONMENT_PREFIX = 'GULOGULO_SECRET_';

function errorDetails(error: unknown): { name: string; code: string } {
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: typeof record.code === 'string' ? record.code : 'unknown',
  };
}

/**
 * Resolves the ADR-002 packaging target Gulo Gulo is running as, so
 * production code (this module) can pick the matching `PlatformAdapter`
 * instead of always defaulting to `standalone`. No such runtime selection
 * mechanism existed before this module: the three `create*Adapter()`
 * factories in `src/platform/` were previously only ever called directly by
 * tests and by each other's packaging pipeline, never by the running server.
 */
export function resolvePlatformTarget(environment: NodeJS.ProcessEnv = process.env): PlatformTarget {
  const raw = environment[PLATFORM_TARGET_ENVIRONMENT_VARIABLE];
  return typeof raw === 'string' && PLATFORM_TARGETS.has(raw as PlatformTarget) ? (raw as PlatformTarget) : 'standalone';
}

interface AdapterFactoryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
}

/** Builds the `PlatformAdapter` for a given target — the same three factories `src/platform/{standalone,cpanel,plesk}/*-adapter.ts` already export. */
export function createPlatformAdapterForTarget(target: PlatformTarget, options: AdapterFactoryOptions = {}): PlatformAdapter {
  if (target === 'cpanel') return createCpanelAdapter(options);
  if (target === 'plesk') return createPleskAdapter(options);
  return createStandaloneAdapter(options);
}

/**
 * A minimal, pragmatic `SecretResolver`: `ldap/bind` resolves from
 * `GULOGULO_SECRET_LDAP_BIND`, and so on for every other `*SecretRef` field
 * (`cpanel.apiTokenSecretRef`, `plesk.apiKeySecretRef`, ...). This keeps
 * plaintext secrets out of the JSON configuration file (the existing
 * `SECRET_KEY_PATTERN` check in `src/runtime/config.ts` already enforces
 * that) while requiring no new infrastructure to stand up a working
 * production login path today.
 *
 * `postgres/dsn` is a deliberate exception: `packaging/standalone/scripts/
 * run-migrations.mjs` (documented in `doc/identity-and-postgres.md`) already
 * ships and reads that specific secret from `GULOGULO_POSTGRES_DSN`, not the
 * generic naming below. Checking that variable first means an operator who
 * already set it for migrations does not also have to duplicate it under a
 * second name for login to work.
 *
 * `src/core/secrets/versioned-file-secret-store.ts` already implements a
 * fuller managed rotation/rollback store; swapping it in here — instead of
 * this direct environment-variable lookup — is tracked as follow-up work
 * once its root directory and reference-map wiring lands in
 * `src/runtime/config.ts` (see INSTALL.md).
 */
export function createEnvironmentSecretResolver(environment: NodeJS.ProcessEnv = process.env): SecretResolver {
  return async (reference: string): Promise<string | undefined> => {
    if (reference === 'postgres/dsn' && typeof environment.GULOGULO_POSTGRES_DSN === 'string' && environment.GULOGULO_POSTGRES_DSN.length > 0) {
      return environment.GULOGULO_POSTGRES_DSN;
    }
    const key = `${SECRET_ENVIRONMENT_PREFIX}${reference.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`;
    const value = environment[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
}

interface ParsedLoginEmail {
  readonly tenantId: string;
  readonly domain: string;
  readonly username: string;
}

/**
 * Derives a tenant/domain/username triple from the submitted login email.
 * There is no separate "which tenant is this" configuration field today —
 * `tenants.domain` is already `UNIQUE` (`src/core/db/migrations/0001_m2_foundation.sql`)
 * and V1 forbids catch-all/cross-domain delivery, so one domain already means
 * exactly one tenant. Using the domain itself as `tenantId` is therefore a
 * safe canonical choice, not a shortcut around tenant isolation.
 */
function parseLoginEmail(email: unknown): ParsedLoginEmail | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return null;
  const username = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (username.length === 0 || domain.length === 0) return null;
  return { tenantId: domain, domain, username };
}

export interface ProvisionedLoginAuthenticatorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /** An already-loaded config (e.g. from `src/runtime/config.ts`'s `loadConfig()`); resolved via `adapter.loadConfig()` when omitted. */
  readonly config?: IntegrationConfig;
  readonly logger?: IntegrationLogger;
  readonly resolveSecret?: SecretResolver;
  /** Injectable for tests: overrides which `PlatformAdapter` backs the authenticator. */
  readonly adapter?: PlatformAdapter;
}

/**
 * Builds the real, provider-backed login authenticator for
 * `src/runtime/server.ts`'s `authenticateLogin` hook: resolves the
 * `PlatformAdapter` for the configured packaging target, asks it for an
 * identity client (LDAP or DB-backed for standalone, UAPI for cPanel, REST
 * for Plesk — see `src/platform/`), and calls its real `authenticate()`/
 * `lookupUser()`. This replaces `createFixtureLoginAuthenticator()` for every
 * production run that is not `GULOGULO_FIXTURE_MODE=true`
 * (`src/runtime/index.ts` chooses between the two).
 *
 * The identity client is built lazily on first use and cached: a
 * misconfigured or unreachable identity source fails a login attempt (401)
 * rather than crashing the process at startup.
 */
export function createProvisionedLoginAuthenticator({
  environment = process.env,
  config,
  logger = console,
  resolveSecret = createEnvironmentSecretResolver(environment),
  adapter = createPlatformAdapterForTarget(resolvePlatformTarget(environment), { environment, resolveSecret, logger }),
}: ProvisionedLoginAuthenticatorOptions = {}): ProvisionedLoginAuthenticator {
  let clientPromise: Promise<LdapIdentityClient> | undefined;

  async function identityClient(): Promise<LdapIdentityClient> {
    if (clientPromise === undefined) {
      clientPromise = (async () => {
        const resolvedConfig = config ?? await adapter.loadConfig();
        return adapter.createIdentityClient(resolvedConfig);
      })();
    }
    return clientPromise;
  }

  return async ({ email, password }: LoginCredentials): Promise<SessionIdentity | null> => {
    const parsed = parseLoginEmail(email);
    if (parsed === null || typeof password !== 'string' || password.length === 0) return null;

    let client: LdapIdentityClient;
    try {
      client = await identityClient();
    } catch (error) {
      logger.warn?.('login_identity_client_unavailable', { error: errorDetails(error) });
      return null;
    }
    if (!client.enabled) return null;

    let tenantContext: TenantContext;
    try {
      tenantContext = createTenantContext({ tenantId: parsed.tenantId, domain: parsed.domain });
    } catch (error) {
      logger.warn?.('login_tenant_context_invalid', { error: errorDetails(error) });
      return null;
    }
    let authenticated = false;
    try {
      authenticated = await client.authenticate({ tenantContext, username: parsed.username, password });
    } catch (error) {
      logger.warn?.('login_authenticate_failed', { error: errorDetails(error) });
      return null;
    }
    if (!authenticated) return null;

    let identity: TenantIdentity | null = null;
    try {
      identity = await client.lookupUser({ tenantContext, username: parsed.username });
    } catch (error) {
      logger.warn?.('login_lookup_failed', { error: errorDetails(error) });
      identity = null;
    }
    if (identity !== null && identity.active === false) return null;

    const userId = identity?.externalId ?? parsed.username;
    return Object.freeze({
      tenantId: parsed.tenantId,
      domain: parsed.domain,
      userId,
      actorId: userId,
      role: 'user' as const,
    });
  };
}
