// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

export const CONTROL_PANEL_PROVIDERS = Object.freeze(['none', 'plesk', 'cpanel'] as const);
export type ControlPanelProvider = typeof CONTROL_PANEL_PROVIDERS[number];

export const CONTROL_PANEL_SYNC_MODES = Object.freeze(['pull', 'webhook', 'hybrid'] as const);
export type ControlPanelSyncMode = typeof CONTROL_PANEL_SYNC_MODES[number];

export const CONTROL_PANEL_STATES = Object.freeze(['disabled', 'configured', 'degraded'] as const);
export type ControlPanelState = typeof CONTROL_PANEL_STATES[number];

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu;

type UnknownRecord = Record<string, unknown>;

export interface ControlPanelConfigInput {
  readonly enabled?: unknown;
  readonly provider?: unknown;
  readonly baseUrl?: unknown;
  readonly accountRef?: unknown;
  readonly credentialSecretRef?: unknown;
  readonly webhookSecretRef?: unknown;
  readonly syncMode?: unknown;
  readonly allowDnsChanges?: unknown;
}

export interface ControlPanelConfig {
  readonly enabled: boolean;
  readonly provider: ControlPanelProvider;
  readonly baseUrl: string | null;
  readonly accountRef: string | null;
  readonly credentialSecretRef: string | null;
  readonly webhookSecretRef: string | null;
  readonly syncMode: ControlPanelSyncMode;
  readonly allowDnsChanges: false;
}

export interface ControlPanelTenantBindingInput {
  readonly tenantId?: unknown;
  readonly domain?: unknown;
  readonly externalDomainId?: unknown;
}

export interface ControlPanelTenantBinding {
  readonly provider: Exclude<ControlPanelProvider, 'none'>;
  readonly tenantId: string;
  readonly domain: string;
  readonly accountRef: string;
  readonly externalDomainId: string | null;
}

export interface ControlPanelStatus {
  readonly provider: ControlPanelProvider;
  readonly enabled: boolean;
  readonly state: ControlPanelState;
  readonly syncMode: ControlPanelSyncMode;
  readonly baseHost?: string;
  readonly accountRef?: string;
  readonly reason?: 'disabled' | 'credentials_not_configured' | 'provider_not_reachable';
}

export interface ControlPanelCapabilities {
  readonly readTenantBinding: true;
  readonly readDomainState: true;
  readonly readDnsState: true;
  readonly writeDomainState: false;
  readonly writeDnsState: false;
  readonly executeCommands: false;
}

export interface ControlPanelIntegration {
  readonly config: ControlPanelConfig;
  readonly readOnly: true;
  readonly capabilities: ControlPanelCapabilities;
  readonly status: () => ControlPanelStatus;
  readonly createTenantBinding: (input: ControlPanelTenantBindingInput) => ControlPanelTenantBinding;
}

function object(value: unknown): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw panelError('configuration must be an object', 'INVALID_CONFIGURATION');
  return value as UnknownRecord;
}

function panelError(message: string, code: string): Error & { readonly code: string } {
  const error = new Error(`Control-panel contract error: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function allowedKeys(value: UnknownRecord): void {
  const allowed = new Set(['enabled', 'provider', 'baseUrl', 'accountRef', 'credentialSecretRef', 'webhookSecretRef', 'syncMode', 'allowDnsChanges']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw panelError(`${key} is not supported`, 'UNKNOWN_CONFIGURATION');
}

function optionalString(value: unknown, field: string, allowNull = true): string | null {
  if (value === undefined || (allowNull && value === null)) return null;
  if (typeof value !== 'string' || !SAFE_REFERENCE.test(value)) throw panelError(`${field} is invalid`, 'INVALID_REFERENCE');
  return value;
}

function secretReference(value: unknown, field: string): string | null {
  return optionalString(value, field);
}

function httpsUrl(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 2048) throw panelError('baseUrl is invalid', 'INVALID_URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw panelError('baseUrl is not a URL', 'INVALID_URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search || !parsed.hostname) {
    throw panelError('baseUrl must be HTTPS without credentials, query, or fragment', 'INSECURE_URL');
  }
  return parsed.toString().replace(/\/$/u, '');
}

function provider(value: unknown): ControlPanelProvider {
  if (value === undefined) return 'none';
  if (typeof value !== 'string' || !(CONTROL_PANEL_PROVIDERS as readonly string[]).includes(value)) throw panelError('provider is invalid', 'INVALID_PROVIDER');
  return value as ControlPanelProvider;
}

function syncMode(value: unknown): ControlPanelSyncMode {
  if (value === undefined) return 'pull';
  if (typeof value !== 'string' || !(CONTROL_PANEL_SYNC_MODES as readonly string[]).includes(value)) throw panelError('syncMode is invalid', 'INVALID_SYNC_MODE');
  return value as ControlPanelSyncMode;
}

function domain(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 253 || !SAFE_DOMAIN.test(value.trim())) throw panelError(`${field} is invalid`, 'INVALID_DOMAIN');
  return value.trim().toLowerCase();
}

function requiredReference(value: unknown, field: string): string {
  const reference = optionalString(value, field, false);
  if (reference === null) throw panelError(`${field} is required`, 'MISSING_REFERENCE');
  return reference;
}

/**
 * Validate the optional upstream hosting panel without making network calls.
 * Plesk and cPanel remain tenant-side tools; Gulo Gulo owns policy, content,
 * LDAP, PostgreSQL, mailbox state, and audit semantics.
 */
export function createControlPanelConfig(input: ControlPanelConfigInput = {}): ControlPanelConfig {
  const raw = object(input);
  allowedKeys(raw);
  const enabled = raw.enabled === undefined ? false : raw.enabled;
  if (typeof enabled !== 'boolean') throw panelError('enabled must be a boolean', 'INVALID_CONFIGURATION');
  const selectedProvider = provider(raw.provider);
  const selectedSyncMode = syncMode(raw.syncMode);
  const baseUrl = httpsUrl(raw.baseUrl);
  const accountRef = optionalString(raw.accountRef, 'accountRef');
  const credentialSecretRef = secretReference(raw.credentialSecretRef, 'credentialSecretRef');
  const webhookSecretRef = secretReference(raw.webhookSecretRef, 'webhookSecretRef');
  if (raw.allowDnsChanges !== undefined && raw.allowDnsChanges !== false) throw panelError('allowDnsChanges is permanently false in this contract', 'WRITE_OPERATION_FORBIDDEN');
  if (selectedProvider === 'none') {
    if (enabled || baseUrl !== null || accountRef !== null || credentialSecretRef !== null || webhookSecretRef !== null) throw panelError('provider none cannot be enabled or configured', 'INVALID_PROVIDER_CONFIGURATION');
  } else if (enabled) {
    if (baseUrl === null || accountRef === null || credentialSecretRef === null) throw panelError('enabled integrations require baseUrl, accountRef, and credentialSecretRef', 'INCOMPLETE_CONFIGURATION');
    if ((selectedSyncMode === 'webhook' || selectedSyncMode === 'hybrid') && webhookSecretRef === null) throw panelError('webhook and hybrid sync require webhookSecretRef', 'INCOMPLETE_CONFIGURATION');
  }
  return Object.freeze({
    enabled,
    provider: selectedProvider,
    baseUrl,
    accountRef,
    credentialSecretRef,
    webhookSecretRef,
    syncMode: selectedSyncMode,
    allowDnsChanges: false,
  });
}

export function createControlPanelIntegration(configInput: ControlPanelConfigInput = {}): ControlPanelIntegration {
  const config = createControlPanelConfig(configInput);
  const capabilities: ControlPanelCapabilities = Object.freeze({
    readTenantBinding: true,
    readDomainState: true,
    readDnsState: true,
    writeDomainState: false,
    writeDnsState: false,
    executeCommands: false,
  });
  const status = (): ControlPanelStatus => {
    if (!config.enabled || config.provider === 'none') return Object.freeze({ provider: config.provider, enabled: false, state: 'disabled', syncMode: config.syncMode, reason: 'disabled' });
    const base = { provider: config.provider, enabled: true, state: 'configured' as const, syncMode: config.syncMode };
    if (config.baseUrl !== null) {
      const parsed = new URL(config.baseUrl);
      return Object.freeze({ ...base, baseHost: parsed.hostname, accountRef: config.accountRef ?? undefined });
    }
    return Object.freeze({ ...base, state: 'degraded' as const, reason: 'credentials_not_configured' as const });
  };
  const createTenantBinding = (input: ControlPanelTenantBindingInput): ControlPanelTenantBinding => {
    if (!config.enabled || config.provider === 'none') throw panelError('integration is disabled', 'INTEGRATION_DISABLED');
    return Object.freeze({
      provider: config.provider,
      tenantId: requiredReference(input.tenantId, 'tenantId'),
      domain: domain(input.domain, 'domain'),
      accountRef: requiredReference(config.accountRef, 'accountRef'),
      externalDomainId: optionalString(input.externalDomainId, 'externalDomainId'),
    });
  };
  return Object.freeze({ config, readOnly: true, capabilities, status, createTenantBinding });
}
