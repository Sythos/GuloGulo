// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export const ABUSE_SCHEMA_VERSION = 1;
export const ABUSE_CHANNELS = Object.freeze([
  'http',
  'api',
  'mcp',
  'login',
  'recovery',
  'backup',
  'websocket',
  'dav',
  'smtp',
  'imap',
]);
export const ABUSE_DIMENSIONS = Object.freeze(['tenant', 'ip', 'session']);
export const ABUSE_SUBJECT_TYPES = Object.freeze(['tenant', 'ip', 'session', 'user']);

const CHANNEL_SET = new Set(ABUSE_CHANNELS);
const DIMENSION_SET = new Set(ABUSE_DIMENSIONS);
const SUBJECT_TYPE_SET = new Set(ABUSE_SUBJECT_TYPES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const HOST_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/u;
const SECRET_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SENSITIVE_KEY_PATTERN = /(?:authorization|access[_-]?token|refresh[_-]?token|session(?:[_-]?(?:id|token|secret))?|cookie|password|passphrase|private[_-]?key|credential|secret(?!ref)|body|payload|content|message)/iu;
const PLACEHOLDER_HOST_PATTERN = /(?:^|\.)(?:example|invalid|localhost|local|internal)$/iu;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const REQUIRED_EXTERNAL_VOLUMES = Object.freeze(['runtime-state', 'mail-data', 'dav-data', 'backup-data']);
const DEFAULT_MAX_BUCKETS = 20_000;

function abuseError(message, code = 'ABUSE_CONTRACT_ERROR') {
  const error = new Error(`Abuse contract error: ${message}`);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) throw abuseError(`${name} must be an object`, 'INVALID_INPUT');
}

function assertString(value, name, pattern = null, maximum = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || (pattern && !pattern.test(value))) {
    throw abuseError(`${name} is invalid`, 'INVALID_INPUT');
  }
  return value;
}

function assertId(value, name) {
  return assertString(value, name, ID_PATTERN, 128);
}

function assertDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw abuseError(`${name} is invalid`, 'INVALID_TIMESTAMP');
  return date;
}

function assertInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw abuseError(`${name} must be an integer between ${minimum} and ${maximum}`, 'INVALID_NUMBER');
  }
  return value;
}

function nowMilliseconds(clock, name = 'clock') {
  const value = typeof clock === 'function' ? clock() : clock;
  return assertDate(value, name).getTime();
}

function digestSubject(subjectType, value) {
  const canonical = `${subjectType}\u0000${value}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function assertChannel(channel) {
  if (typeof channel !== 'string' || !CHANNEL_SET.has(channel)) {
    throw abuseError('channel is unsupported', 'INVALID_CHANNEL');
  }
  return channel;
}

function assertDimension(dimension) {
  if (typeof dimension !== 'string' || !DIMENSION_SET.has(dimension)) {
    throw abuseError('dimension is unsupported', 'INVALID_DIMENSION');
  }
  return dimension;
}

function assertSubjectType(subjectType) {
  if (typeof subjectType !== 'string' || !SUBJECT_TYPE_SET.has(subjectType)) {
    throw abuseError('subjectType is unsupported', 'INVALID_SUBJECT');
  }
  return subjectType;
}

function assertMetadata(value, path = 'metadata') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMetadata(item, `${path}[${index}]`));
    return value;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw abuseError(`${path}.${key} is not allowed in metadata`, 'SENSITIVE_DATA_FORBIDDEN');
      }
      assertMetadata(nested, `${path}.${key}`);
    }
    return value;
  }
  if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw abuseError(`${path} contains an unsupported value`, 'INVALID_METADATA');
  }
  return value;
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach((nested) => freezeDeep(nested));
    Object.freeze(value);
  }
  return value;
}

function normalizeRateRule(rule, name) {
  assertPlainObject(rule, name);
  const max = assertInteger(rule.max, `${name}.max`, 1, 1_000_000);
  const windowMs = assertInteger(rule.windowMs, `${name}.windowMs`, 1_000, 86_400_000);
  return Object.freeze({ max, windowMs });
}

function makeChannelLimits(tenantMax, ipMax, sessionMax, windowMs = 60_000) {
  return Object.freeze({
    tenant: Object.freeze({ max: tenantMax, windowMs }),
    ip: Object.freeze({ max: ipMax, windowMs }),
    session: Object.freeze({ max: sessionMax, windowMs }),
  });
}

export const DEFAULT_RATE_LIMITS = freezeDeep({
  http: makeChannelLimits(600, 120, 120),
  api: makeChannelLimits(300, 120, 120),
  mcp: makeChannelLimits(120, 30, 60),
  login: makeChannelLimits(60, 10, 10),
  recovery: makeChannelLimits(30, 5, 5),
  backup: makeChannelLimits(30, 10, 10),
  websocket: makeChannelLimits(120, 60, 60),
  dav: makeChannelLimits(300, 60, 120),
  smtp: makeChannelLimits(600, 60, 120),
  imap: makeChannelLimits(600, 60, 120),
});

function normalizeLimits(limits) {
  assertPlainObject(limits, 'limits');
  const normalized = {};
  for (const channel of ABUSE_CHANNELS) {
    const configured = limits[channel] ?? DEFAULT_RATE_LIMITS[channel];
    assertPlainObject(configured, `limits.${channel}`);
    normalized[channel] = {};
    for (const dimension of ABUSE_DIMENSIONS) {
      normalized[channel][dimension] = normalizeRateRule(configured[dimension], `limits.${channel}.${dimension}`);
    }
    normalized[channel] = Object.freeze(normalized[channel]);
  }
  return freezeDeep(normalized);
}

function normalizeRateIdentity({ tenantId, ipAddress = null, sessionId = null } = {}) {
  const identity = { tenantId: assertId(tenantId, 'tenantId'), ipAddress, sessionId };
  if (ipAddress !== null) assertString(ipAddress, 'ipAddress', null, 256);
  if (sessionId !== null) assertString(sessionId, 'sessionId', null, 512);
  return identity;
}

function identityForDimension(identity, dimension) {
  if (dimension === 'tenant') return identity.tenantId;
  if (dimension === 'ip') return identity.ipAddress;
  return identity.sessionId;
}

/**
 * Metadata-only multi-dimensional limiter. Raw IP addresses and session
 * identifiers are hashed before they enter the in-memory state or result.
 */
export function createRateLimiter({ limits = DEFAULT_RATE_LIMITS, clock = () => new Date(), maxBuckets = DEFAULT_MAX_BUCKETS } = {}) {
  const normalizedLimits = normalizeLimits(limits);
  assertInteger(maxBuckets, 'maxBuckets', 100, 1_000_000);
  const buckets = new Map();

  function prune() {
    while (buckets.size > maxBuckets) {
      const first = buckets.keys().next().value;
      if (first === undefined) break;
      buckets.delete(first);
    }
  }

  function consume({ channel, tenantId, ipAddress = null, sessionId = null, cost = 1, now = undefined } = {}) {
    const normalizedChannel = assertChannel(channel);
    const identity = normalizeRateIdentity({ tenantId, ipAddress, sessionId });
    assertInteger(cost, 'cost', 1, 1_000_000);
    const timestamp = now === undefined ? nowMilliseconds(clock) : nowMilliseconds(now, 'now');
    const dimensions = ABUSE_DIMENSIONS.filter((dimension) => identityForDimension(identity, dimension) !== null);
    const observations = [];
    for (const dimension of dimensions) {
      const rule = normalizedLimits[normalizedChannel][dimension];
      const subjectDigest = digestSubject(dimension, identityForDimension(identity, dimension));
      const key = `${normalizedChannel}:${dimension}:${subjectDigest}`;
      const current = buckets.get(key);
      const bucket = current && timestamp - current.startedAt < rule.windowMs
        ? current
        : { startedAt: timestamp, count: 0 };
      const limited = bucket.count + cost > rule.max;
      observations.push({ dimension, rule, key, bucket, limited, subjectDigest });
    }
    const limitedBy = observations.filter((item) => item.limited).map((item) => item.dimension);
    if (limitedBy.length === 0) {
      for (const observation of observations) {
        observation.bucket.count += cost;
        buckets.set(observation.key, observation.bucket);
      }
    }
    prune();
    const retryAfterMs = observations.length === 0
      ? 0
      : Math.max(...observations.filter((item) => item.limited).map((item) => Math.max(1, item.rule.windowMs - (timestamp - item.bucket.startedAt))), 0);
    const remaining = observations.length === 0
      ? 0
      : Math.min(...observations.map((item) => Math.max(0, item.rule.max - item.bucket.count)));
    return Object.freeze({
      schemaVersion: ABUSE_SCHEMA_VERSION,
      allowed: limitedBy.length === 0,
      channel: normalizedChannel,
      limitedBy: Object.freeze(limitedBy),
      retryAfterMs,
      remaining,
      resetAt: new Date(Math.max(...observations.map((item) => item.bucket.startedAt + item.rule.windowMs), timestamp)).toISOString(),
      activeBuckets: buckets.size,
    });
  }

  function snapshot() {
    const byChannel = Object.fromEntries(ABUSE_CHANNELS.map((channel) => [channel, 0]));
    const byDimension = Object.fromEntries(ABUSE_DIMENSIONS.map((dimension) => [dimension, 0]));
    for (const key of buckets.keys()) {
      const [channel, dimension] = key.split(':', 2);
      if (Object.hasOwn(byChannel, channel)) byChannel[channel] += 1;
      if (Object.hasOwn(byDimension, dimension)) byDimension[dimension] += 1;
    }
    return Object.freeze({ schemaVersion: ABUSE_SCHEMA_VERSION, activeBuckets: buckets.size, byChannel, byDimension });
  }

  return Object.freeze({ consume, snapshot, limits: normalizedLimits });
}

/** Create a secret-free audit event suitable for the existing audit pipeline. */
export function createAbuseAuditEvent({
  action,
  channel,
  outcome,
  tenantId,
  subjectType = null,
  subject = null,
  reason,
  details = {},
  occurredAt = new Date(),
} = {}) {
  assertString(action, 'action', SAFE_REASON_PATTERN, 128);
  assertChannel(channel);
  if (!['allowed', 'limited', 'locked', 'quarantined', 'released', 'rejected'].includes(outcome)) {
    throw abuseError('outcome is invalid', 'INVALID_AUDIT');
  }
  const normalizedTenant = assertId(tenantId, 'tenantId');
  if (subjectType !== null) assertSubjectType(subjectType);
  const digest = subjectType === null ? null : digestSubject(subjectType, assertString(subject, 'subject', null, 512));
  assertString(reason, 'reason', SAFE_REASON_PATTERN, 128);
  assertPlainObject(details, 'details');
  assertMetadata(details, 'details');
  const event = {
    schemaVersion: ABUSE_SCHEMA_VERSION,
    eventType: 'abuse.control',
    eventId: randomUUID(),
    action,
    channel,
    outcome,
    tenantId: normalizedTenant,
    subjectType,
    subjectDigest: digest,
    reason,
    details: freezeDeep({ ...details }),
    occurredAt: assertDate(occurredAt, 'occurredAt').toISOString(),
  };
  assertMetadata(event);
  return freezeDeep(event);
}

function normalizeLockoutPolicy(policy = {}) {
  assertPlainObject(policy, 'lockoutPolicy');
  return Object.freeze({
    failureThreshold: assertInteger(policy.failureThreshold ?? 5, 'failureThreshold', 1, 1_000),
    failureWindowMs: assertInteger(policy.failureWindowMs ?? 15 * 60_000, 'failureWindowMs', 1_000, 86_400_000),
    lockoutMs: assertInteger(policy.lockoutMs ?? 15 * 60_000, 'lockoutMs', 1_000, 86_400_000),
    quarantineThreshold: assertInteger(policy.quarantineThreshold ?? 10, 'quarantineThreshold', 1, 10_000),
    quarantineMs: assertInteger(policy.quarantineMs ?? 60 * 60_000, 'quarantineMs', 1_000, 7 * 86_400_000),
  });
}

/**
 * Compose the limiter, lockout, quarantine, and audit hook without exposing
 * the raw subjects. The hook receives immutable metadata only.
 */
export function createAbuseGuard({
  limits = DEFAULT_RATE_LIMITS,
  lockoutPolicy = {},
  clock = () => new Date(),
  onAudit = null,
} = {}) {
  if (onAudit !== null && typeof onAudit !== 'function') throw abuseError('onAudit must be a function', 'INVALID_HOOK');
  const limiter = createRateLimiter({ limits, clock });
  const policy = normalizeLockoutPolicy(lockoutPolicy);
  const failures = new Map();
  const lockouts = new Map();
  const quarantines = new Map();

  function subjectKey(tenantId, subjectType, subject) {
    const tenant = assertId(tenantId, 'tenantId');
    const type = assertSubjectType(subjectType);
    const value = assertString(subject, 'subject', null, 512);
    return `${tenant}:${type}:${digestSubject(type, value)}`;
  }

  function emit(event) {
    if (onAudit !== null) onAudit(event);
    return event;
  }

  function status({ tenantId, subjectType, subject, now = undefined } = {}) {
    const timestamp = now === undefined ? nowMilliseconds(clock) : nowMilliseconds(now, 'now');
    const key = subjectKey(tenantId, subjectType, subject);
    const lockoutUntil = lockouts.get(key) ?? 0;
    const quarantineUntil = quarantines.get(key) ?? 0;
    return Object.freeze({
      schemaVersion: ABUSE_SCHEMA_VERSION,
      blocked: lockoutUntil > timestamp || quarantineUntil > timestamp,
      locked: lockoutUntil > timestamp,
      quarantined: quarantineUntil > timestamp,
      lockoutUntil: lockoutUntil > timestamp ? new Date(lockoutUntil).toISOString() : null,
      quarantineUntil: quarantineUntil > timestamp ? new Date(quarantineUntil).toISOString() : null,
    });
  }

  function recordFailure({
    tenantId,
    subjectType,
    subject,
    channel = 'login',
    reason = 'authentication-failure',
    now = undefined,
  } = {}) {
    const timestamp = now === undefined ? nowMilliseconds(clock) : nowMilliseconds(now, 'now');
    assertChannel(channel);
    assertString(reason, 'reason', SAFE_REASON_PATTERN, 128);
    const key = subjectKey(tenantId, subjectType, subject);
    const current = failures.get(key);
    const bucket = current && timestamp - current.startedAt < policy.failureWindowMs
      ? current
      : { startedAt: timestamp, count: 0 };
    bucket.count += 1;
    failures.set(key, bucket);
    const locked = bucket.count >= policy.failureThreshold;
    const quarantined = bucket.count >= policy.quarantineThreshold;
    if (locked) lockouts.set(key, timestamp + policy.lockoutMs);
    if (quarantined) quarantines.set(key, timestamp + policy.quarantineMs);
    const outcome = quarantined ? 'quarantined' : locked ? 'locked' : 'rejected';
    const event = createAbuseAuditEvent({
      action: 'abuse.failure',
      channel,
      outcome,
      tenantId,
      subjectType,
      subject,
      reason,
      details: { count: bucket.count, threshold: policy.failureThreshold },
      occurredAt: timestamp,
    });
    return Object.freeze({
      allowed: false,
      count: bucket.count,
      locked,
      quarantined,
      lockoutUntil: locked ? new Date(timestamp + policy.lockoutMs).toISOString() : null,
      quarantineUntil: quarantined ? new Date(timestamp + policy.quarantineMs).toISOString() : null,
      audit: emit(event),
    });
  }

  function recordSuccess({ tenantId, subjectType, subject, channel = 'login', now = undefined } = {}) {
    const timestamp = now === undefined ? nowMilliseconds(clock) : nowMilliseconds(now, 'now');
    assertChannel(channel);
    const key = subjectKey(tenantId, subjectType, subject);
    failures.delete(key);
    lockouts.delete(key);
    const event = createAbuseAuditEvent({
      action: 'abuse.recovery',
      channel,
      outcome: 'released',
      tenantId,
      subjectType,
      subject,
      reason: 'authenticated-success',
      occurredAt: timestamp,
    });
    return Object.freeze({ cleared: true, audit: emit(event) });
  }

  function quarantineSubject({ tenantId, subjectType, subject, channel = 'api', durationMs = policy.quarantineMs, reason = 'operator-quarantine', now = undefined } = {}) {
    const timestamp = now === undefined ? nowMilliseconds(clock) : nowMilliseconds(now, 'now');
    assertChannel(channel);
    assertInteger(durationMs, 'durationMs', 1_000, 7 * 86_400_000);
    assertString(reason, 'reason', SAFE_REASON_PATTERN, 128);
    const key = subjectKey(tenantId, subjectType, subject);
    quarantines.set(key, timestamp + durationMs);
    const event = createAbuseAuditEvent({
      action: 'abuse.quarantine',
      channel,
      outcome: 'quarantined',
      tenantId,
      subjectType,
      subject,
      reason,
      details: { durationMs },
      occurredAt: timestamp,
    });
    return Object.freeze({ quarantined: true, quarantineUntil: new Date(timestamp + durationMs).toISOString(), audit: emit(event) });
  }

  function releaseSubject({ tenantId, subjectType, subject, channel = 'api', reason = 'operator-release', now = undefined } = {}) {
    const timestamp = now === undefined ? nowMilliseconds(clock) : nowMilliseconds(now, 'now');
    assertChannel(channel);
    assertString(reason, 'reason', SAFE_REASON_PATTERN, 128);
    const key = subjectKey(tenantId, subjectType, subject);
    quarantines.delete(key);
    lockouts.delete(key);
    failures.delete(key);
    const event = createAbuseAuditEvent({
      action: 'abuse.release',
      channel,
      outcome: 'released',
      tenantId,
      subjectType,
      subject,
      reason,
      occurredAt: timestamp,
    });
    return Object.freeze({ released: true, audit: emit(event) });
  }

  function check({ channel, tenantId, ipAddress = null, sessionId = null, userId = null, now = undefined, cost = 1 } = {}) {
    const identity = normalizeRateIdentity({ tenantId, ipAddress, sessionId });
    const candidates = [
      ['tenant', identity.tenantId],
      ['ip', identity.ipAddress],
      ['session', identity.sessionId],
      ['user', userId === null ? null : assertId(userId, 'userId')],
    ].filter(([, value]) => value !== null);
    const blockedBy = [];
    for (const [subjectType, subject] of candidates) {
      const state = status({ tenantId: identity.tenantId, subjectType, subject, now });
      if (state.blocked) blockedBy.push(subjectType);
    }
    if (blockedBy.length > 0) {
      return Object.freeze({ schemaVersion: ABUSE_SCHEMA_VERSION, allowed: false, reason: 'lockout-or-quarantine', blockedBy: Object.freeze(blockedBy) });
    }
    return limiter.consume({ channel, ...identity, now, cost });
  }

  return Object.freeze({
    check,
    recordFailure,
    recordSuccess,
    quarantineSubject,
    releaseSubject,
    status,
    limiter,
    lockoutPolicy: policy,
  });
}

function readEnvironment(environment, key) {
  if (Array.isArray(environment)) {
    const arrayEntry = environment.find((value) => typeof value === 'string' && value.startsWith(`${key}=`));
    return arrayEntry === undefined ? undefined : arrayEntry.slice(key.length + 1);
  }
  if (isPlainObject(environment) && Object.hasOwn(environment, key)) return environment[key];
  return undefined;
}

function nonEmptyEnvironment(environment, key) {
  const value = readEnvironment(environment, key);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isUnsafeHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  if (LOOPBACK_HOSTS.has(normalized) || normalized.endsWith('.internal') || PLACEHOLDER_HOST_PATTERN.test(normalized)) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 0
      || octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] === 0)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19))
      || octets[0] >= 224;
  }
  if (ipVersion === 6) return normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  return false;
}

function validateExternalHost(value, field) {
  if (value === null) return { field, code: 'REQUIRED_HOST_MISSING', message: `${field} is required` };
  let parsed;
  try {
    parsed = field.endsWith('_URL') ? new URL(value) : null;
  } catch {
    return { field, code: 'HOST_INVALID', message: `${field} must be a valid endpoint` };
  }
  const hostname = parsed?.hostname ?? value;
  if (typeof hostname !== 'string' || hostname.length === 0 || !HOST_REFERENCE_PATTERN.test(hostname) || isUnsafeHost(hostname)) {
    return { field, code: 'HOST_INVALID', message: `${field} must point to a configured external host` };
  }
  if (parsed && !['ldap:', 'ldaps:', 'https:'].includes(parsed.protocol)) {
    return { field, code: 'HOST_PROTOCOL_INVALID', message: `${field} uses an unsupported protocol` };
  }
  return null;
}

function validateSecretReference(environment, service, field, declaredSecrets) {
  const value = nonEmptyEnvironment(environment, field);
  if (value === null) return { field, code: 'REQUIRED_SECRET_REFERENCE_MISSING', message: `${field} is required` };
  if (!SECRET_REFERENCE_PATTERN.test(value) || /[=\s]/u.test(value)) {
    return { field, code: 'SECRET_VALUE_FORBIDDEN', message: `${field} must be a secret reference, not secret material` };
  }
  if (declaredSecrets !== null && !declaredSecrets.has(value) && !declaredSecrets.has(field)) {
    return { field, code: 'SECRET_NOT_DECLARED', message: `${field} does not resolve to a declared deployment secret` };
  }
  return null;
}

function collectDeclaredSecrets(compose) {
  const declared = new Set();
  const topLevel = compose.secrets;
  if (isPlainObject(topLevel)) Object.keys(topLevel).forEach((key) => declared.add(key));
  const serviceSecrets = compose.services?.gulogulo?.secrets;
  if (Array.isArray(serviceSecrets)) {
    serviceSecrets.forEach((entry) => {
      if (typeof entry === 'string') declared.add(entry);
      else if (isPlainObject(entry) && typeof entry.source === 'string') declared.add(entry.source);
    });
  }
  return declared;
}

function normalizeComposeService(compose, serviceName) {
  assertPlainObject(compose, 'compose');
  assertPlainObject(compose.services, 'compose.services');
  const service = compose.services[serviceName];
  assertPlainObject(service, `compose.services.${serviceName}`);
  return service;
}

function parseCpu(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  const millicpu = value.match(/^(\d+)m$/u);
  return millicpu ? Number(millicpu[1]) / 1000 : null;
}

function parseMemoryBytes(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([KMGTP]i?B?)?$/iu);
  if (!match) return null;
  const multipliers = { k: 1024, ki: 1024, kb: 1000, m: 1024 ** 2, mi: 1024 ** 2, mb: 1000 ** 2, g: 1024 ** 3, gi: 1024 ** 3, gb: 1000 ** 3, t: 1024 ** 4, ti: 1024 ** 4, tb: 1000 ** 4, pib: 1024 ** 5 };
  const suffix = (match[2] ?? '').toLowerCase();
  return Number(match[1]) * (multipliers[suffix] ?? 1);
}

function composeResourceLimits(service) {
  const limits = service.deploy?.resources?.limits ?? {};
  return {
    cpus: parseCpu(limits.cpus ?? service.cpus),
    memoryBytes: parseMemoryBytes(limits.memory ?? service.mem_limit),
    pids: limits.pids ?? service.pids_limit,
  };
}

function addReadinessError(errors, code, field, message) {
  errors.push(Object.freeze({ code, field, message }));
}

/**
 * Validate a production Compose object without returning environment values,
 * secret values, image contents, or mounted volume data.
 */
export function validateComposeProductionReadiness({
  compose,
  serviceName = 'gulogulo',
  requiredExternalHosts = ['LDAP_URL', 'POSTGRES_HOST'],
  requiredSecretReferences = ['LDAP_BIND_SECRET_REF', 'POSTGRES_DSN_SECRET_REF'],
  requiredExternalVolumes = REQUIRED_EXTERNAL_VOLUMES,
  requireExternalSecrets = true,
  checkedAt = new Date(),
} = {}) {
  const service = normalizeComposeService(compose, serviceName);
  const environment = service.environment ?? {};
  const errors = [];
  const warnings = [];
  const appEnvironment = nonEmptyEnvironment(environment, 'APP_ENV') ?? nonEmptyEnvironment(environment, 'GULOGULO_ENV');
  if (appEnvironment !== 'production') addReadinessError(errors, 'PRODUCTION_ENV_REQUIRED', 'APP_ENV', 'production environment is required');
  const composeUser = service.user;
  const composeUserText = composeUser === undefined || composeUser === null ? '' : String(composeUser);
  const [composeUid, composeGid] = composeUserText.split(':', 2);
  if (composeUser === undefined || composeUser === null || composeUser === '' || composeUser === 0 || composeUserText === '0' || composeUserText === 'root' || composeUid === '0' || composeGid === '0') {
    addReadinessError(errors, 'NON_ROOT_USER_REQUIRED', 'services.user', 'the service must run as a non-root user');
  }
  if (service.privileged === true) addReadinessError(errors, 'PRIVILEGED_FORBIDDEN', 'services.privileged', 'privileged mode is forbidden');
  if (service.read_only !== true) addReadinessError(errors, 'READ_ONLY_REQUIRED', 'services.read_only', 'production service filesystem must be read-only');
  if (service.network_mode === 'host' || service.pid === 'host') addReadinessError(errors, 'HOST_NAMESPACE_FORBIDDEN', 'services.namespace', 'host namespaces are forbidden');
  if (Array.isArray(service.cap_add) && service.cap_add.length > 0) addReadinessError(errors, 'CAPABILITIES_FORBIDDEN', 'services.cap_add', 'cap_add must be empty');
  if (!Array.isArray(service.cap_drop) || !service.cap_drop.some((capability) => String(capability).toUpperCase() === 'ALL')) {
    addReadinessError(errors, 'CAP_DROP_ALL_REQUIRED', 'services.cap_drop', 'ALL capabilities must be dropped');
  }
  if (!Array.isArray(service.security_opt) || !service.security_opt.some((option) => option === 'no-new-privileges:true')) {
    addReadinessError(errors, 'NO_NEW_PRIVILEGES_REQUIRED', 'services.security_opt', 'no-new-privileges must be enabled');
  }
  if (service.devices !== undefined && Array.isArray(service.devices) && service.devices.length > 0) addReadinessError(errors, 'DEVICES_FORBIDDEN', 'services.devices', 'device passthrough is forbidden');
  if (Array.isArray(service.volumes) && service.volumes.some((volume) => {
    const source = typeof volume === 'string' ? volume.split(':', 1)[0] : volume?.source;
    const target = typeof volume === 'string' ? volume.split(':')[1] : volume?.target;
    return source === '/var/run/docker.sock' || target === '/var/run/docker.sock';
  })) addReadinessError(errors, 'DOCKER_SOCKET_FORBIDDEN', 'services.volumes', 'the Docker socket must not be mounted');
  const resourceLimits = composeResourceLimits(service);
  if (resourceLimits.cpus === null || resourceLimits.cpus < 0.25 || resourceLimits.cpus > 8) addReadinessError(errors, 'CPU_LIMIT_REQUIRED', 'services.deploy.resources.limits.cpus', 'CPU limit must be between 0.25 and 8');
  if (resourceLimits.memoryBytes === null || resourceLimits.memoryBytes < 128 * 1024 ** 2 || resourceLimits.memoryBytes > 8 * 1024 ** 3) addReadinessError(errors, 'MEMORY_LIMIT_REQUIRED', 'services.deploy.resources.limits.memory', 'memory limit must be between 128 MiB and 8 GiB');
  if (resourceLimits.pids !== undefined && (!Number.isSafeInteger(Number(resourceLimits.pids)) || Number(resourceLimits.pids) < 64 || Number(resourceLimits.pids) > 4_096)) addReadinessError(errors, 'PIDS_LIMIT_INVALID', 'services.deploy.resources.limits.pids', 'pids limit must be between 64 and 4096');

  const volumes = compose.volumes;
  if (!isPlainObject(volumes)) {
    addReadinessError(errors, 'EXTERNAL_VOLUMES_REQUIRED', 'volumes', 'persistent production volumes must be declared externally');
  } else {
    for (const volumeName of requiredExternalVolumes) {
      if (!isPlainObject(volumes[volumeName]) || volumes[volumeName].external !== true) addReadinessError(errors, 'EXTERNAL_VOLUME_REQUIRED', `volumes.${volumeName}`, 'the user-data volume must be external');
    }
  }

  const declaredSecrets = requireExternalSecrets ? collectDeclaredSecrets(compose) : null;
  const ldapEnabled = ['true', '1', 'yes'].includes((nonEmptyEnvironment(environment, 'LDAP_ENABLED') ?? 'false').toLowerCase());
  const postgresEnabled = ['true', '1', 'yes'].includes((nonEmptyEnvironment(environment, 'POSTGRES_ENABLED') ?? 'false').toLowerCase());
  for (const hostField of requiredExternalHosts) {
    const enabled = hostField.startsWith('LDAP_') ? ldapEnabled : hostField.startsWith('POSTGRES_') ? postgresEnabled : true;
    if (enabled) {
      const hostError = validateExternalHost(nonEmptyEnvironment(environment, hostField), hostField);
      if (hostError) addReadinessError(errors, hostError.code, hostError.field, hostError.message);
    } else {
      warnings.push(Object.freeze({ code: 'DEPENDENCY_DISABLED', field: hostField, message: `${hostField} is not required while its dependency is disabled` }));
    }
  }
  for (const secretField of requiredSecretReferences) {
    const enabled = secretField.startsWith('LDAP_') ? ldapEnabled : secretField.startsWith('POSTGRES_') ? postgresEnabled : true;
    if (enabled) {
      const secretError = validateSecretReference(environment, service, secretField, declaredSecrets);
      if (secretError) addReadinessError(errors, secretError.code, secretError.field, secretError.message);
    } else {
      warnings.push(Object.freeze({ code: 'DEPENDENCY_DISABLED', field: secretField, message: `${secretField} is not required while its dependency is disabled` }));
    }
  }
  const environmentKeys = isPlainObject(environment) ? Object.keys(environment) : [];
  for (const key of environmentKeys) {
    if (SENSITIVE_KEY_PATTERN.test(key) && !/_REF$/u.test(key)) {
      addReadinessError(errors, 'PLAINTEXT_SECRET_FORBIDDEN', `services.environment.${key}`, 'secret material must use a reference');
    }
  }

  return Object.freeze({
    schemaVersion: ABUSE_SCHEMA_VERSION,
    readinessType: 'compose-production',
    serviceName,
    ready: errors.length === 0,
    checkedAt: assertDate(checkedAt, 'checkedAt').toISOString(),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    controls: Object.freeze({
      nonRoot: errors.every((error) => error.code !== 'NON_ROOT_USER_REQUIRED'),
      readOnly: errors.every((error) => error.code !== 'READ_ONLY_REQUIRED'),
      leastPrivilege: errors.every((error) => !['CAPABILITIES_FORBIDDEN', 'CAP_DROP_ALL_REQUIRED', 'NO_NEW_PRIVILEGES_REQUIRED', 'PRIVILEGED_FORBIDDEN', 'HOST_NAMESPACE_FORBIDDEN', 'DEVICES_FORBIDDEN', 'DOCKER_SOCKET_FORBIDDEN'].includes(error.code)),
      resourceBounds: errors.every((error) => !['CPU_LIMIT_REQUIRED', 'MEMORY_LIMIT_REQUIRED', 'PIDS_LIMIT_INVALID'].includes(error.code)),
      persistentVolumes: errors.every((error) => !['EXTERNAL_VOLUMES_REQUIRED', 'EXTERNAL_VOLUME_REQUIRED'].includes(error.code)),
      externalDependencies: errors.every((error) => !['REQUIRED_HOST_MISSING', 'HOST_INVALID', 'HOST_PROTOCOL_INVALID', 'REQUIRED_SECRET_REFERENCE_MISSING', 'SECRET_VALUE_FORBIDDEN', 'SECRET_NOT_DECLARED', 'PLAINTEXT_SECRET_FORBIDDEN'].includes(error.code)),
    }),
  });
}

export { abuseError, digestSubject };
