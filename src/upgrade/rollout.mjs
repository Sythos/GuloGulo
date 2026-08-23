// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export const CONNECTION_TYPES = Object.freeze([
  'http',
  'websocket',
  'imap_idle',
  'smtp',
  'dav',
]);

export const EXTERNAL_STATE_REFS = Object.freeze([
  'external-postgresql',
  'external-ldap',
  'mail-data',
  'dav-data',
  'backup-data',
  'persistent-mail-queue',
]);

export const DEPLOYMENT_ACTIONS = Object.freeze({
  docker: Object.freeze([
    'docker.prepare_green',
    'edge.cutover_green',
    'connections.drain_blue',
    'edge.rollback_blue',
    'docker.finalize_blue',
  ]),
  kubernetes: Object.freeze([
    'kubernetes.apply_green',
    'kubernetes.wait_ready',
    'kubernetes.inspect_service',
    'kubernetes.cutover_service',
    'connections.drain_blue',
    'kubernetes.rollback_blue',
    'kubernetes.finalize_blue',
  ]),
});

function rolloutError(message, code = 'ROLLOUT_CONTRACT_ERROR', details = undefined) {
  const error = new Error(`Rollout contract error: ${message}`);
  error.code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    error.details = Object.freeze({ ...details });
  }
  return error;
}

function assertPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw rolloutError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw rolloutError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertString(value, field, pattern = undefined) {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw rolloutError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw rolloutError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertBoolean(value, field) {
  if (typeof value !== 'boolean') throw rolloutError(`${field} must be a boolean`, 'INVALID_CONFIGURATION');
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateDigest(value, field) {
  return assertString(value, field, DIGEST_PATTERN);
}

function validateSafeIdentifier(value, field) {
  return assertString(value, field, SAFE_IDENTIFIER_PATTERN);
}

export function createConnectionDrainPlan(input = {}) {
  const value = assertPlainObject(input, 'drain');
  assertAllowedKeys(value, new Set(['gracePeriodSeconds', 'reconnectBaseSeconds', 'connections']), 'drain');
  const gracePeriodSeconds = assertInteger(value.gracePeriodSeconds ?? 60, 'drain.gracePeriodSeconds', 5, 600);
  const reconnectBaseSeconds = assertInteger(value.reconnectBaseSeconds ?? 1, 'drain.reconnectBaseSeconds', 1, 60);
  const connections = assertPlainObject(value.connections ?? {}, 'drain.connections');
  for (const key of Object.keys(connections)) {
    if (!CONNECTION_TYPES.includes(key)) throw rolloutError(`drain.connections.${key} is not supported`, 'INVALID_CONNECTION_TYPE');
    assertInteger(connections[key], `drain.connections.${key}`, 0, 1_000_000);
  }
  const normalizedConnections = Object.fromEntries(CONNECTION_TYPES.map((type) => [type, connections[type] ?? 0]));
  return Object.freeze({
    gracePeriodSeconds,
    reconnectBaseSeconds,
    connections: Object.freeze(normalizedConnections),
    drainOrder: Object.freeze(['websocket', 'imap_idle', 'dav', 'smtp', 'http']),
    reconnectPolicy: 'exponential_backoff_with_jitter',
    eventContinuity: 'resume_from_last_event_id',
    duplicateDeliveryProtection: true,
  });
}

export function createQueueHandoffPlan(input = {}) {
  const value = assertPlainObject(input, 'queue');
  assertAllowedKeys(value, new Set(['queueRef', 'persistent', 'idempotentDelivery', 'maxDrainSeconds']), 'queue');
  const queueRef = validateSafeIdentifier(value.queueRef ?? 'persistent-mail-queue', 'queue.queueRef');
  const persistent = value.persistent ?? true;
  const idempotentDelivery = value.idempotentDelivery ?? true;
  assertBoolean(persistent, 'queue.persistent');
  assertBoolean(idempotentDelivery, 'queue.idempotentDelivery');
  if (!persistent) throw rolloutError('mail queue must remain persistent during cutover', 'QUEUE_NOT_PERSISTENT');
  if (!idempotentDelivery) throw rolloutError('mail delivery must be idempotent during cutover', 'DELIVERY_NOT_IDEMPOTENT');
  return Object.freeze({
    queueRef,
    persistent: true,
    idempotentDelivery: true,
    maxDrainSeconds: assertInteger(value.maxDrainSeconds ?? 300, 'queue.maxDrainSeconds', 30, 3_600),
    handoff: 'shared_queue_reference',
    duplicateProtection: 'delivery-id-and-envelope-deduplication',
  });
}

export function createDockerReplacementPlan(input = {}) {
  const value = assertPlainObject(input, 'docker');
  assertAllowedKeys(value, new Set([
    'projectName',
    'sourceDigest',
    'targetDigest',
    'externalVolumes',
    'sharedState',
    'queue',
    'drain',
  ]), 'docker');
  const projectName = validateSafeIdentifier(value.projectName ?? 'gulogulo', 'docker.projectName');
  const sourceDigest = validateDigest(value.sourceDigest, 'docker.sourceDigest');
  const targetDigest = validateDigest(value.targetDigest, 'docker.targetDigest');
  if (sourceDigest === targetDigest) throw rolloutError('Docker source and target digests must differ', 'SAME_DIGEST');
  const externalVolumes = value.externalVolumes ?? ['runtime-state', 'mail-data', 'dav-data', 'backup-data'];
  if (!Array.isArray(externalVolumes) || externalVolumes.length === 0) {
    throw rolloutError('docker.externalVolumes must contain at least one external volume', 'VOLUMES_REQUIRED');
  }
  const volumes = externalVolumes.map((volume) => validateSafeIdentifier(volume, 'docker.externalVolumes[]'));
  const sharedState = value.sharedState ?? EXTERNAL_STATE_REFS;
  if (!Array.isArray(sharedState) || sharedState.length === 0) throw rolloutError('docker.sharedState is required', 'STATE_REQUIRED');
  if (!sharedState.every((item) => typeof item === 'string' && EXTERNAL_STATE_REFS.includes(item))) {
    throw rolloutError('docker.sharedState contains an unsupported state reference', 'STATE_REFERENCE_FORBIDDEN');
  }
  const queue = createQueueHandoffPlan(value.queue);
  const drain = createConnectionDrainPlan(value.drain);
  return Object.freeze({
    platform: 'docker',
    projectName,
    sourceDigest,
    targetDigest,
    externalVolumes: Object.freeze(volumes),
    sharedState: Object.freeze([...sharedState]),
    mailboxCopy: false,
    queue,
    drain,
    actions: Object.freeze([...DEPLOYMENT_ACTIONS.docker]),
    rollbackReady: true,
  });
}

export function createKubernetesBlueGreenPlan(input = {}) {
  const value = assertPlainObject(input, 'kubernetes');
  assertAllowedKeys(value, new Set([
    'namespace',
    'deploymentPrefix',
    'serviceName',
    'sourceDigest',
    'targetDigest',
    'maxSurge',
    'maxUnavailable',
    'podDisruptionBudgetMinAvailable',
    'terminationGracePeriodSeconds',
    'externalState',
    'queue',
    'drain',
  ]), 'kubernetes');
  const namespace = validateSafeIdentifier(value.namespace ?? 'gulogulo', 'kubernetes.namespace');
  const deploymentPrefix = validateSafeIdentifier(value.deploymentPrefix ?? 'gulogulo', 'kubernetes.deploymentPrefix');
  const serviceName = validateSafeIdentifier(value.serviceName ?? 'gulogulo-web', 'kubernetes.serviceName');
  const sourceDigest = validateDigest(value.sourceDigest, 'kubernetes.sourceDigest');
  const targetDigest = validateDigest(value.targetDigest, 'kubernetes.targetDigest');
  if (sourceDigest === targetDigest) throw rolloutError('Kubernetes source and target digests must differ', 'SAME_DIGEST');
  const maxSurge = assertInteger(value.maxSurge ?? 1, 'kubernetes.maxSurge', 1, 10);
  const maxUnavailable = value.maxUnavailable ?? 0;
  if (maxUnavailable !== 0) throw rolloutError('Kubernetes maxUnavailable must be zero', 'READINESS_POLICY_VIOLATION');
  const podDisruptionBudgetMinAvailable = assertInteger(value.podDisruptionBudgetMinAvailable ?? 1, 'kubernetes.podDisruptionBudgetMinAvailable', 1, 100);
  const terminationGracePeriodSeconds = assertInteger(value.terminationGracePeriodSeconds ?? 60, 'kubernetes.terminationGracePeriodSeconds', 10, 900);
  const externalState = value.externalState ?? EXTERNAL_STATE_REFS;
  if (!Array.isArray(externalState) || !externalState.every((item) => EXTERNAL_STATE_REFS.includes(item))) {
    throw rolloutError('kubernetes.externalState must use approved external state references', 'STATE_REFERENCE_FORBIDDEN');
  }
  const queue = createQueueHandoffPlan(value.queue);
  const drain = createConnectionDrainPlan({
    ...(value.drain ?? {}),
    gracePeriodSeconds: value.drain?.gracePeriodSeconds ?? terminationGracePeriodSeconds,
  });
  return Object.freeze({
    platform: 'kubernetes',
    namespace,
    blueDeployment: `${deploymentPrefix}-blue`,
    greenDeployment: `${deploymentPrefix}-green`,
    serviceName,
    sourceDigest,
    targetDigest,
    readiness: Object.freeze({
      maxUnavailable: 0,
      maxSurge,
      startupProbe: true,
      livenessProbe: true,
      readinessProbe: true,
      podDisruptionBudgetMinAvailable,
      terminationGracePeriodSeconds,
    }),
    externalState: Object.freeze([...externalState]),
    mailboxCopy: false,
    queue,
    drain,
    actions: Object.freeze([...DEPLOYMENT_ACTIONS.kubernetes]),
    rollbackReady: true,
  });
}

export function validateAllowlistedAction(input = {}) {
  const value = assertPlainObject(input, 'action');
  assertAllowedKeys(value, new Set(['platform', 'action', 'namespace', 'resource', 'imageDigest']), 'action');
  if (value.platform !== 'docker' && value.platform !== 'kubernetes') {
    throw rolloutError('action.platform must be docker or kubernetes', 'INVALID_PLATFORM');
  }
  if (!DEPLOYMENT_ACTIONS[value.platform].includes(value.action)) {
    throw rolloutError('deployment action is not allowlisted', 'ACTION_NOT_ALLOWLISTED');
  }
  if (value.platform === 'kubernetes') {
    validateSafeIdentifier(value.namespace, 'action.namespace');
    validateSafeIdentifier(value.resource, 'action.resource');
  }
  if (value.imageDigest !== undefined) validateDigest(value.imageDigest, 'action.imageDigest');
  return Object.freeze({
    platform: value.platform,
    action: value.action,
    namespace: value.namespace,
    resource: value.resource,
    imageDigest: value.imageDigest,
    rawCommand: undefined,
  });
}

export function createPreflightEvidence(input = {}) {
  const value = assertPlainObject(input, 'preflight');
  const allowed = new Set([
    'imageVerified',
    'schemaCompatible',
    'greenReady',
    'dependenciesHealthy',
    'sharedExternalState',
    'queuePersistent',
    'connectionsReconnectable',
    'backupFresh',
    'auditReady',
  ]);
  assertAllowedKeys(value, allowed, 'preflight');
  const evidence = Object.fromEntries([...allowed].map((key) => [key, value[key] ?? false]));
  for (const [key, result] of Object.entries(evidence)) assertBoolean(result, `preflight.${key}`);
  const passed = Object.values(evidence).every(Boolean);
  return Object.freeze({ ...evidence, passed });
}

export function assertPreflightPassed(evidence) {
  if (!evidence || evidence.passed !== true || Object.entries(evidence).some(([key, value]) => key !== 'passed' && value !== true)) {
    throw rolloutError('all preflight gates must pass before green preparation or cutover', 'PREFLIGHT_FAILED');
  }
  return true;
}

export { rolloutError };
