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
] as const);

export const EXTERNAL_STATE_REFS = Object.freeze([
  'external-postgresql',
  'external-ldap',
  'mail-data',
  'dav-data',
  'backup-data',
  'persistent-mail-queue',
] as const);

export const DEPLOYMENT_ACTIONS = Object.freeze({
  docker: Object.freeze([
    'docker.prepare_green',
    'edge.cutover_green',
    'connections.drain_blue',
    'edge.rollback_blue',
    'docker.finalize_blue',
  ] as const),
  kubernetes: Object.freeze([
    'kubernetes.apply_green',
    'kubernetes.wait_ready',
    'kubernetes.inspect_service',
    'kubernetes.cutover_service',
    'connections.drain_blue',
    'kubernetes.rollback_blue',
    'kubernetes.finalize_blue',
  ] as const),
} as const);

export type ConnectionType = typeof CONNECTION_TYPES[number];
export type ExternalStateRef = typeof EXTERNAL_STATE_REFS[number];
export type DeploymentPlatform = keyof typeof DEPLOYMENT_ACTIONS;
export type DockerDeploymentAction = typeof DEPLOYMENT_ACTIONS.docker[number];
export type KubernetesDeploymentAction = typeof DEPLOYMENT_ACTIONS.kubernetes[number];
export type DeploymentAction = DockerDeploymentAction | KubernetesDeploymentAction;

export interface ConnectionDrainPlan {
  readonly gracePeriodSeconds: number;
  readonly reconnectBaseSeconds: number;
  readonly connections: Readonly<Record<ConnectionType, number>>;
  readonly drainOrder: readonly ConnectionType[];
  readonly reconnectPolicy: 'exponential_backoff_with_jitter';
  readonly eventContinuity: 'resume_from_last_event_id';
  readonly duplicateDeliveryProtection: true;
}

export interface QueueHandoffPlan {
  readonly queueRef: string;
  readonly persistent: true;
  readonly idempotentDelivery: true;
  readonly maxDrainSeconds: number;
  readonly handoff: 'shared_queue_reference';
  readonly duplicateProtection: 'delivery-id-and-envelope-deduplication';
}

export interface DockerReplacementPlan {
  readonly platform: 'docker';
  readonly projectName: string;
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly externalVolumes: readonly string[];
  readonly sharedState: readonly ExternalStateRef[];
  readonly mailboxCopy: false;
  readonly queue: Readonly<QueueHandoffPlan>;
  readonly drain: Readonly<ConnectionDrainPlan>;
  readonly actions: readonly DockerDeploymentAction[];
  readonly rollbackReady: true;
}

export interface KubernetesReadinessPlan {
  readonly maxUnavailable: 0;
  readonly maxSurge: number;
  readonly startupProbe: true;
  readonly livenessProbe: true;
  readonly readinessProbe: true;
  readonly podDisruptionBudgetMinAvailable: number;
  readonly terminationGracePeriodSeconds: number;
}

export interface KubernetesBlueGreenPlan {
  readonly platform: 'kubernetes';
  readonly namespace: string;
  readonly blueDeployment: string;
  readonly greenDeployment: string;
  readonly serviceName: string;
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly readiness: Readonly<KubernetesReadinessPlan>;
  readonly externalState: readonly ExternalStateRef[];
  readonly mailboxCopy: false;
  readonly queue: Readonly<QueueHandoffPlan>;
  readonly drain: Readonly<ConnectionDrainPlan>;
  readonly actions: readonly KubernetesDeploymentAction[];
  readonly rollbackReady: true;
}

export interface AllowlistedActionResult {
  readonly platform: DeploymentPlatform;
  readonly action: DeploymentAction;
  readonly namespace: unknown;
  readonly resource: unknown;
  readonly imageDigest: string | undefined;
  readonly rawCommand: undefined;
}

const PREFLIGHT_GATES = Object.freeze([
  'imageVerified',
  'schemaCompatible',
  'greenReady',
  'dependenciesHealthy',
  'sharedExternalState',
  'queuePersistent',
  'connectionsReconnectable',
  'backupFresh',
  'auditReady',
] as const);

export type PreflightGate = typeof PREFLIGHT_GATES[number];

export interface PreflightEvidence {
  readonly imageVerified: boolean;
  readonly schemaCompatible: boolean;
  readonly greenReady: boolean;
  readonly dependenciesHealthy: boolean;
  readonly sharedExternalState: boolean;
  readonly queuePersistent: boolean;
  readonly connectionsReconnectable: boolean;
  readonly backupFresh: boolean;
  readonly auditReady: boolean;
  readonly passed: boolean;
}

type RecordValue = Record<string, unknown>;

function rolloutError(
  message: string,
  code = 'ROLLOUT_CONTRACT_ERROR',
  details?: unknown,
): Error & { code: string; details?: Readonly<Record<string, unknown>> } {
  const error = new Error(`Rollout contract error: ${message}`) as Error & {
    code: string;
    details?: Readonly<Record<string, unknown>>;
  };
  error.code = code;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    error.details = Object.freeze({ ...(details as RecordValue) });
  }
  return error;
}

function assertPlainObject(value: unknown, field: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw rolloutError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value as RecordValue;
}

function assertAllowedKeys(value: RecordValue, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw rolloutError(`${field}.${key} is not supported`, 'UNKNOWN_CONFIGURATION');
  }
}

function assertString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    throw rolloutError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function assertInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw rolloutError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value as number;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw rolloutError(`${field} must be a boolean`, 'INVALID_CONFIGURATION');
  return value;
}

function validateDigest(value: unknown, field: string): string {
  return assertString(value, field, DIGEST_PATTERN);
}

function validateSafeIdentifier(value: unknown, field: string): string {
  return assertString(value, field, SAFE_IDENTIFIER_PATTERN);
}

export function createConnectionDrainPlan(input: unknown = {}): Readonly<ConnectionDrainPlan> {
  const value = assertPlainObject(input, 'drain');
  assertAllowedKeys(value, new Set(['gracePeriodSeconds', 'reconnectBaseSeconds', 'connections']), 'drain');
  const gracePeriodSeconds = assertInteger(value.gracePeriodSeconds ?? 60, 'drain.gracePeriodSeconds', 5, 600);
  const reconnectBaseSeconds = assertInteger(value.reconnectBaseSeconds ?? 1, 'drain.reconnectBaseSeconds', 1, 60);
  const connections = assertPlainObject(value.connections ?? {}, 'drain.connections');
  for (const key of Object.keys(connections)) {
    if (!(CONNECTION_TYPES as readonly string[]).includes(key)) {
      throw rolloutError(`drain.connections.${key} is not supported`, 'INVALID_CONNECTION_TYPE');
    }
    assertInteger(connections[key], `drain.connections.${key}`, 0, 1_000_000);
  }
  const normalizedConnections = Object.fromEntries(
    CONNECTION_TYPES.map((type) => [type, connections[type] ?? 0]),
  ) as Record<ConnectionType, number>;
  return Object.freeze({
    gracePeriodSeconds,
    reconnectBaseSeconds,
    connections: Object.freeze(normalizedConnections),
    drainOrder: Object.freeze(['websocket', 'imap_idle', 'dav', 'smtp', 'http'] as ConnectionType[]),
    reconnectPolicy: 'exponential_backoff_with_jitter' as const,
    eventContinuity: 'resume_from_last_event_id' as const,
    duplicateDeliveryProtection: true as const,
  });
}

export function createQueueHandoffPlan(input: unknown = {}): Readonly<QueueHandoffPlan> {
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
    persistent: true as const,
    idempotentDelivery: true as const,
    maxDrainSeconds: assertInteger(value.maxDrainSeconds ?? 300, 'queue.maxDrainSeconds', 30, 3_600),
    handoff: 'shared_queue_reference' as const,
    duplicateProtection: 'delivery-id-and-envelope-deduplication' as const,
  });
}

export function createDockerReplacementPlan(input: unknown = {}): Readonly<DockerReplacementPlan> {
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
  const volumes = externalVolumes.map((volume: unknown) => validateSafeIdentifier(volume, 'docker.externalVolumes[]'));
  const sharedState = value.sharedState ?? EXTERNAL_STATE_REFS;
  if (!Array.isArray(sharedState) || sharedState.length === 0) {
    throw rolloutError('docker.sharedState is required', 'STATE_REQUIRED');
  }
  if (!sharedState.every((item: unknown) => (
    typeof item === 'string' && (EXTERNAL_STATE_REFS as readonly string[]).includes(item)
  ))) {
    throw rolloutError('docker.sharedState contains an unsupported state reference', 'STATE_REFERENCE_FORBIDDEN');
  }
  const normalizedSharedState = sharedState as ExternalStateRef[];
  const queue = createQueueHandoffPlan(value.queue);
  const drain = createConnectionDrainPlan(value.drain);
  return Object.freeze({
    platform: 'docker' as const,
    projectName,
    sourceDigest,
    targetDigest,
    externalVolumes: Object.freeze(volumes),
    sharedState: Object.freeze([...normalizedSharedState]),
    mailboxCopy: false as const,
    queue,
    drain,
    actions: Object.freeze([...DEPLOYMENT_ACTIONS.docker]),
    rollbackReady: true as const,
  });
}

export function createKubernetesBlueGreenPlan(input: unknown = {}): Readonly<KubernetesBlueGreenPlan> {
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
  const podDisruptionBudgetMinAvailable = assertInteger(
    value.podDisruptionBudgetMinAvailable ?? 1,
    'kubernetes.podDisruptionBudgetMinAvailable',
    1,
    100,
  );
  const terminationGracePeriodSeconds = assertInteger(
    value.terminationGracePeriodSeconds ?? 60,
    'kubernetes.terminationGracePeriodSeconds',
    10,
    900,
  );
  const externalState = value.externalState ?? EXTERNAL_STATE_REFS;
  if (!Array.isArray(externalState) || !externalState.every((item: unknown) => (
    typeof item === 'string' && (EXTERNAL_STATE_REFS as readonly string[]).includes(item)
  ))) {
    throw rolloutError('kubernetes.externalState must use approved external state references', 'STATE_REFERENCE_FORBIDDEN');
  }
  const normalizedExternalState = externalState as ExternalStateRef[];
  const queue = createQueueHandoffPlan(value.queue);
  const drain = createConnectionDrainPlan({
    ...((value.drain ?? {}) as object),
    gracePeriodSeconds: (value.drain as { gracePeriodSeconds?: unknown } | null | undefined)?.gracePeriodSeconds
      ?? terminationGracePeriodSeconds,
  });
  return Object.freeze({
    platform: 'kubernetes' as const,
    namespace,
    blueDeployment: `${deploymentPrefix}-blue`,
    greenDeployment: `${deploymentPrefix}-green`,
    serviceName,
    sourceDigest,
    targetDigest,
    readiness: Object.freeze({
      maxUnavailable: 0 as const,
      maxSurge,
      startupProbe: true as const,
      livenessProbe: true as const,
      readinessProbe: true as const,
      podDisruptionBudgetMinAvailable,
      terminationGracePeriodSeconds,
    }),
    externalState: Object.freeze([...normalizedExternalState]),
    mailboxCopy: false as const,
    queue,
    drain,
    actions: Object.freeze([...DEPLOYMENT_ACTIONS.kubernetes]),
    rollbackReady: true as const,
  });
}

export function validateAllowlistedAction(input: unknown = {}): Readonly<AllowlistedActionResult> {
  const value = assertPlainObject(input, 'action');
  assertAllowedKeys(value, new Set(['platform', 'action', 'namespace', 'resource', 'imageDigest']), 'action');
  if (value.platform !== 'docker' && value.platform !== 'kubernetes') {
    throw rolloutError('action.platform must be docker or kubernetes', 'INVALID_PLATFORM');
  }
  const platform = value.platform;
  const actions = DEPLOYMENT_ACTIONS[platform] as readonly string[];
  if (!actions.includes(value.action as string)) {
    throw rolloutError('deployment action is not allowlisted', 'ACTION_NOT_ALLOWLISTED');
  }
  if (platform === 'kubernetes') {
    validateSafeIdentifier(value.namespace, 'action.namespace');
    validateSafeIdentifier(value.resource, 'action.resource');
  }
  let imageDigest: string | undefined;
  if (value.imageDigest !== undefined) imageDigest = validateDigest(value.imageDigest, 'action.imageDigest');
  return Object.freeze({
    platform,
    action: value.action as DeploymentAction,
    namespace: value.namespace,
    resource: value.resource,
    imageDigest,
    rawCommand: undefined,
  });
}

export function createPreflightEvidence(input: unknown = {}): Readonly<PreflightEvidence> {
  const value = assertPlainObject(input, 'preflight');
  const allowed: ReadonlySet<PreflightGate> = new Set(PREFLIGHT_GATES);
  assertAllowedKeys(value, allowed, 'preflight');
  const evidence = Object.fromEntries(
    [...allowed].map((key) => [key, value[key] ?? false]),
  ) as Record<PreflightGate, unknown>;
  for (const [key, result] of Object.entries(evidence)) assertBoolean(result, `preflight.${key}`);
  const passed = Object.values(evidence).every(Boolean);
  return Object.freeze({
    ...evidence,
    passed,
  }) as Readonly<PreflightEvidence>;
}

export function assertPreflightPassed(evidence: unknown): true {
  const candidate = evidence as { passed?: unknown };
  if (!evidence || candidate.passed !== true || Object.entries(evidence as object).some(([key, value]) => (
    key !== 'passed' && value !== true
  ))) {
    throw rolloutError(
      'all preflight gates must pass before green preparation or cutover',
      'PREFLIGHT_FAILED',
    );
  }
  return true;
}

export { rolloutError };
