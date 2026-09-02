// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

export const PATCH_STATUS_SCHEMA_VERSION = 1 as const;

export const PATCH_STATUS_STATES = Object.freeze([
  'unknown',
  'checking',
  'updates_available',
  'applying',
  'current',
  'failed',
] as const);

export const PATCH_STATUS_REASONS = Object.freeze([
  'status_unavailable',
  'invalid_status',
  'patch_failed',
  'apt_update_failed',
  'apt_check_failed',
  'apt_apply_failed',
] as const);

export type PatchStatusState = typeof PATCH_STATUS_STATES[number];
export type PatchStatusReason = typeof PATCH_STATUS_REASONS[number];

export interface PatchStatusDto {
  readonly schemaVersion: typeof PATCH_STATUS_SCHEMA_VERSION;
  readonly state: PatchStatusState;
  readonly checkedAt?: string;
  readonly updatedAt?: string;
  readonly baseImage?: string;
  readonly nodeVersion?: string;
  readonly reason?: PatchStatusReason;
}

type PatchStatusRecord = Record<string, unknown>;

const PATCH_STATUS_STATE_SET = new Set<string>(PATCH_STATUS_STATES);
const PATCH_STATUS_REASON_SET = new Set<string>(PATCH_STATUS_REASONS);
const SAFE_METADATA_PATTERN = /^[A-Za-z0-9._:+/-]{1,255}$/u;

function isPlainObject(value: unknown): value is PatchStatusRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const normalized = date.toISOString();
  return value === normalized || value === normalized.replace('.000Z', 'Z');
}

function isSafeMetadata(value: unknown): value is string {
  return typeof value === 'string' && SAFE_METADATA_PATTERN.test(value);
}

function unknownPatchStatus(reason: Extract<PatchStatusReason, 'status_unavailable' | 'invalid_status'>): PatchStatusDto {
  return Object.freeze({
    schemaVersion: PATCH_STATUS_SCHEMA_VERSION,
    state: 'unknown',
    reason,
  });
}

/**
 * Convert decoded patch state into the public, read-only DTO. Unknown fields,
 * command output, and unrecognized error strings are deliberately discarded.
 */
export function sanitizePatchStatus(value: unknown): PatchStatusDto {
  if (value === null || value === undefined) return unknownPatchStatus('status_unavailable');
  if (!isPlainObject(value) || value.schemaVersion !== PATCH_STATUS_SCHEMA_VERSION) {
    return unknownPatchStatus('invalid_status');
  }

  const state = typeof value.state === 'string' && PATCH_STATUS_STATE_SET.has(value.state)
    ? value.state as PatchStatusState
    : null;
  if (state === null) return unknownPatchStatus('invalid_status');

  const result: {
    schemaVersion: typeof PATCH_STATUS_SCHEMA_VERSION;
    state: PatchStatusState;
    checkedAt?: string;
    updatedAt?: string;
    baseImage?: string;
    nodeVersion?: string;
    reason?: PatchStatusReason;
  } = {
    schemaVersion: PATCH_STATUS_SCHEMA_VERSION,
    state,
  };

  if (isCanonicalTimestamp(value.checkedAt)) result.checkedAt = value.checkedAt;
  if (isCanonicalTimestamp(value.updatedAt)) result.updatedAt = value.updatedAt;
  if (isSafeMetadata(value.baseImage)) result.baseImage = value.baseImage;
  if (isSafeMetadata(value.nodeVersion)) result.nodeVersion = value.nodeVersion;

  const reason = typeof value.reason === 'string' && PATCH_STATUS_REASON_SET.has(value.reason)
    ? value.reason as PatchStatusReason
    : undefined;
  if (state === 'failed') result.reason = reason ?? 'patch_failed';
  if (state === 'unknown') result.reason = reason === 'status_unavailable' || reason === 'invalid_status'
    ? reason
    : 'status_unavailable';

  return Object.freeze(result);
}

/** Parse an optional JSON status file without exposing malformed content. */
export function parsePatchStatus(serialized: string | null | undefined): PatchStatusDto {
  if (serialized === null || serialized === undefined) return unknownPatchStatus('status_unavailable');
  try {
    return sanitizePatchStatus(JSON.parse(serialized) as unknown);
  } catch {
    return unknownPatchStatus('invalid_status');
  }
}
