// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_ENVELOPE_VERSION = 1;
export const BACKUP_LINK_TTL_MAX_MS = 24 * 60 * 60 * 1000;
export const BACKUP_RESOURCE_TYPES = Object.freeze([
  'mail',
  'folders',
  'ics',
  'vcard',
  'preferences',
]);
export const BACKUP_PROVIDER_OPERATIONS = Object.freeze(['snapshot', 'restore']);
export const BACKUP_ENCRYPTION_ALGORITHM = 'aes-256-gcm';

const RESOURCE_TYPE_SET = new Set(BACKUP_RESOURCE_TYPES);
const PROVIDER_OPERATION_SET = new Set(BACKUP_PROVIDER_OPERATIONS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_ARCHIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)(?:\.|\.\.)\/?)[A-Za-z0-9._@+()\-/]{1,512}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LINK_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const SENSITIVE_FIELD_PATTERN = /^(?:session(?:id|token|secret)?|session[_-].*|access[_-]?token|refresh[_-]?token|cookie|authorization|password|passphrase|private[_-]?key|credential(?:s)?|secret)$/iu;
const DEFAULT_LINK_BASE_URL = 'https://download.invalid';
const MIN_AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;

function backupError(message, code = 'BACKUP_CONTRACT_ERROR') {
  const error = new Error(`Backup contract error: ${message}`);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) throw backupError(`${name} must be an object`, 'INVALID_CONTRACT');
}

function assertId(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw backupError(`${name} is invalid`, 'INVALID_IDENTITY');
  }
  return value;
}

function assertReference(value, name) {
  if (typeof value !== 'string' || !SAFE_REFERENCE_PATTERN.test(value)) {
    throw backupError(`${name} is invalid`, 'INVALID_REFERENCE');
  }
  return value;
}

function assertDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw backupError(`${name} is invalid`, 'INVALID_TIMESTAMP');
  return date;
}

function assertInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw backupError(`${name} must be an integer between ${minimum} and ${maximum}`, 'INVALID_NUMBER');
  }
  return value;
}

function assertResourceList(resources, name = 'resources') {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw backupError(`${name} must be a non-empty array`, 'INVALID_RESOURCES');
  }
  const unique = [...new Set(resources)];
  if (unique.some((resource) => typeof resource !== 'string' || !RESOURCE_TYPE_SET.has(resource))) {
    throw backupError(`${name} contains an unsupported resource`, 'INVALID_RESOURCES');
  }
  return Object.freeze(unique);
}

function assertSafeMetadata(value, path = 'metadata') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeMetadata(item, `${path}[${index}]`));
    return value;
  }
  if (isPlainObject(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      if (SENSITIVE_FIELD_PATTERN.test(key)) {
        throw backupError(`${path}.${key} is not allowed in backup metadata`, 'SESSION_SECRET_FORBIDDEN');
      }
      assertSafeMetadata(nestedValue, `${path}.${key}`);
    }
    return value;
  }
  if (
    value !== null
    && typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'boolean'
  ) {
    throw backupError(`${path} contains an unsupported value`, 'INVALID_METADATA');
  }
  return value;
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw backupError('value cannot be represented canonically', 'INVALID_METADATA');
}

export function canonicalJson(value) {
  assertSafeMetadata(value);
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(typeof value === 'string' ? value : canonicalJson(value), 'utf8');
  return createHash('sha256').update(input).digest('hex');
}

function assertChecksum(value, name = 'checksum') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw backupError(`${name} must be a lowercase SHA-256 digest`, 'INVALID_CHECKSUM');
  }
  return value;
}

function normalizeIdentity(identity, name = 'identity') {
  assertPlainObject(identity, name);
  const role = identity.role ?? 'user';
  if (typeof role !== 'string' || !['user', 'provider', 'tenant_master', 'monitor'].includes(role)) {
    throw backupError(`${name}.role is invalid`, 'INVALID_IDENTITY');
  }
  return Object.freeze({
    tenantId: assertId(identity.tenantId, `${name}.tenantId`),
    userId: identity.userId === null || identity.userId === undefined
      ? null
      : assertId(identity.userId, `${name}.userId`),
    role,
  });
}

function assertNoSessionSecrets(value) {
  try {
    assertSafeMetadata(value);
  } catch (error) {
    if (error.code === 'SESSION_SECRET_FORBIDDEN') throw error;
    throw error;
  }
}

/**
 * Authorize a user backup without copying a session or its secrets into the
 * durable backup scope. A normal user can only target that same user.
 */
export function createUserBackupScope({
  session,
  targetUserId = session?.userId,
  resources = BACKUP_RESOURCE_TYPES,
  issuedAt = new Date(),
  expiresAt = null,
} = {}) {
  const actor = normalizeIdentity(session, 'session');
  if (actor.role !== 'user') {
    throw backupError('user self-service requires a user session', 'USER_SCOPE_DENIED');
  }
  const target = assertId(targetUserId, 'targetUserId');
  if (target !== actor.userId) {
    throw backupError('a user backup can target only the authenticated user', 'USER_SCOPE_DENIED');
  }
  const issued = assertDate(issuedAt, 'issuedAt');
  const expiry = expiresAt === null ? null : assertDate(expiresAt, 'expiresAt');
  if (expiry !== null && expiry <= issued) {
    throw backupError('expiresAt must be later than issuedAt', 'INVALID_TIMESTAMP');
  }
  const scope = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    scopeType: 'user-self-service',
    tenantId: actor.tenantId,
    userId: actor.userId,
    resources: assertResourceList(resources),
    issuedAt: issued.toISOString(),
    expiresAt: expiry?.toISOString() ?? null,
    sessionBinding: 'request-only',
    sessionSecrets: false,
  };
  assertNoSessionSecrets(scope);
  return Object.freeze(scope);
}

function normalizeEntry(entry, index) {
  assertPlainObject(entry, `entries[${index}]`);
  if (typeof entry.resource !== 'string' || !RESOURCE_TYPE_SET.has(entry.resource)) {
    throw backupError(`entries[${index}].resource is unsupported`, 'INVALID_ARCHIVE');
  }
  if (typeof entry.path !== 'string' || !SAFE_ARCHIVE_PATH_PATTERN.test(entry.path)) {
    throw backupError(`entries[${index}].path is unsafe`, 'INVALID_ARCHIVE_PATH');
  }
  const bytes = assertInteger(entry.bytes, `entries[${index}].bytes`, 0, Number.MAX_SAFE_INTEGER);
  const checksum = assertChecksum(entry.sha256, `entries[${index}].sha256`);
  const normalized = {
    resource: entry.resource,
    path: entry.path,
    bytes,
    sha256: checksum,
  };
  if (entry.mediaType !== undefined) {
    if (typeof entry.mediaType !== 'string' || entry.mediaType.length === 0 || entry.mediaType.length > 255) {
      throw backupError(`entries[${index}].mediaType is invalid`, 'INVALID_ARCHIVE');
    }
    normalized.mediaType = entry.mediaType;
  }
  return Object.freeze(normalized);
}

/**
 * Build a metadata-only archive manifest. The caller supplies checksums for
 * the encrypted archive members; member bodies never enter this object.
 */
export function createArchiveManifest({
  scope,
  archiveId = randomUUID(),
  entries,
  createdAt = new Date(),
  format = 'gulogulo-backup-tar',
} = {}) {
  assertPlainObject(scope, 'scope');
  assertId(scope.tenantId, 'scope.tenantId');
  if (scope.userId !== null) assertId(scope.userId, 'scope.userId');
  assertResourceList(scope.resources, 'scope.resources');
  assertId(archiveId, 'archiveId');
  if (!Array.isArray(entries) || entries.length === 0) {
    throw backupError('entries must be a non-empty array', 'INVALID_ARCHIVE');
  }
  const timestamp = assertDate(createdAt, 'createdAt');
  if (typeof format !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(format)) {
    throw backupError('format is invalid', 'INVALID_ARCHIVE');
  }
  const normalizedEntries = Object.freeze(entries.map(normalizeEntry));
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    archiveId,
    format,
    tenantId: scope.tenantId,
    userId: scope.userId,
    resources: Object.freeze([...scope.resources]),
    createdAt: timestamp.toISOString(),
    entries: normalizedEntries,
    encryptedContent: true,
  };
  assertNoSessionSecrets(manifest);
  const withDigest = {
    ...manifest,
    manifestSha256: sha256Hex(manifest),
  };
  return Object.freeze(withDigest);
}

export function verifyArchiveManifest(manifest, contentByPath = {}) {
  assertPlainObject(manifest, 'manifest');
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw backupError('manifest schemaVersion is unsupported', 'INVALID_ARCHIVE');
  }
  if (typeof manifest.manifestSha256 !== 'string') {
    throw backupError('manifestSha256 is required', 'INVALID_ARCHIVE');
  }
  const { manifestSha256, ...withoutDigest } = manifest;
  if (sha256Hex(withoutDigest) !== manifestSha256) {
    throw backupError('manifest digest does not match', 'INTEGRITY_FAILED');
  }
  const results = [];
  for (const entry of manifest.entries) {
    const data = contentByPath[entry.path];
    if (data === undefined) {
      results.push(Object.freeze({ path: entry.path, status: 'not-present' }));
      continue;
    }
    const actual = sha256Hex(data);
    if (actual !== entry.sha256) {
      throw backupError(`checksum mismatch for ${entry.path}`, 'INTEGRITY_FAILED');
    }
    const bytes = Buffer.byteLength(data);
    if (bytes !== entry.bytes) {
      throw backupError(`size mismatch for ${entry.path}`, 'INTEGRITY_FAILED');
    }
    results.push(Object.freeze({ path: entry.path, status: 'verified', sha256: actual, bytes }));
  }
  return Object.freeze({
    archiveId: manifest.archiveId,
    manifestSha256,
    entries: Object.freeze(results),
    complete: results.every((result) => result.status === 'verified'),
  });
}

function assertEncryptionKey(key) {
  if (!(Buffer.isBuffer(key) || key instanceof Uint8Array) || key.byteLength !== MIN_AES_KEY_BYTES) {
    throw backupError('encryption key must contain exactly 32 bytes', 'INVALID_ENCRYPTION_KEY');
  }
  return Buffer.from(key);
}

function assertKeyReference(value) {
  return assertReference(value, 'keyReference');
}

/**
 * Encrypt metadata in-process with an externally managed 256-bit key. The
 * key is never returned, serialized, or placed in the envelope. Production
 * callers should resolve it from a KMS/secret provider using keyReference.
 */
export function encryptArchiveMetadata(metadata, {
  key,
  keyReference,
  aad = 'gulogulo-backup-metadata-v1',
  random = randomBytes,
} = {}) {
  assertPlainObject(metadata, 'metadata');
  assertNoSessionSecrets(metadata);
  const encryptionKey = assertEncryptionKey(key);
  const reference = assertKeyReference(keyReference);
  if (typeof aad !== 'string' || aad.length === 0 || aad.length > 128) {
    throw backupError('aad is invalid', 'INVALID_ENCRYPTION');
  }
  const iv = random(AES_IV_BYTES);
  if (!(iv instanceof Uint8Array) || iv.byteLength !== AES_IV_BYTES) {
    throw backupError('random source returned an invalid IV', 'INVALID_ENCRYPTION');
  }
  const cipher = createCipheriv(BACKUP_ENCRYPTION_ALGORITHM, encryptionKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const plaintext = Buffer.from(canonicalJson(metadata), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    envelopeVersion: BACKUP_ENVELOPE_VERSION,
    algorithm: BACKUP_ENCRYPTION_ALGORITHM,
    keyReference: reference,
    aad,
    iv: Buffer.from(iv).toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    plaintextSha256: sha256Hex(plaintext),
  };
  assertNoSessionSecrets(envelope);
  return Object.freeze(envelope);
}

export function decryptArchiveMetadata(envelope, { key } = {}) {
  assertPlainObject(envelope, 'envelope');
  if (envelope.envelopeVersion !== BACKUP_ENVELOPE_VERSION || envelope.algorithm !== BACKUP_ENCRYPTION_ALGORITHM) {
    throw backupError('unsupported archive envelope', 'INVALID_ENCRYPTION');
  }
  const encryptionKey = assertEncryptionKey(key);
  assertKeyReference(envelope.keyReference);
  if (typeof envelope.aad !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.authTag !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw backupError('archive envelope is incomplete', 'INVALID_ENCRYPTION');
  }
  let plaintext;
  try {
    const decipher = createDecipheriv(
      BACKUP_ENCRYPTION_ALGORITHM,
      encryptionKey,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(envelope.aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
  } catch {
    throw backupError('archive metadata authentication failed', 'INTEGRITY_FAILED');
  }
  if (sha256Hex(plaintext) !== envelope.plaintextSha256) {
    throw backupError('archive metadata checksum mismatch', 'INTEGRITY_FAILED');
  }
  let metadata;
  try {
    metadata = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw backupError('archive metadata is not valid JSON', 'INVALID_ENCRYPTION');
  }
  assertNoSessionSecrets(metadata);
  return Object.freeze(metadata);
}

function normalizeLinkBaseUrl(value) {
  const baseUrl = value ?? DEFAULT_LINK_BASE_URL;
  if (typeof baseUrl !== 'string') throw backupError('baseUrl is invalid', 'INVALID_LINK');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw backupError('baseUrl is invalid', 'INVALID_LINK');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw backupError('backup links require an HTTPS base URL without credentials', 'INVALID_LINK');
  }
  return parsed;
}

/** Create an opaque, expiring link record; only the caller receives the token. */
export function createBackupLink({
  archiveId,
  scope,
  baseUrl = DEFAULT_LINK_BASE_URL,
  issuedAt = new Date(),
  expiresAt = null,
  ttlMs = 15 * 60 * 1000,
  token = randomBytes(32).toString('base64url'),
} = {}) {
  assertId(archiveId, 'archiveId');
  assertPlainObject(scope, 'scope');
  const tenantId = assertId(scope.tenantId, 'scope.tenantId');
  const userId = scope.userId === null ? null : assertId(scope.userId, 'scope.userId');
  const resources = assertResourceList(scope.resources, 'scope.resources');
  const issued = assertDate(issuedAt, 'issuedAt');
  const expiry = expiresAt === null
    ? new Date(issued.getTime() + assertInteger(ttlMs, 'ttlMs', 1_000, BACKUP_LINK_TTL_MAX_MS))
    : assertDate(expiresAt, 'expiresAt');
  if (expiry <= issued || expiry.getTime() - issued.getTime() > BACKUP_LINK_TTL_MAX_MS) {
    throw backupError('backup link expiry is outside the allowed window', 'INVALID_LINK');
  }
  if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
    throw backupError('token is invalid', 'INVALID_LINK');
  }
  const linkId = randomUUID();
  const url = normalizeLinkBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/backup/${linkId}`;
  url.searchParams.set('token', token);
  const record = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    linkId,
    archiveId,
    tenantId,
    userId,
    resources,
    issuedAt: issued.toISOString(),
    expiresAt: expiry.toISOString(),
    revokedAt: null,
    tokenSha256: sha256Hex(token),
    href: url.toString(),
    oneTime: false,
  };
  // The token is intentionally returned separately and must not be persisted
  // in archive metadata or audit records.
  const result = {
    record: Object.freeze(record),
    token,
  };
  assertNoSessionSecrets(result.record);
  return Object.freeze(result);
}

export function revokeBackupLink(link, { revokedAt = new Date(), reason = 'operator-revoked' } = {}) {
  assertPlainObject(link, 'link');
  if (typeof link.linkId !== 'string' || !LINK_ID_PATTERN.test(link.linkId)) throw backupError('linkId is invalid', 'INVALID_LINK');
  const revoked = assertDate(revokedAt, 'revokedAt');
  if (typeof reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(reason)) {
    throw backupError('reason is invalid', 'INVALID_LINK');
  }
  return Object.freeze({ ...link, revokedAt: revoked.toISOString(), revokeReason: reason });
}

export function assertBackupLinkUsable(link, { token, now = new Date() } = {}) {
  assertPlainObject(link, 'link');
  const current = assertDate(now, 'now');
  if (link.revokedAt !== null) throw backupError('backup link has been revoked', 'LINK_REVOKED');
  if (current >= assertDate(link.expiresAt, 'link.expiresAt')) throw backupError('backup link has expired', 'LINK_EXPIRED');
  if (typeof token !== 'string') throw backupError('link token is required', 'LINK_TOKEN_INVALID');
  const expected = Buffer.from(assertChecksum(link.tokenSha256, 'link.tokenSha256'), 'hex');
  const actual = Buffer.from(sha256Hex(token), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw backupError('link token is invalid', 'LINK_TOKEN_INVALID');
  }
  return true;
}

/**
 * Create a provider scope for encrypted tenant-level copies. Providers may
 * move ciphertext and metadata for DR, but receive no user session, cookie,
 * bearer token, or plaintext decryption capability.
 */
export function createProviderBackupScope({
  providerId,
  tenantId,
  resources = BACKUP_RESOURCE_TYPES,
  operations = BACKUP_PROVIDER_OPERATIONS,
  encryptionKeyReference,
  issuedAt = new Date(),
  expiresAt,
} = {}) {
  const normalizedProviderId = assertId(providerId, 'providerId');
  const normalizedTenantId = assertId(tenantId, 'tenantId');
  const normalizedResources = assertResourceList(resources);
  if (!Array.isArray(operations) || operations.length === 0 || operations.some((operation) => !PROVIDER_OPERATION_SET.has(operation))) {
    throw backupError('operations are invalid', 'INVALID_PROVIDER_SCOPE');
  }
  const normalizedOperations = Object.freeze([...new Set(operations)]);
  const reference = assertKeyReference(encryptionKeyReference);
  const issued = assertDate(issuedAt, 'issuedAt');
  const expiry = assertDate(expiresAt, 'expiresAt');
  if (expiry <= issued) throw backupError('expiresAt must be later than issuedAt', 'INVALID_TIMESTAMP');
  const scope = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    scopeType: 'provider-encrypted-tenant',
    providerId: normalizedProviderId,
    tenantId: normalizedTenantId,
    userId: null,
    resources: normalizedResources,
    operations: normalizedOperations,
    issuedAt: issued.toISOString(),
    expiresAt: expiry.toISOString(),
    encryptedContentOnly: true,
    plaintextAccess: false,
    sessionAccess: false,
    sessionSecrets: false,
    encryptionKeyReference: reference,
  };
  assertNoSessionSecrets(scope);
  return Object.freeze(scope);
}

function assertScopeTarget(scope, target) {
  assertPlainObject(scope, 'scope');
  const normalizedTarget = normalizeIdentity(target, 'target');
  if (scope.tenantId !== normalizedTarget.tenantId) {
    throw backupError('restore target crosses tenant boundary', 'TENANT_SCOPE_DENIED');
  }
  if (scope.scopeType === 'user-self-service' && scope.userId !== normalizedTarget.userId) {
    throw backupError('restore target crosses user boundary', 'USER_SCOPE_DENIED');
  }
  if (scope.scopeType !== 'user-self-service' && scope.scopeType !== 'provider-encrypted-tenant') {
    throw backupError('scope type is not restorable', 'INVALID_SCOPE');
  }
  if (scope.scopeType === 'provider-encrypted-tenant' && normalizedTarget.role !== 'provider') {
    throw backupError('provider scope requires a provider restore actor', 'PROVIDER_SCOPE_DENIED');
  }
  return normalizedTarget;
}

/** Build a privacy-checked restore plan without opening archive member bodies. */
export function createRestorePlan({
  manifest,
  scope,
  target,
  requestedResources = scope?.resources,
  overwrite = false,
  plannedAt = new Date(),
} = {}) {
  assertPlainObject(manifest, 'manifest');
  assertPlainObject(scope, 'scope');
  assertScopeTarget(scope, target);
  if (manifest.tenantId !== scope.tenantId || manifest.userId !== scope.userId) {
    throw backupError('manifest scope does not match restore scope', 'SCOPE_MISMATCH');
  }
  const resources = assertResourceList(requestedResources, 'requestedResources');
  if (resources.some((resource) => !scope.resources.includes(resource))) {
    throw backupError('restore requests a resource outside the authorized scope', 'RESOURCE_SCOPE_DENIED');
  }
  if (typeof overwrite !== 'boolean') throw backupError('overwrite must be boolean', 'INVALID_RESTORE_PLAN');
  const timestamp = assertDate(plannedAt, 'plannedAt');
  const plan = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    planType: 'restore',
    archiveId: manifest.archiveId,
    tenantId: scope.tenantId,
    userId: scope.userId,
    resources,
    overwrite,
    integrityRequired: true,
    privacyValidated: true,
    plannedAt: timestamp.toISOString(),
    status: 'ready-for-integrity-check',
  };
  assertNoSessionSecrets(plan);
  return Object.freeze(plan);
}

export function validateRestorePlan(plan, {
  manifest,
  scope,
  target,
  contentByPath = {},
} = {}) {
  assertPlainObject(plan, 'plan');
  assertPlainObject(manifest, 'manifest');
  const actor = assertScopeTarget(scope, target);
  if (plan.archiveId !== manifest.archiveId || plan.tenantId !== scope.tenantId || plan.userId !== scope.userId) {
    throw backupError('restore plan identity does not match its archive scope', 'SCOPE_MISMATCH');
  }
  if (actor.role === 'user' && plan.overwrite) {
    throw backupError('user restores cannot overwrite existing data', 'RESTORE_POLICY_DENIED');
  }
  const integrity = verifyArchiveManifest(manifest, contentByPath);
  if (!integrity.complete) {
    throw backupError('all archive members must be present before restore', 'INTEGRITY_INCOMPLETE');
  }
  return Object.freeze({
    ...plan,
    status: 'validated',
    integrity,
    privacyValidated: true,
    validatedAt: new Date().toISOString(),
  });
}

export function createRecoveryObjectives({
  rpoMinutes = 15,
  rtoMinutes = 60,
  retentionDays = 28,
  measuredFrom = 'last-successful-backup',
} = {}) {
  assertInteger(rpoMinutes, 'rpoMinutes', 1, 525_600);
  assertInteger(rtoMinutes, 'rtoMinutes', 1, 525_600);
  if (rtoMinutes < rpoMinutes) throw backupError('rtoMinutes cannot be lower than rpoMinutes', 'INVALID_RECOVERY_OBJECTIVES');
  assertInteger(retentionDays, 'retentionDays', 28, 36_500);
  if (!['last-successful-backup', 'last-replicated-checkpoint'].includes(measuredFrom)) {
    throw backupError('measuredFrom is invalid', 'INVALID_RECOVERY_OBJECTIVES');
  }
  return Object.freeze({
    schemaVersion: BACKUP_SCHEMA_VERSION,
    objectiveType: 'tenant-disaster-recovery',
    rpoMinutes,
    rtoMinutes,
    retentionDays,
    measuredFrom,
  });
}

/** Record metadata from a DR rehearsal; it contains no mailbox/DAV bodies. */
export function createDrRehearsalRecord({
  rehearsalId = randomUUID(),
  tenantId,
  archiveId,
  objectives,
  startedAt,
  endedAt,
  outcome,
  observedRpoMinutes,
  observedRtoMinutes,
  integrityVerified,
  privacyVerified,
  evidenceSha256,
  runbookVersion = '1',
} = {}) {
  assertId(rehearsalId, 'rehearsalId');
  assertId(tenantId, 'tenantId');
  assertId(archiveId, 'archiveId');
  assertPlainObject(objectives, 'objectives');
  assertInteger(objectives.rpoMinutes, 'objectives.rpoMinutes', 1, 525_600);
  assertInteger(objectives.rtoMinutes, 'objectives.rtoMinutes', 1, 525_600);
  if (objectives.rtoMinutes < objectives.rpoMinutes) {
    throw backupError('objectives.rtoMinutes cannot be lower than objectives.rpoMinutes', 'INVALID_REHEARSAL');
  }
  const started = assertDate(startedAt, 'startedAt');
  const ended = assertDate(endedAt, 'endedAt');
  if (ended < started) throw backupError('endedAt must not precede startedAt', 'INVALID_REHEARSAL');
  if (!['passed', 'failed', 'inconclusive'].includes(outcome)) throw backupError('outcome is invalid', 'INVALID_REHEARSAL');
  assertInteger(observedRpoMinutes, 'observedRpoMinutes', 0, 525_600);
  assertInteger(observedRtoMinutes, 'observedRtoMinutes', 0, 525_600);
  if (typeof integrityVerified !== 'boolean' || typeof privacyVerified !== 'boolean') {
    throw backupError('integrityVerified and privacyVerified must be boolean', 'INVALID_REHEARSAL');
  }
  if (evidenceSha256 !== undefined) assertChecksum(evidenceSha256, 'evidenceSha256');
  if (typeof runbookVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(runbookVersion)) {
    throw backupError('runbookVersion is invalid', 'INVALID_REHEARSAL');
  }
  const passed = outcome === 'passed';
  if (passed && (!integrityVerified || !privacyVerified || observedRpoMinutes > objectives.rpoMinutes || observedRtoMinutes > objectives.rtoMinutes)) {
    throw backupError('a passed rehearsal must satisfy integrity, privacy, RPO, and RTO objectives', 'INVALID_REHEARSAL');
  }
  const record = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    rehearsalId,
    tenantId,
    archiveId,
    startedAt: started.toISOString(),
    endedAt: ended.toISOString(),
    durationMinutes: Math.ceil((ended.getTime() - started.getTime()) / 60_000),
    outcome,
    observedRpoMinutes,
    observedRtoMinutes,
    integrityVerified,
    privacyVerified,
    evidenceSha256: evidenceSha256 ?? null,
    runbookVersion,
  };
  assertNoSessionSecrets(record);
  return Object.freeze(record);
}

export { backupError, assertNoSessionSecrets };
