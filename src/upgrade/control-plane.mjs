// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import {
  createMigrationCheckpoint,
  createSchemaMigrationPlan,
  evaluateCompatibility,
  validateDigest,
  validateVersion,
} from './compatibility.mjs';
import {
  assertPreflightPassed,
  createDockerReplacementPlan,
  createKubernetesBlueGreenPlan,
  createPreflightEvidence,
} from './rollout.mjs';

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ACTOR_ROLES = Object.freeze(['provider', 'operator']);
const TENANT_ROLES = Object.freeze(['tenant', 'master', 'user', 'monitor']);

export const CONTROL_PLANE_OPERATIONS = Object.freeze([
  'capabilities',
  'plan',
  'preflight',
  'prepare',
  'status',
  'cutover',
  'rollback',
  'finalize',
]);

export const OPERATION_STATES = Object.freeze([
  'planned',
  'preflight_passed',
  'prepared',
  'serving_green',
  'rolled_back',
  'finalized',
  'failed',
]);

const STATE_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['preflight_passed', 'failed']),
  preflight_passed: Object.freeze(['prepared', 'failed']),
  prepared: Object.freeze(['serving_green', 'rolled_back', 'failed']),
  serving_green: Object.freeze(['rolled_back', 'finalized', 'failed']),
  rolled_back: Object.freeze(['finalized', 'failed']),
  finalized: Object.freeze([]),
  failed: Object.freeze(['rolled_back']),
});

function controlPlaneError(message, code = 'CONTROL_PLANE_ERROR', details = undefined) {
  const error = new Error(`Upgrade control-plane error: ${message}`);
  error.code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) error.details = Object.freeze({ ...details });
  return error;
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw controlPlaneError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw controlPlaneError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertString(value, field, pattern = undefined) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw controlPlaneError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw controlPlaneError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultOperationId(sequence) {
  return `upgrade-${String(sequence).padStart(6, '0')}`;
}

function requireOperator(actor) {
  const value = assertPlainObject(actor, 'actor');
  assertAllowedKeys(value, new Set(['role', 'actorId', 'providerId', 'tenantId']), 'actor');
  if (!ACTOR_ROLES.includes(value.role)) {
    const code = TENANT_ROLES.includes(value.role) ? 'TENANT_CONTROL_PLANE_FORBIDDEN' : 'OPERATOR_ROLE_REQUIRED';
    throw controlPlaneError('provider/operator role is required for upgrade execution', code);
  }
  const actorId = assertString(value.actorId, 'actor.actorId', SAFE_IDENTIFIER_PATTERN);
  const providerId = assertString(value.providerId, 'actor.providerId', SAFE_IDENTIFIER_PATTERN);
  return Object.freeze({ role: value.role, actorId, providerId, tenantId: value.tenantId });
}

function transition(operation, nextState) {
  if (!STATE_TRANSITIONS[operation.state].includes(nextState)) {
    throw controlPlaneError(`cannot move operation from ${operation.state} to ${nextState}`, 'INVALID_STATE_TRANSITION');
  }
  operation.state = nextState;
  operation.updatedAt = operation.clock();
}

function publicOperation(operation) {
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

function auditEntry(operation, action, result, reason = undefined) {
  const event = {
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
  };
  if (reason) event.reason = reason;
  operation.audit.push(Object.freeze(event));
}

export function createUpgradeRequest(input = {}) {
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
    platform: value.platform,
    strategy: 'blue_green',
    deadlineSeconds,
    idempotencyKey,
    migration,
  });
}

export function createUpgradeController(options = {}) {
  const value = assertPlainObject(options, 'controller');
  assertAllowedKeys(value, new Set(['clock', 'operationIdFactory']), 'controller');
  const clock = typeof value.clock === 'function' ? value.clock : () => new Date().toISOString();
  let sequence = 0;
  const operationIdFactory = typeof value.operationIdFactory === 'function'
    ? value.operationIdFactory
    : () => defaultOperationId(++sequence);
  const operations = new Map();
  const idempotency = new Map();

  function capabilities() {
    return Object.freeze({
      api: Object.freeze({ tenantMonitoringReadOnly: true, providerControlPlane: true }),
      mcp: Object.freeze({ tenantMonitoringReadOnly: true, providerControlPlane: true }),
      operations: Object.freeze([...CONTROL_PLANE_OPERATIONS]),
      platforms: Object.freeze(['docker', 'kubernetes']),
      strategy: 'blue_green',
      externalState: Object.freeze([
        'external PostgreSQL',
        'external LDAP',
        'mail-data',
        'dav-data',
        'backup-data',
        'persistent mail queue',
      ]),
      arbitraryDockerSocket: false,
      arbitraryShell: false,
      unrestrictedKubectl: false,
    });
  }

  function plan({ actor, request }) {
    const normalizedActor = requireOperator(actor);
    const normalizedRequest = createUpgradeRequest(request);
    const existingId = idempotency.get(normalizedRequest.idempotencyKey);
    if (existingId) {
      const existing = operations.get(existingId);
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
    const operation = {
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

  function get(operationId) {
    const id = assertString(operationId, 'operationId', SAFE_IDENTIFIER_PATTERN);
    const operation = operations.get(id);
    if (!operation) throw controlPlaneError('operation was not found', 'OPERATION_NOT_FOUND');
    return operation;
  }

  function preflight({ actor, operationId, evidence }) {
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

  function prepare({ actor, operationId, deployment = {} }) {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    if (operation.state !== 'preflight_passed') throw controlPlaneError('preflight must pass before preparation', 'PREFLIGHT_REQUIRED');
    assertPreflightPassed(operation.preflight);
    operation.rollout = operation.platform === 'docker'
      ? createDockerReplacementPlan({
        ...deployment,
        sourceDigest: operation.source.digest,
        targetDigest: operation.target.digest,
      })
      : createKubernetesBlueGreenPlan({
        ...deployment,
        sourceDigest: operation.source.digest,
        targetDigest: operation.target.digest,
      });
    transition(operation, 'prepared');
    auditEntry(operation, 'prepared', 'accepted');
    return publicOperation(operation);
  }

  function status({ actor, operationId }) {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    return publicOperation(operation);
  }

  function cutover({ actor, operationId, greenReady = false, observationWindowSeconds = 900 }) {
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

  function rollback({ actor, operationId, reason }) {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    const rollbackReason = assertString(reason, 'reason');
    if (!['prepared', 'serving_green', 'failed'].includes(operation.state)) {
      throw controlPlaneError('rollback is available only after preparation or a failed rollout', 'ROLLBACK_NOT_AVAILABLE');
    }
    transition(operation, 'rolled_back');
    operation.rollbackReason = rollbackReason;
    auditEntry(operation, 'rollback', 'accepted', rollbackReason);
    return publicOperation(operation);
  }

  function finalize({ actor, operationId, observationWindowComplete = false, restoreCheckPassed = false }) {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    if (!['serving_green', 'rolled_back'].includes(operation.state)) throw controlPlaneError('operation is not ready for finalization', 'FINALIZE_NOT_AVAILABLE');
    if (observationWindowComplete !== true || restoreCheckPassed !== true) {
      throw controlPlaneError('observation window and restore check are required before finalization', 'FINALIZE_GATES_REQUIRED');
    }
    transition(operation, 'finalized');
    operation.rollbackReady = false;
    auditEntry(operation, 'finalize', 'accepted');
    return publicOperation(operation);
  }

  function checkpoint({ actor, operationId, checkpoint }) {
    const normalizedActor = requireOperator(actor);
    const operation = get(operationId);
    if (operation.actor.providerId !== normalizedActor.providerId) throw controlPlaneError('provider scope mismatch', 'PROVIDER_SCOPE_DENIED');
    const result = createMigrationCheckpoint({ operationId, ...checkpoint });
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
