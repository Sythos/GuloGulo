// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}(?:[-+][0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const MIGRATION_PHASES = Object.freeze([
  'expand',
  'backfill',
  'switch',
  'contract',
]);

export const COMPATIBILITY_WINDOWS = Object.freeze([
  'forward_and_backward',
  'forward_only',
  'contract_only',
]);

function upgradeError(message, code = 'UPGRADE_CONTRACT_ERROR', details = undefined) {
  const error = new Error(`Upgrade contract error: ${message}`);
  error.code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    error.details = Object.freeze({ ...details });
  }
  return error;
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw upgradeError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw upgradeError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertString(value, field, pattern = undefined) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw upgradeError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw upgradeError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validateVersion(value, field = 'version') {
  return assertString(value, field, VERSION_PATTERN);
}

export function validateDigest(value, field = 'digest') {
  return assertString(value, field, DIGEST_PATTERN);
}

export function validateSchemaIdentifier(value, field = 'schemaId') {
  return assertString(value, field, SAFE_IDENTIFIER_PATTERN);
}

export function validateMigrationPhases(phases = MIGRATION_PHASES) {
  if (!Array.isArray(phases) || phases.length !== MIGRATION_PHASES.length) {
    throw upgradeError('migration phases must contain expand, backfill, switch, and contract exactly once', 'INVALID_MIGRATION_PHASES');
  }
  const expected = MIGRATION_PHASES.join('|');
  if (phases.join('|') !== expected) {
    throw upgradeError('migration phases must follow expand -> backfill -> switch -> contract', 'INVALID_MIGRATION_PHASES');
  }
  return Object.freeze([...phases]);
}

export function createSchemaMigrationPlan(input = {}) {
  const value = assertPlainObject(input, 'migration');
  assertAllowedKeys(value, new Set([
    'sourceVersion',
    'targetVersion',
    'sourceSchema',
    'targetSchema',
    'phases',
    'backfillBatchSize',
    'rollbackWindowSeconds',
    'destructiveChanges',
  ]), 'migration');

  const sourceVersion = validateVersion(value.sourceVersion, 'migration.sourceVersion');
  const targetVersion = validateVersion(value.targetVersion, 'migration.targetVersion');
  const sourceSchema = validateSchemaIdentifier(value.sourceSchema ?? `schema-${sourceVersion.replaceAll('.', '-')}`, 'migration.sourceSchema');
  const targetSchema = validateSchemaIdentifier(value.targetSchema ?? `schema-${targetVersion.replaceAll('.', '-')}`, 'migration.targetSchema');
  if (sourceVersion === targetVersion) {
    throw upgradeError('source and target versions must differ', 'SAME_VERSION');
  }
  const phases = validateMigrationPhases(value.phases ?? MIGRATION_PHASES);
  const backfillBatchSize = assertInteger(value.backfillBatchSize ?? 500, 'migration.backfillBatchSize', 1, 100_000);
  const rollbackWindowSeconds = assertInteger(value.rollbackWindowSeconds ?? 900, 'migration.rollbackWindowSeconds', 60, 86_400);
  const destructiveChanges = value.destructiveChanges ?? false;
  if (typeof destructiveChanges !== 'boolean') {
    throw upgradeError('migration.destructiveChanges must be a boolean', 'INVALID_CONFIGURATION');
  }
  if (destructiveChanges) {
    throw upgradeError('destructive schema changes are forbidden before the rollback window closes', 'DESTRUCTIVE_MIGRATION_FORBIDDEN');
  }

  return Object.freeze({
    sourceVersion,
    targetVersion,
    sourceSchema,
    targetSchema,
    phases,
    compatibilityWindow: COMPATIBILITY_WINDOWS[0],
    backfillBatchSize,
    rollbackWindowSeconds,
    destructiveChanges: false,
    rollbackSafe: true,
  });
}

export function evaluateCompatibility(input = {}) {
  const value = assertPlainObject(input, 'compatibility');
  assertAllowedKeys(value, new Set([
    'sourceVersion',
    'targetVersion',
    'sourceDigest',
    'targetDigest',
    'sourceSchema',
    'targetSchema',
    'migration',
  ]), 'compatibility');
  const sourceVersion = validateVersion(value.sourceVersion, 'compatibility.sourceVersion');
  const targetVersion = validateVersion(value.targetVersion, 'compatibility.targetVersion');
  const sourceDigest = validateDigest(value.sourceDigest, 'compatibility.sourceDigest');
  const targetDigest = validateDigest(value.targetDigest, 'compatibility.targetDigest');
  if (sourceDigest === targetDigest) {
    throw upgradeError('source and target image digests must differ', 'SAME_DIGEST');
  }
  const suppliedMigration = value.migration;
  if (suppliedMigration !== undefined) {
    assertPlainObject(suppliedMigration, 'compatibility.migration');
    assertAllowedKeys(suppliedMigration, new Set([
      'sourceVersion',
      'targetVersion',
      'sourceSchema',
      'targetSchema',
      'phases',
      'backfillBatchSize',
      'rollbackWindowSeconds',
      'destructiveChanges',
      'compatibilityWindow',
      'rollbackSafe',
    ]), 'compatibility.migration');
  }
  const migration = createSchemaMigrationPlan({
    sourceVersion,
    targetVersion,
    sourceSchema: value.sourceSchema ?? suppliedMigration?.sourceSchema,
    targetSchema: value.targetSchema ?? suppliedMigration?.targetSchema,
    phases: suppliedMigration?.phases,
    backfillBatchSize: suppliedMigration?.backfillBatchSize,
    rollbackWindowSeconds: suppliedMigration?.rollbackWindowSeconds,
    destructiveChanges: suppliedMigration?.destructiveChanges,
  });
  return Object.freeze({
    sourceVersion,
    targetVersion,
    sourceDigest,
    targetDigest,
    migration,
    bothVersionsReadExpandedSchema: true,
    rollbackKeepsSourceReadable: true,
    contractDeferredUntilFinalize: true,
  });
}

export function createMigrationCheckpoint(input = {}) {
  const value = assertPlainObject(input, 'checkpoint');
  assertAllowedKeys(value, new Set([
    'operationId',
    'phase',
    'completedAt',
    'processedItems',
    'remainingItems',
    'forwardCompatible',
  ]), 'checkpoint');
  const phase = assertString(value.phase, 'checkpoint.phase');
  if (!MIGRATION_PHASES.includes(phase)) {
    throw upgradeError('checkpoint.phase is not a supported migration phase', 'INVALID_MIGRATION_PHASE');
  }
  const operationId = assertString(value.operationId, 'checkpoint.operationId', SAFE_IDENTIFIER_PATTERN);
  const completedAt = assertString(value.completedAt, 'checkpoint.completedAt');
  const processedItems = assertInteger(value.processedItems ?? 0, 'checkpoint.processedItems', 0, Number.MAX_SAFE_INTEGER);
  const remainingItems = assertInteger(value.remainingItems ?? 0, 'checkpoint.remainingItems', 0, Number.MAX_SAFE_INTEGER);
  if (value.forwardCompatible !== true) {
    throw upgradeError('checkpoint must prove forward compatibility', 'INCOMPATIBLE_CHECKPOINT');
  }
  return Object.freeze({
    operationId,
    phase,
    completedAt,
    processedItems,
    remainingItems,
    forwardCompatible: true,
  });
}

export function toPublicCompatibility(value) {
  return clone({
    sourceVersion: value.sourceVersion,
    targetVersion: value.targetVersion,
    sourceDigest: value.sourceDigest,
    targetDigest: value.targetDigest,
    migration: value.migration,
    bothVersionsReadExpandedSchema: value.bothVersionsReadExpandedSchema,
    rollbackKeepsSourceReadable: value.rollbackKeepsSourceReadable,
    contractDeferredUntilFinalize: value.contractDeferredUntilFinalize,
  });
}

export { upgradeError };
