// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const MAX_POLICY_BYTES = 1_099_511_627_776;
const SIZE_PATTERN = /^([1-9]\d*)(b|k|kb|kib|m|mb|mib|g|gb|gib)$/i;
const MODE_VALUES = Object.freeze(['docker-json-file', 'journald', 'sidecar']);
const AUDIT_SINK_VALUES = Object.freeze(['external', 'journald', 'sidecar']);

const SIZE_MULTIPLIERS = Object.freeze({
  b: 1,
  k: 1_000,
  kb: 1_000,
  kib: 1_024,
  m: 1_000_000,
  mb: 1_000_000,
  mib: 1_048_576,
  g: 1_000_000_000,
  gb: 1_000_000_000,
  gib: 1_073_741_824,
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value);
}

function integer(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

/**
 * Parse a bounded byte-size value. Decimal Docker suffixes (`m`, `g`) and
 * binary suffixes (`mib`, `gib`) are accepted, but zero and unbounded values
 * are intentionally rejected.
 */
export function parseByteSize(value, name = 'Byte size') {
  if (Number.isSafeInteger(value)) {
    return integer(value, name, { maximum: MAX_POLICY_BYTES });
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a positive byte count or size string`);
  }

  const match = value.trim().match(SIZE_PATTERN);
  if (match === null) {
    throw new TypeError(`${name} must use a positive B, K, KiB, M, MiB, G, or GiB suffix`);
  }

  const bytes = Number(match[1]) * SIZE_MULTIPLIERS[match[2].toLowerCase()];
  if (!Number.isSafeInteger(bytes) || bytes > MAX_POLICY_BYTES) {
    throw new RangeError(`${name} is outside the supported bounded range`);
  }

  return bytes;
}

function dockerSize(bytes) {
  const units = [
    [1_000_000_000, 'g'],
    [1_000_000, 'm'],
    [1_000, 'k'],
  ];

  for (const [multiplier, suffix] of units) {
    if (bytes >= multiplier && bytes % multiplier === 0) {
      return `${bytes / multiplier}${suffix}`;
    }
  }

  return `${bytes}b`;
}

function normalizeMode(mode) {
  if (!MODE_VALUES.includes(mode)) {
    throw new TypeError(`Log rotation mode must be one of: ${MODE_VALUES.join(', ')}`);
  }

  return mode;
}

function normalizeAuditSink(sink) {
  if (!AUDIT_SINK_VALUES.includes(sink)) {
    throw new TypeError(`Audit sink must be one of: ${AUDIT_SINK_VALUES.join(', ')}`);
  }

  return sink;
}

function normalizeJournald(options) {
  const maxUseBytes = parseByteSize(options.maxUse ?? '1g', 'Journald maxUse');
  const maxFileBytes = parseByteSize(options.maxFile ?? '100m', 'Journald maxFile');
  if (maxFileBytes > maxUseBytes) {
    throw new RangeError('Journald maxFile cannot exceed maxUse');
  }

  return {
    max_use_bytes: maxUseBytes,
    max_file_bytes: maxFileBytes,
    max_retention_days: options.retentionDays,
    forward_to_audit: true,
  };
}

function normalizeSidecar(options) {
  const name = options.name ?? 'gulogulo-log-collector';
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{0,62}$/u.test(name)) {
    throw new TypeError('Sidecar name must be a short container-safe identifier');
  }

  return {
    name,
    max_size_bytes: parseByteSize(options.maxSize ?? '10m', 'Sidecar maxSize'),
    max_files: integer(options.maxFiles ?? 5, 'Sidecar maxFiles', { maximum: 100 }),
    compress: options.compress ?? true,
    forward_to_audit: true,
  };
}

/**
 * Create the bounded log policy used by a container deployment.
 *
 * Applications write one sanitized JSON record per line to stdout/stderr.
 * Rotation is owned by Docker, journald, or a dedicated sidecar; the
 * application never truncates an active audit stream itself.
 */
export function createLogRotationPolicy({
  mode = 'docker-json-file',
  maxSize = '10m',
  maxFiles = 5,
  retentionDays = 28,
  maxRecordBytes = 256 * 1024,
  compress = true,
  auditRetentionDays = 365,
  auditSink = 'external',
  journald = {},
  sidecar = {},
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const maxSizeBytes = parseByteSize(maxSize, 'Log maxSize');
  const normalizedMaxFiles = integer(maxFiles, 'Log maxFiles', { maximum: 100 });
  const normalizedRetentionDays = integer(retentionDays, 'Log retentionDays', { maximum: 3_650 });
  const normalizedMaxRecordBytes = parseByteSize(maxRecordBytes, 'Log maxRecordBytes');
  const normalizedAuditRetentionDays = integer(
    auditRetentionDays,
    'Audit retentionDays',
    { maximum: 36_500 },
  );

  if (normalizedMaxRecordBytes > maxSizeBytes) {
    throw new RangeError('Log maxRecordBytes cannot exceed Log maxSize');
  }
  if (normalizedAuditRetentionDays < normalizedRetentionDays) {
    throw new RangeError('Audit retention must be at least as long as local log retention');
  }
  if (typeof compress !== 'boolean') {
    throw new TypeError('Log compression must be boolean');
  }

  const normalizedAuditSink = normalizeAuditSink(auditSink);
  const policy = {
    application_stream: 'stdout/stderr',
    mode: normalizedMode,
    bounded: true,
    max_size_bytes: maxSizeBytes,
    max_files: normalizedMaxFiles,
    retention_days: normalizedRetentionDays,
    max_record_bytes: normalizedMaxRecordBytes,
    compress,
    audit: {
      preserve: true,
      retention_days: normalizedAuditRetentionDays,
      sink: normalizedAuditSink,
      content_excluded: true,
    },
    docker: null,
    journald: null,
    sidecar: null,
  };

  if (normalizedMode === 'docker-json-file') {
    policy.docker = {
      driver: 'json-file',
      options: {
        'max-size': dockerSize(maxSizeBytes),
        'max-file': String(normalizedMaxFiles),
        compress: String(compress),
      },
    };
  }

  if (normalizedMode === 'journald') {
    policy.journald = normalizeJournald({
      ...journald,
      retentionDays: normalizedRetentionDays,
    });
  }

  if (normalizedMode === 'sidecar') {
    policy.sidecar = normalizeSidecar({
      ...sidecar,
      maxSize,
      maxFiles: normalizedMaxFiles,
      compress,
    });
  }

  return deepFreeze(policy);
}

export function assertLogRotationPolicy(policy) {
  if (policy === null || typeof policy !== 'object' || policy.bounded !== true) {
    throw new TypeError('A bounded log rotation policy is required');
  }
  if (!MODE_VALUES.includes(policy.mode)) {
    throw new TypeError('Unsupported log rotation mode');
  }
  parseByteSize(policy.max_size_bytes, 'Policy max_size_bytes');
  integer(policy.max_files, 'Policy max_files', { maximum: 100 });
  integer(policy.retention_days, 'Policy retention_days', { maximum: 3_650 });
  if (policy.audit?.preserve !== true || policy.audit.content_excluded !== true) {
    throw new TypeError('Audit preservation and content exclusion are mandatory');
  }
  integer(policy.audit.retention_days, 'Policy audit retention_days', { maximum: 36_500 });
  if (policy.audit.retention_days < policy.retention_days) {
    throw new RangeError('Audit retention cannot be shorter than local retention');
  }

  return true;
}

export const LOG_ROTATION_MODES = MODE_VALUES;
export const AUDIT_SINKS = AUDIT_SINK_VALUES;
