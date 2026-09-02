// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import {
  type CompatibilityEvaluation,
  type MigrationCheckpoint,
  type SchemaMigrationPlan,
  createMigrationCheckpoint,
  createSchemaMigrationPlan,
  evaluateCompatibility,
  validateDigest,
  validateVersion,
} from './compatibility.ts';
import {
  type DockerReplacementPlan,
  type KubernetesBlueGreenPlan,
  type PreflightEvidence,
  assertPreflightPassed,
  createDockerReplacementPlan,
  createKubernetesBlueGreenPlan,
  createPreflightEvidence,
} from './rollout.ts';

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const ACTOR_ROLES = Object.freeze(['provider', 'operator'] as const);
const TENANT_ROLES = Object.freeze(['tenant', 'master', 'user', 'monitor'] as const);

export const CONTROL_PLANE_OPERATIONS = Object.freeze([
  'capabilities',
  'plan',
  'preflight',
  'prepare',
  'status',
  'cutover',
  'rollback',
  'finalize',
] as const);

export const OPERATION_STATES = Object.freeze([
  'planned',
  'preflight_passed',
  'prepared',
  'serving_green',
  'rolled_back',
  'finalized',
  'failed',
] as const);

export type ActorRole = typeof ACTOR_ROLES[number];
export type TenantRole = typeof TENANT_ROLES[number];
export type ControlPlaneOperation = typeof CONTROL_PLANE_OPERATIONS[number];
export type OperationState = typeof OPERATION_STATES[number];
export type UpgradePlatform = 'docker' | 'kubernetes';

const STATE_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = Object.freeze({
  planned: Object.freeze(['preflight_passed', 'failed'] as const),
  preflight_passed: Object.freeze(['prepared', 'failed'] as const),
  prepared: Object.freeze(['serving_green', 'rolled_back', 'failed'] as const),
  serving_green: Object.freeze(['rolled_back', 'finalized', 'failed'] as const),
  rolled_back: Object.freeze(['finalized', 'failed'] as const),
  finalized: Object.freeze([] as const),
  failed: Object.freeze(['rolled_back'] as const),
});

export interface ControlPlaneError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface UpgradeActor {
  readonly role: ActorRole;
  readonly actorId: string;
  readonly providerId: string;
  readonly tenantId?: unknown;
}

export interface UpgradeRequest {
  readonly sourceVersion: string;
  readonly sourceDigest: string;
  readonly targetVersion: string;
  readonly targetDigest: string;
  readonly platform: UpgradePlatform;
  readonly strategy: 'blue_green';
  readonly deadlineSeconds: number;
  readonly idempotencyKey: string;
  readonly migration: Readonly<SchemaMigrationPlan>;
}

export interface ImageReference {
  readonly version: string;
  readonly digest: string;
}

export type RolloutPlan = Readonly<DockerReplacementPlan> | Readonly<KubernetesBlueGreenPlan>;

export type AuditResult = 'accepted' | 'rejected';

export interface UpgradeAuditEvent {
  readonly event: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly actorId: string;
  readonly providerId: string;
  readonly platform: UpgradePlatform;
  readonly sourceVersion: string;
  readonly targetVersion: string;
  readonly result: AuditResult;
  readonly at: string;
  readonly reason?: string;
}

export interface PublicUpgradeOperation {
  readonly operationId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly state: OperationState;
  readonly source: Readonly<ImageReference>;
  readonly target: Readonly<ImageReference>;
  readonly platform: UpgradePlatform;
  readonly strategy: 'blue_green';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly preflight?: Readonly<PreflightEvidence>;
  readonly compatibility: Readonly<CompatibilityEvaluation>;
  readonly rollbackReady: boolean;
  readonly deadlineSeconds: number;
  readonly rollout?: RolloutPlan;
  readonly checkpoint?: Readonly<MigrationCheckpoint>;
  readonly observationWindowSeconds?: number;
  readonly rollbackReason?: string;
  readonly audit: readonly UpgradeAuditEvent[];
}

export interface UpgradeCapabilities {
  readonly api: Readonly<{
    readonly tenantMonitoringReadOnly: true;
    readonly providerControlPlane: true;
  }>;
  readonly mcp: Readonly<{
    readonly tenantMonitoringReadOnly: true;
    readonly providerControlPlane: true;
  }>;
  readonly operations: readonly ControlPlaneOperation[];
  readonly platforms: readonly UpgradePlatform[];
  readonly strategy: 'blue_green';
  readonly externalState: readonly string[];
  readonly arbitraryDockerSocket: false;
  readonly arbitraryShell: false;
  readonly unrestrictedKubectl: false;
}

export type Clock = () => string;
export type OperationIdFactory = (request: Readonly<UpgradeRequest>) => string;

export interface UpgradeControllerOptions {
  readonly clock?: Clock;
  readonly operationIdFactory?: OperationIdFactory;
}

export interface PlanInput {
  readonly actor: unknown;
  readonly request: unknown;
}

export interface PreflightInput {
  readonly actor: unknown;
  readonly operationId: unknown;
  readonly evidence: unknown;
}

export interface PrepareInput {
  readonly actor: unknown;
  readonly operationId: unknown;
  readonly deployment?: unknown;
}

export interface StatusInput {
  readonly actor: unknown;
  readonly operationId: unknown;
}

export interface CutoverInput {
  readonly actor: unknown;
  readonly operationId: unknown;
  readonly greenReady?: boolean;
  readonly observationWindowSeconds?: number;
}

export interface RollbackInput {
  readonly actor: unknown;
  readonly operationId: unknown;
  readonly reason: unknown;
}

export interface FinalizeInput {
  readonly actor: unknown;
  readonly operationId: unknown;
  readonly observationWindowComplete?: boolean;
  readonly restoreCheckPassed?: boolean;
}

export interface CheckpointInput {
  readonly actor: unknown;
  readonly operationId: unknown;
  readonly checkpoint: unknown;
}

export interface UpgradeController {
  readonly capabilities: () => Readonly<UpgradeCapabilities>;
  readonly plan: (input: PlanInput) => Readonly<PublicUpgradeOperation>;
  readonly preflight: (input: PreflightInput) => Readonly<PublicUpgradeOperation>;
  readonly prepare: (input: PrepareInput) => Readonly<PublicUpgradeOperation>;
  readonly status: (input: StatusInput) => Readonly<PublicUpgradeOperation>;
  readonly cutover: (input: CutoverInput) => Readonly<PublicUpgradeOperation>;
  readonly rollback: (input: RollbackInput) => Readonly<PublicUpgradeOperation>;
  readonly finalize: (input: FinalizeInput) => Readonly<PublicUpgradeOperation>;
  readonly checkpoint: (input: CheckpointInput) => Readonly<PublicUpgradeOperation>;
}

type RecordValue = Record<string, unknown>;

interface UpgradeOperation {
  operationId: string;
  correlationId: string;
  idempotencyKey: string;
  actor: Readonly<UpgradeActor>;
  source: ImageReference;
  target: ImageReference;
  platform: UpgradePlatform;
  strategy: 'blue_green';
  deadlineSeconds: number;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  clock: Clock;
  compatibility: Readonly<CompatibilityEvaluation>;
  migration: Readonly<SchemaMigrationPlan>;
  preflight?: Readonly<PreflightEvidence>;
  rollout?: RolloutPlan;
  rollbackReady: boolean;
  checkpoint?: Readonly<MigrationCheckpoint>;
  observationWindowSeconds?: number;
  rollbackReason?: string;
  audit: UpgradeAuditEvent[];
}

function controlPlaneError(
  message: string,
  code = 'CONTROL_PLANE_ERROR',
  details?: unknown,
): ControlPlaneError {
  const error = new Error(`Upgrade control-plane error: ${message}`) as ControlPlaneError;
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
    throw controlPlaneError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value as RecordValue;
}

function assertAllowedKeys(value: RecordValue, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw controlPlaneError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw controlPlaneError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw controlPlaneError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value as number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultOperationId(sequence: number): string {
  return `upgrade-${String(sequence).padStart(6, '0')}`;
}

function requireOperator(actor: unknown): Readonly<UpgradeActor> {
  const value = assertPlainObject(actor, 'actor');
  assertAllowedKeys(value, new Set(['role', 'actorId', 'providerId', 'tenantId']), 'actor');
  if (!(ACTOR_ROLES as readonly string[]).includes(value.role as string)) {
    const code = (TENANT_ROLES as readonly string[]).includes(value.role as string)
      ? 'TENANT_CONTROL_PLANE_FORBIDDEN'
      : 'OPERATOR_ROLE_REQUIRED';
    throw controlPlaneError('provider/operator role is required for upgrade execution', code);
  }
  const role = value.role as ActorRole;
  const actorId = assertString(value.actorId, 'actor.actorId', SAFE_IDENTIFIER_PATTERN);
  const providerId = assertString(value.providerId, 'actor.providerId', SAFE_IDENTIFIER_PATTERN);
  return Object.freeze({ role, actorId, providerId, tenantId: value.tenantId });
}

function transition(operation: UpgradeOperation, nextState: OperationState): void {
  if (!STATE_TRANSITIONS[operation.state].includes(nextState)) {
    throw controlPlaneError(`cannot move operation from ${operation.state} to ${nextState}`, 'INVALID_STATE_TRANSITION');
  }
  operation.state = nextState;
  operation.updatedAt = operation.clock();
}

function publicOperation(operation: UpgradeOperation): Readonly<PublicUpgradeOperation> {
  return clone({
    operationId: operation.operationId,
    correlationId: operation.correlationId,
    idempotencyKey: operation.idempotencyKey,
    state: operation.state,
    source: operation.source,
    target: operation.target,
    platform: operation.platform,
    strategy: operation.strategy,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    preflight: operation.preflight,
    compatibility: operation.compatibility,
    rollbackReady: operation.rollbackReady,
    deadlineSeconds: operation.deadlineSeconds,
    rollout: operation.rollout,
    checkpoint: operation.checkpoint,
    observationWindowSeconds: operation.observationWindowSeconds,
    rollbackReason: operation.rollbackReason,
    audit: operation.audit,
  });
}

function auditEntry(
  operation: UpgradeOperation,
  action: string,
  result: AuditResult,
  reason?: string,
): void {
  const event: UpgradeAuditEvent = {
    event: `upgrade.${action}`,
    operationId: operation.operationId,
    correlationId: operation.correlationId,
    actorId: operation.actor.actorId,
    providerId: operation.actor.providerId,
    platform: operation.platform,
    sourceVersion: operation.source.version,
    targetVersion: operation.target.version,
    result,
    at: operation.clock(),
    ...(reason ? { reason } : {}),
  };
  operation.audit.push(Object.freeze(event));
}

export function createUpgradeRequest(input: unknown = {}): Readonly<UpgradeRequest> {
  const value = assertPlainObject(input, 'request');
  assertAllowedKeys(value, new Set([
    'sourceVersion',
    'sourceDigest',
    'targetVersion',
    'targetDigest',
    'platform',
    'strategy',
    'deadlineSeconds',
    'idempotencyKey',
    'sourceSchema',
    'targetSchema',
    'backfillBatchSize',
    'rollbackWindowSeconds',
  ]), 'request');
  const sourceVersion = validateVersion(value.sourceVersion, 'request.sourceVersion');
  const targetVersion = validateVersion(value.targetVersion, 'request.targetVersion');
  const sourceDigest = validateDigest(value.sourceDigest, 'request.sourceDigest');
  const targetDigest = validateDigest(value.targetDigest, 'request.targetDigest');
  if (sourceVersion === targetVersion || sourceDigest === targetDigest) {
    throw controlPlaneError('source and target must differ', 'SAME_SOURCE_AND_TARGET');
  }
  if (value.platform !== 'docker' && value.platform !== 'kubernetes') {
    throw controlPlaneError('request.platform must be docker or kubernetes', 'INVALID_PLATFORM');
  }
  const platform = value.platform as UpgradePlatform;
  if (value.strategy !== undefined && value.strategy !== 'blue_green') {
    throw controlPlaneError('only the blue_green strategy is supported', 'INVALID_STRATEGY');
  }
  const deadlineSeconds = assertInteger(value.deadlineSeconds ?? 1_800, 'request.deadlineSeconds', 60, 7_200);
  const idempotencyKey = assertString(value.idempotencyKey, 'request.idempotencyKey', SAFE_IDENTIFIER_PATTERN);
  const migration = createSchemaMigrationPlan({
    sourceVersion,
    targetVersion,
    sourceSchema: value.sourceSchema,
    targetSchema: value.targetSchema,
    backfillBatchSize: value.backfillBatchSize,
    rollbackWindowSeconds: value.rollbackWindowSeconds,
  });
  return Object.freeze({
    sourceVersion,
    sourceDigest,
    targetVersion,
    targetDigest,
    platform,
    strategy: 'blue_green' as const,
    deadlineSeconds,
    idempotencyKey,
    migration,
  });
}

export function createUpgradeController(options: unknown = {}): Readonly<UpgradeController> {
  const value = assertPlainObject(options, 'controller');
  assertAllowedKeys(value, new Set(['clock', 'operationIdFactory']), 'controller');
  const clock: Clock = typeof value.clock === 'function'
    ? value.clock as Clock
    : () => new Date().toISOString();
  let sequence = 0;
  const operationIdFactory: OperationIdFactory = typeof value.operationIdFactory === 'function'
    ? value.operationIdFactory as OperationIdFactory
    : () => defaultOperationId(++sequence);
  const operations = new Map<string, UpgradeOperation>();
  const idempotency = new Map<string, string>();

  function capabilities(): Readonly<UpgradeCapabilities> {
    return Object.freeze({
      api: Object.freeze({ tenantMonitoringReadOnly: true as const, providerControlPlane: true as const }),
      mcp: Object.freeze({ tenantMonitoringReadOnly: true as const, providerControlPlane: true as const }),
      operations: Object.freeze([...CONTROL_PLANE_OPERATIONS]),
      platforms: Object.freeze(['docker', 'kubernetes'] as const),
      strategy: 'blue_green' as const,
      externalState: Object.freeze([
        'external PostgreSQL',
        'external LDAP',
        'mail-data',
        'dav-data',
        'backup-data',
        'persistent mail queue',
      ]),
      arbitraryDockerSocket: false as const,
      arbitraryShell: false as const,
      unrestrictedKubectl: false as const,
    });
  }

  function plan({ actor, request }: PlanInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const normalizedRequest = createUpgradeRequest(request);
    const existingId = idempotency.get(normalizedRequest.idempotencyKey);
    if (existingId) {
      const existing = operations.get(existingId);
      // The map is private and only populated together with the operation, but
      // preserve a defensive error if an implementation invariant is broken.
      if (existing === undefined) throw controlPlaneError('operation was not found', 'OPERATION_NOT_FOUND');
      const sameTarget = existing.target.version === normalizedRequest.targetVersion
        && existing.target.digest === normalizedRequest.targetDigest
        && existing.source.version === normalizedRequest.sourceVersion
        && existing.source.digest === normalizedRequest.sourceDigest;
      if (!sameTarget) throw controlPlaneError('idempotency key is already bound to another target', 'IDEMPOTENCY_CONFLICT');
      return publicOperation(existing);
    }
    const operationId = assertString(operationIdFactory(normalizedRequest), 'operationId', SAFE_IDENTIFIER_PATTERN);
    if (operations.has(operationId)) throw controlPlaneError('operation ID already exists', 'OPERATION_ID_CONFLICT');
    const compatibility = evaluateCompatibility({
      sourceVersion: normalizedRequest.sourceVersion,
      targetVersion: normalizedRequest.targetVersion,
      sourceDigest: normalizedRequest.sourceDigest,
      targetDigest: normalizedRequest.targetDigest,
      migration: normalizedRequest.migration,
    });
    const operation: UpgradeOperation = {
      operationId,
      correlationId: `corr-${operationId}`,
      idempotencyKey: normalizedRequest.idempotencyKey,
      actor: normalizedActor,
      source: { version: normalizedRequest.sourceVersion, digest: normalizedRequest.sourceDigest },
      target: { version: normalizedRequest.targetVersion, digest: normalizedRequest.targetDigest },
      platform: normalizedRequest.platform,
      strategy: normalizedRequest.strategy,
      deadlineSeconds: normalizedRequest.deadlineSeconds,
      state: 'planned',
      createdAt: clock(),
      updatedAt: clock(),
      clock,
      compatibility,
      migration: normalizedRequest.migration,
      preflight: undefined,
      rollout: undefined,
      rollbackReady: true,
      audit: [],
    };
    operations.set(operationId, operation);
    idempotency.set(normalizedRequest.idempotencyKey, operationId);
    auditEntry(operation, 'planned', 'accepted');
    return publicOperation(operation);
  }

  function get(operationId: unknown): UpgradeOperation {
    const id = assertString(operationId, 'operationId', SAFE_IDENTIFIER_PATTERN);
    const operation = operations.get(id);
    if (operation === undefined) throw controlPlaneError('operation was not found', 'OPERATION_NOT_FOUND');
    return operation;
  }

  function preflight({ actor, operationId, evidence }: PreflightInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    const result = createPreflightEvidence(evidence);
    if (!result.passed) {
      operation.preflight = result;
      operation.state = 'failed';
      auditEntry(operation, 'preflight', 'rejected', 'PREFLIGHT_FAILED');
      throw controlPlaneError('preflight failed', 'PREFLIGHT_FAILED');
    }
    transition(operation, 'preflight_passed');
    operation.preflight = result;
    auditEntry(operation, 'preflight', 'accepted');
    return publicOperation(operation);
  }

  function prepare({ actor, operationId, deployment = {} }: PrepareInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    if (operation.state !== 'preflight_passed') throw controlPlaneError('preflight must pass before preparation', 'PREFLIGHT_REQUIRED');
    assertPreflightPassed(operation.preflight);
    operation.rollout = operation.platform === 'docker'
      ? createDockerReplacementPlan({
        ...(deployment as object),
        sourceDigest: operation.source.digest,
        targetDigest: operation.target.digest,
      })
      : createKubernetesBlueGreenPlan({
        ...(deployment as object),
        sourceDigest: operation.source.digest,
        targetDigest: operation.target.digest,
      });
    transition(operation, 'prepared');
    auditEntry(operation, 'prepared', 'accepted');
    return publicOperation(operation);
  }

  function status({ actor, operationId }: StatusInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    return publicOperation(operation);
  }

  function cutover({ actor, operationId, greenReady = false, observationWindowSeconds = 900 }: CutoverInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    if (operation.state !== 'prepared') throw controlPlaneError('green must be prepared before cutover', 'PREPARE_REQUIRED');
    if (greenReady !== true) throw controlPlaneError('green readiness is required before cutover', 'GREEN_NOT_READY');
    assertInteger(observationWindowSeconds, 'observationWindowSeconds', 60, 86_400);
    transition(operation, 'serving_green');
    operation.observationWindowSeconds = observationWindowSeconds;
    auditEntry(operation, 'cutover', 'accepted');
    return publicOperation(operation);
  }

  function rollback({ actor, operationId, reason }: RollbackInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    const rollbackReason = assertString(reason, 'reason');
    if (!(['prepared', 'serving_green', 'failed'] as OperationState[]).includes(operation.state)) {
      throw controlPlaneError('rollback is available only after preparation or a failed rollout', 'ROLLBACK_NOT_AVAILABLE');
    }
    transition(operation, 'rolled_back');
    operation.rollbackReason = rollbackReason;
    auditEntry(operation, 'rollback', 'accepted', rollbackReason);
    return publicOperation(operation);
  }

  function finalize({ actor, operationId, observationWindowComplete = false, restoreCheckPassed = false }: FinalizeInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    if (!(['serving_green', 'rolled_back'] as OperationState[]).includes(operation.state)) throw controlPlaneError('operation is not ready for finalization', 'FINALIZE_NOT_AVAILABLE');
    if (observationWindowComplete !== true || restoreCheckPassed !== true) {
      throw controlPlaneError('observation window and restore check are required before finalization', 'FINALIZE_GATES_REQUIRED');
    }
    transition(operation, 'finalized');
    operation.rollbackReady = false;
    auditEntry(operation, 'finalize', 'accepted');
    return publicOperation(operation);
  }

  function checkpoint({ actor, operationId, checkpoint: input }: CheckpointInput): Readonly<PublicUpgradeOperation> {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    const result = createMigrationCheckpoint({ operationId, ...(input as object) });
    operation.checkpoint = result;
    auditEntry(operation, 'checkpoint', 'accepted');
    return publicOperation(operation);
  }

  return Object.freeze({
    capabilities,
    plan,
    preflight,
    prepare,
    status,
    cutover,
    rollback,
    finalize,
    checkpoint,
  });
}

export { ACTOR_ROLES, TENANT_ROLES, controlPlaneError };
