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
] as const);

export const COMPATIBILITY_WINDOWS = Object.freeze([
  'forward_and_backward',
  'forward_only',
  'contract_only',
] as const);

export type MigrationPhase = typeof MIGRATION_PHASES[number];
export type CompatibilityWindow = typeof COMPATIBILITY_WINDOWS[number];

export interface UpgradeContractError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface SchemaMigrationPlan {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  readonly sourceSchema: string;
  readonly targetSchema: string;
  readonly phases: readonly MigrationPhase[];
  readonly compatibilityWindow: CompatibilityWindow;
  readonly backfillBatchSize: number;
  readonly rollbackWindowSeconds: number;
  readonly destructiveChanges: false;
  readonly rollbackSafe: true;
}

export interface CompatibilityEvaluation {
  readonly sourceVersion: string;
  readonly targetVersion: string;
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly migration: Readonly<SchemaMigrationPlan>;
  readonly bothVersionsReadExpandedSchema: true;
  readonly rollbackKeepsSourceReadable: true;
  readonly contractDeferredUntilFinalize: true;
}

export interface MigrationCheckpoint {
  readonly operationId: string;
  readonly phase: MigrationPhase;
  readonly completedAt: string;
  readonly processedItems: number;
  readonly remainingItems: number;
  readonly forwardCompatible: true;
}

type RecordValue = Record<string, unknown>;

function upgradeError(
  message: string,
  code = 'UPGRADE_CONTRACT_ERROR',
  details?: unknown,
): UpgradeContractError {
  const error = new Error(`Upgrade contract error: ${message}`) as UpgradeContractError;
  // Error instances are mutable at runtime; the public contract exposes the
  // stable string code and an optional shallow-frozen details object.
  (error as { code: string }).code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    (error as { details?: Readonly<Record<string, unknown>> }).details = Object.freeze({
      ...(details as RecordValue),
    });
  }
  return error;
}

function assertPlainObject(value: unknown, field: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw upgradeError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value as RecordValue;
}

function assertAllowedKeys(value: RecordValue, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw upgradeError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw upgradeError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw upgradeError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value as number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function validateVersion(value: unknown, field = 'version'): string {
  return assertString(value, field, VERSION_PATTERN);
}

export function validateDigest(value: unknown, field = 'digest'): string {
  return assertString(value, field, DIGEST_PATTERN);
}

export function validateSchemaIdentifier(value: unknown, field = 'schemaId'): string {
  return assertString(value, field, SAFE_IDENTIFIER_PATTERN);
}

export function validateMigrationPhases(phases: unknown = MIGRATION_PHASES): readonly MigrationPhase[] {
  if (!Array.isArray(phases) || phases.length !== MIGRATION_PHASES.length) {
    throw upgradeError(
      'migration phases must contain expand, backfill, switch, and contract exactly once',
      'INVALID_MIGRATION_PHASES',
    );
  }
  const expected = MIGRATION_PHASES.join('|');
  if (phases.join('|') !== expected) {
    throw upgradeError(
      'migration phases must follow expand -> backfill -> switch -> contract',
      'INVALID_MIGRATION_PHASES',
    );
  }
  return Object.freeze([...phases] as MigrationPhase[]);
}

export function createSchemaMigrationPlan(input: unknown = {}): Readonly<SchemaMigrationPlan> {
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
  const sourceSchema = validateSchemaIdentifier(
    value.sourceSchema ?? `schema-${sourceVersion.replaceAll('.', '-')}`,
    'migration.sourceSchema',
  );
  const targetSchema = validateSchemaIdentifier(
    value.targetSchema ?? `schema-${targetVersion.replaceAll('.', '-')}`,
    'migration.targetSchema',
  );
  if (sourceVersion === targetVersion) {
    throw upgradeError('source and target versions must differ', 'SAME_VERSION');
  }
  const phases = validateMigrationPhases(value.phases ?? MIGRATION_PHASES);
  const backfillBatchSize = assertInteger(
    value.backfillBatchSize ?? 500,
    'migration.backfillBatchSize',
    1,
    100_000,
  );
  const rollbackWindowSeconds = assertInteger(
    value.rollbackWindowSeconds ?? 900,
    'migration.rollbackWindowSeconds',
    60,
    86_400,
  );
  const destructiveChanges = value.destructiveChanges ?? false;
  if (typeof destructiveChanges !== 'boolean') {
    throw upgradeError('migration.destructiveChanges must be a boolean', 'INVALID_CONFIGURATION');
  }
  if (destructiveChanges) {
    throw upgradeError(
      'destructive schema changes are forbidden before the rollback window closes',
      'DESTRUCTIVE_MIGRATION_FORBIDDEN',
    );
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

export function evaluateCompatibility(input: unknown = {}): Readonly<CompatibilityEvaluation> {
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
  const suppliedMigrationValue = value.migration;
  let suppliedMigration: RecordValue | undefined;
  if (suppliedMigrationValue !== undefined) {
    suppliedMigration = assertPlainObject(suppliedMigrationValue, 'compatibility.migration');
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

export function createMigrationCheckpoint(input: unknown = {}): Readonly<MigrationCheckpoint> {
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
  if (!MIGRATION_PHASES.includes(phase as MigrationPhase)) {
    throw upgradeError('checkpoint.phase is not a supported migration phase', 'INVALID_MIGRATION_PHASE');
  }
  const operationId = assertString(value.operationId, 'checkpoint.operationId', SAFE_IDENTIFIER_PATTERN);
  const completedAt = assertString(value.completedAt, 'checkpoint.completedAt');
  const processedItems = assertInteger(
    value.processedItems ?? 0,
    'checkpoint.processedItems',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const remainingItems = assertInteger(
    value.remainingItems ?? 0,
    'checkpoint.remainingItems',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (value.forwardCompatible !== true) {
    throw upgradeError('checkpoint must prove forward compatibility', 'INCOMPATIBLE_CHECKPOINT');
  }
  return Object.freeze({
    operationId,
    phase: phase as MigrationPhase,
    completedAt,
    processedItems,
    remainingItems,
    forwardCompatible: true,
  });
}

export function toPublicCompatibility(value: CompatibilityEvaluation): Readonly<CompatibilityEvaluation> {
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
