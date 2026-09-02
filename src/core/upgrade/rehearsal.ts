// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/**
 * A deterministic, dependency-free LP7 rehearsal.
 *
 * This module models the safety boundary of a replacement controller. It does
 * not start processes, talk to a cluster, copy mailbox data, or mutate an
 * external store. The external state and volume objects are references shared
 * by blue and green, while the traffic, queue, and connection transitions are
 * recorded in a small in-memory state machine.
 */

export const REHEARSAL_PLATFORMS = Object.freeze(['docker', 'kubernetes'] as const);
export type RehearsalPlatform = (typeof REHEARSAL_PLATFORMS)[number];

export const REHEARSAL_PHASES = Object.freeze([
  'planned',
  'prepared',
  'ready',
  'cutover',
  'drained',
  'rolled_back',
  'finalized',
  'failed',
] as const);
export type RehearsalPhase = (typeof REHEARSAL_PHASES)[number];

export const REHEARSAL_SIDES = Object.freeze(['blue', 'green'] as const);
export type RehearsalSide = (typeof REHEARSAL_SIDES)[number];

export const EXTERNAL_STATE_REFERENCES = Object.freeze([
  'external-postgresql',
  'external-ldap',
  'mail-data',
  'dav-data',
  'backup-data',
  'persistent-mail-queue',
] as const);
export type ExternalStateReference = (typeof EXTERNAL_STATE_REFERENCES)[number];

export const REHEARSAL_OPERATIONS = Object.freeze([
  'prepare_green',
  'check_readiness',
  'cutover_green',
  'cutover_service',
  'handoff_queue',
  'drain_blue',
  'reconnect_imap_idle',
  'rollback_blue',
  'finalize',
  'failure',
] as const);
export type RehearsalOperationName = (typeof REHEARSAL_OPERATIONS)[number];

export type RehearsalClock = () => string | Date;

export interface ReleaseInput {
  readonly version?: string;
  readonly digest?: string;
  readonly imageDigest?: string;
}

export interface ExternalVolumeInput {
  readonly name: string;
  readonly fingerprint?: string;
}

export type ExternalStateInput =
  | readonly string[]
  | Readonly<Record<string, string>>;

export type ExternalVolumeList = readonly (string | ExternalVolumeInput)[];

export type QueueMessageInput = string | Readonly<{
  readonly id?: string;
  readonly deliveryId?: string;
  readonly envelopeId?: string;
  readonly state?: 'queued' | 'delivered';
}>;

export interface ImapEventInput {
  readonly eventId?: string;
  readonly mailbox?: string;
  readonly kind?: string;
  readonly occurredAt?: string;
}

export interface ImapSessionInput {
  readonly id: string;
  readonly lastEventSequence?: number;
}

export interface ImapIdleInput {
  readonly events?: readonly (string | ImapEventInput)[];
  readonly sessions?: readonly (string | ImapSessionInput)[];
}

export interface ReadinessPolicyInput {
  readonly greenReady?: boolean;
  readonly startupProbe?: boolean;
  readonly livenessProbe?: boolean;
  readonly readinessProbe?: boolean;
  readonly maxUnavailable?: number;
  readonly maxSurge?: number;
  readonly podDisruptionBudgetMinAvailable?: number;
  readonly terminationGracePeriodSeconds?: number;
}

export interface ServiceSelectorInput {
  readonly app?: string;
  readonly track?: RehearsalSide;
}

export interface BaseRehearsalInput {
  readonly source?: ReleaseInput;
  readonly target?: ReleaseInput;
  readonly sourceVersion?: string;
  readonly targetVersion?: string;
  readonly sourceDigest?: string;
  readonly targetDigest?: string;
  readonly externalState?: ExternalStateInput;
  readonly volumes?: ExternalVolumeList;
  readonly queue?: readonly QueueMessageInput[];
  readonly imapIdle?: ImapIdleInput;
  readonly readiness?: ReadinessPolicyInput;
  readonly greenReady?: boolean;
  readonly startAt?: string;
  readonly clock?: RehearsalClock;
  readonly connections?: Readonly<Partial<Record<'http' | 'websocket' | 'imap_idle' | 'smtp' | 'dav', number>>>;
}

export interface DockerRehearsalInput extends BaseRehearsalInput {
  readonly projectName?: string;
  readonly edgeName?: string;
}

export interface KubernetesRehearsalInput extends BaseRehearsalInput {
  readonly namespace?: string;
  readonly deploymentPrefix?: string;
  readonly serviceName?: string;
  readonly serviceSelector?: ServiceSelectorInput;
}

export interface UpgradeRehearsalInput extends DockerRehearsalInput, KubernetesRehearsalInput {
  readonly platform: RehearsalPlatform;
}

export interface ReleaseIdentity {
  readonly version: string;
  readonly digest: string;
}

export interface ExternalVolumeSnapshot {
  readonly name: string;
  readonly fingerprint: string;
  readonly retained: true;
  readonly copied: false;
  readonly deleted: false;
}

export interface ExternalStateSnapshot {
  readonly references: readonly ExternalStateReference[];
  readonly retained: true;
  readonly sharedByBlueAndGreen: true;
  readonly copied: false;
  readonly mutationCount: 0;
}

export interface ReplicaSnapshot {
  readonly side: RehearsalSide;
  readonly release: ReleaseIdentity;
  readonly lifecycle: 'absent' | 'serving' | 'prepared' | 'rollback_ready' | 'retired' | 'failed';
  readonly ready: boolean;
  readonly serving: boolean;
  readonly externalStateShared: true;
  readonly volumeNames: readonly string[];
}

export interface ReadinessSnapshot {
  readonly greenReady: boolean;
  readonly startupProbe: boolean;
  readonly livenessProbe: boolean;
  readonly readinessProbe: boolean;
  readonly maxUnavailable: number;
  readonly maxSurge: number;
  readonly podDisruptionBudgetMinAvailable: number;
  readonly terminationGracePeriodSeconds: number;
}

export interface RehearsalReadinessResult {
  readonly passed: boolean;
  readonly checks: ReadinessSnapshot;
  readonly snapshot: RehearsalSnapshot;
}

export interface QueueEntrySnapshot {
  readonly deliveryId: string;
  readonly envelopeId: string;
  readonly state: 'queued' | 'delivered';
  readonly deliveryCount: number;
}

export interface QueueDeliveryResult {
  readonly deliveryId: string;
  readonly consumer: RehearsalSide;
  readonly accepted: boolean;
  readonly duplicatePrevented: boolean;
  readonly deliveryCount: number;
}

export interface QueueSnapshot {
  readonly queueRef: 'persistent-mail-queue';
  readonly persistent: true;
  readonly consumer: RehearsalSide;
  readonly handoffCount: number;
  readonly entries: readonly QueueEntrySnapshot[];
  readonly deliveredIds: readonly string[];
  readonly duplicateDeliveriesPrevented: number;
  readonly noDuplicateDelivery: true;
}

export interface QueueHandoffController {
  readonly handoff: (side: RehearsalSide) => QueueSnapshot;
  readonly deliver: (deliveryId: string, consumer?: RehearsalSide) => QueueDeliveryResult;
  readonly snapshot: () => QueueSnapshot;
}

export interface ImapIdleEventSnapshot {
  readonly eventId: string;
  readonly sequence: number;
  readonly mailbox: string;
  readonly kind: string;
  readonly occurredAt: string;
}

export interface ImapIdleSessionSnapshot {
  readonly id: string;
  readonly side: RehearsalSide;
  readonly connected: boolean;
  readonly lastEventSequence: number;
  readonly deliveredEventIds: readonly string[];
}

export interface ImapReconnectResult {
  readonly sessionId: string;
  readonly side: RehearsalSide;
  readonly reconnected: true;
  readonly events: readonly ImapIdleEventSnapshot[];
  readonly duplicateEventsPrevented: number;
  readonly eventContinuity: true;
}

export interface ImapIdleSnapshot {
  readonly sessions: readonly ImapIdleSessionSnapshot[];
  readonly eventHistory: readonly ImapIdleEventSnapshot[];
  readonly reconnectCount: number;
  readonly deliveredEventCount: number;
  readonly duplicateEventsPrevented: number;
  readonly lostEvents: 0;
  readonly eventContinuity: true;
}

export interface ImapIdleController {
  readonly connect: (sessionId: string, side?: RehearsalSide) => ImapIdleSessionSnapshot;
  readonly disconnect: (sessionId: string) => ImapIdleSessionSnapshot;
  readonly reconnect: (sessionId: string, side?: RehearsalSide) => ImapReconnectResult;
  readonly emit: (input?: string | ImapEventInput) => ImapIdleEventSnapshot;
  readonly snapshot: () => ImapIdleSnapshot;
}

export interface ConnectionDrainSnapshot {
  readonly counts: Readonly<Record<string, number>>;
  readonly drained: boolean;
  readonly reconnectable: true;
}

export interface ServiceSnapshot {
  readonly name: string;
  readonly namespace: string;
  readonly selector: Readonly<{ readonly app: string; readonly track: RehearsalSide }>;
}

export interface KubernetesSnapshot {
  readonly namespace: string;
  readonly blueDeployment: string;
  readonly greenDeployment: string;
  readonly service: ServiceSnapshot;
  readonly readiness: ReadinessSnapshot;
}

export interface DockerSnapshot {
  readonly projectName: string;
  readonly edgeName: string;
  readonly edgeTarget: RehearsalSide;
}

export interface RehearsalOperation {
  readonly sequence: number;
  readonly action: RehearsalOperationName;
  readonly at: string;
  readonly side: RehearsalSide;
  readonly rawCommand?: never;
}

export interface RehearsalFailure {
  readonly reason: string;
  readonly at: string;
  readonly phaseBeforeFailure: RehearsalPhase;
}

export interface RehearsalTimestamps {
  readonly preparedAt?: string;
  readonly readyAt?: string;
  readonly cutoverAt?: string;
  readonly drainedAt?: string;
  readonly rollbackAt?: string;
  readonly finalizedAt?: string;
}

export interface RehearsalSafety {
  readonly rawCommands: false;
  readonly unrestrictedHostAccess: false;
  readonly volumeDeletion: false;
  readonly mailboxCopy: false;
  readonly schemaCleanupBeforeFinalize: false;
}

export interface RehearsalSnapshot {
  readonly kind: 'synthetic-upgrade-rehearsal';
  readonly platform: RehearsalPlatform;
  readonly phase: RehearsalPhase;
  readonly active: RehearsalSide;
  readonly source: ReleaseIdentity;
  readonly target: ReleaseIdentity;
  readonly blue: ReplicaSnapshot;
  readonly green: ReplicaSnapshot;
  readonly externalState: ExternalStateSnapshot;
  readonly volumes: readonly ExternalVolumeSnapshot[];
  readonly queue: QueueSnapshot;
  readonly imapIdle: ImapIdleSnapshot;
  readonly connections: ConnectionDrainSnapshot;
  readonly readiness: ReadinessSnapshot;
  readonly service: ServiceSnapshot | undefined;
  readonly docker: DockerSnapshot | undefined;
  readonly kubernetes: KubernetesSnapshot | undefined;
  readonly timestamps: RehearsalTimestamps;
  readonly rollbackReady: boolean;
  readonly sourcePreserved: true;
  readonly volumesRetained: true;
  readonly noMailboxCopy: true;
  readonly contractCleanupApplied: boolean;
  readonly safety: RehearsalSafety;
  readonly operations: readonly RehearsalOperation[];
  readonly rollbackReason: string | undefined;
  readonly failure: RehearsalFailure | undefined;
}

export interface UpgradeRehearsal {
  readonly prepare: () => RehearsalSnapshot;
  readonly checkReadiness: () => RehearsalReadinessResult;
  readonly readiness: () => RehearsalReadinessResult;
  readonly markGreenReady: (ready: boolean) => RehearsalSnapshot;
  readonly cutover: () => RehearsalSnapshot;
  readonly drain: () => RehearsalSnapshot;
  readonly rollback: (reason?: string) => RehearsalSnapshot;
  readonly finalize: () => RehearsalSnapshot;
  readonly fail: (reason: string) => RehearsalSnapshot;
  readonly snapshot: () => RehearsalSnapshot;
  readonly queue: QueueHandoffController;
  readonly imapIdle: ImapIdleController;
}

interface CodedError extends Error {
  readonly code: string;
}

export class RehearsalError extends Error implements CodedError {
  readonly code: string;

  public constructor(message: string, code: string) {
    super(`Upgrade rehearsal error: ${message}`);
    this.name = 'RehearsalError';
    this.code = code;
  }
}

interface NormalizedVolume {
  readonly name: string;
  readonly fingerprint: string;
}

interface InternalQueueEntry {
  readonly deliveryId: string;
  readonly envelopeId: string;
  state: 'queued' | 'delivered';
  deliveryCount: number;
}

interface QueueRuntime {
  readonly entries: Map<string, InternalQueueEntry>;
  consumer: RehearsalSide;
  handoffCount: number;
  duplicateDeliveriesPrevented: number;
}

interface InternalEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly mailbox: string;
  readonly kind: string;
  readonly occurredAt: string;
}

interface InternalSession {
  readonly id: string;
  side: RehearsalSide;
  connected: boolean;
  lastEventSequence: number;
  readonly deliveredEventIds: Set<string>;
}

interface ImapRuntime {
  readonly events: InternalEvent[];
  readonly sessions: Map<string, InternalSession>;
  eventSequence: number;
  reconnectCount: number;
  deliveredEventCount: number;
  duplicateEventsPrevented: number;
}

interface NormalizedConfig {
  readonly platform: RehearsalPlatform;
  readonly source: ReleaseIdentity;
  readonly target: ReleaseIdentity;
  readonly externalReferences: readonly ExternalStateReference[];
  readonly volumes: readonly NormalizedVolume[];
  readonly readiness: ReadinessSnapshot;
  readonly initialGreenReady: boolean;
  readonly projectName?: string;
  readonly edgeName?: string;
  readonly namespace?: string;
  readonly deploymentPrefix?: string;
  readonly serviceName?: string;
  readonly serviceApp?: string;
  readonly startAt: string;
  readonly clock: RehearsalClock | undefined;
  readonly queue: readonly QueueMessageInput[];
  readonly imapIdle: ImapIdleInput;
  readonly connections: Readonly<Record<string, number>>;
}

interface InternalReplica {
  readonly side: RehearsalSide;
  readonly release: ReleaseIdentity;
  lifecycle: ReplicaSnapshot['lifecycle'];
  ready: boolean;
  serving: boolean;
}

interface InternalState {
  phase: RehearsalPhase;
  active: RehearsalSide;
  greenReady: boolean;
  rollbackReady: boolean;
  contractCleanupApplied: boolean;
  readonly blue: InternalReplica;
  readonly green: InternalReplica;
  readonly queue: QueueRuntime;
  readonly imap: ImapRuntime;
  readonly operations: RehearsalOperation[];
  readonly timestamps: InternalTimestamps;
  connectionsDrained: boolean;
  rollbackReason?: string;
  failure?: RehearsalFailure;
  timestampSequence: number;
}

interface InternalTimestamps {
  preparedAt?: string;
  readyAt?: string;
  cutoverAt?: string;
  drainedAt?: string;
  rollbackAt?: string;
  finalizedAt?: string;
}

const SAFE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SAFE_EVENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,95}[A-Za-z0-9])?$/u;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}(?:[-+][0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_START_AT = '2026-08-27T00:00:00.000Z';
const DEFAULT_SOURCE_DIGEST = `sha256:${'1'.repeat(64)}`;
const DEFAULT_TARGET_DIGEST = `sha256:${'2'.repeat(64)}`;
const DEFAULT_VOLUME_NAMES = Object.freeze(['runtime-state', 'mail-data', 'dav-data', 'backup-data'] as const);
const DEFAULT_QUEUE = Object.freeze(['delivery-000001', 'delivery-000002'] as const);
const DEFAULT_SESSIONS = Object.freeze(['imap-idle-000001'] as const);

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const child of value) freezeDeep(child);
  } else {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function recordOf(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RehearsalError(`${field} must be an object`, 'INVALID_CONFIGURATION');
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new RehearsalError(`${field} is invalid`, 'INVALID_CONFIGURATION');
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new RehearsalError(`${field} must be a boolean`, 'INVALID_CONFIGURATION');
  return value;
}

function integerValue(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RehearsalError(`${field} must be an integer between ${minimum} and ${maximum}`, 'INVALID_CONFIGURATION');
  }
  return value as number;
}

function safeName(value: unknown, field: string): string {
  return stringValue(value, field, SAFE_NAME_PATTERN);
}

function safeEventId(value: unknown, field: string): string {
  return stringValue(value, field, SAFE_EVENT_PATTERN);
}

function digest(value: unknown, field: string): string {
  return stringValue(value, field, DIGEST_PATTERN);
}

function version(value: unknown, field: string): string {
  return stringValue(value, field, VERSION_PATTERN);
}

function normalizeRelease(
  value: ReleaseInput | undefined,
  fallbackVersion: string,
  fallbackDigest: string,
  field: string,
): ReleaseIdentity {
  const input = value === undefined ? {} : recordOf(value, field);
  const selectedVersion = input.version ?? fallbackVersion;
  const selectedDigest = input.digest ?? input.imageDigest ?? fallbackDigest;
  return Object.freeze({
    version: version(selectedVersion, `${field}.version`),
    digest: digest(selectedDigest, `${field}.digest`),
  });
}

function normalizeExternalReference(value: unknown, field: string): ExternalStateReference {
  const input = stringValue(value, field).toLowerCase();
  const aliases: Readonly<Record<string, ExternalStateReference>> = {
    'external-postgresql': 'external-postgresql',
    postgres: 'external-postgresql',
    postgresql: 'external-postgresql',
    'external-ldap': 'external-ldap',
    ldap: 'external-ldap',
    'mail-data': 'mail-data',
    mail: 'mail-data',
    'dav-data': 'dav-data',
    dav: 'dav-data',
    'backup-data': 'backup-data',
    backup: 'backup-data',
    'persistent-mail-queue': 'persistent-mail-queue',
    queue: 'persistent-mail-queue',
  };
  const canonical = aliases[input];
  if (canonical === undefined) throw new RehearsalError(`${field} is not an approved external reference`, 'INVALID_EXTERNAL_STATE');
  return canonical;
}

function normalizeExternalReferences(input: ExternalStateInput | undefined): readonly ExternalStateReference[] {
  const values: string[] = [];
  if (input === undefined) {
    values.push(...EXTERNAL_STATE_REFERENCES);
  } else if (Array.isArray(input)) {
    for (const item of input) values.push(normalizeExternalReference(item, 'externalState[]'));
  } else {
    const object = recordOf(input, 'externalState');
    for (const [key, value] of Object.entries(object)) {
      try {
        values.push(normalizeExternalReference(key, `externalState.${key}`));
      } catch (error: unknown) {
        if (error instanceof RehearsalError && error.code === 'INVALID_EXTERNAL_STATE') {
          values.push(normalizeExternalReference(value, `externalState.${key}`));
        } else {
          throw error;
        }
      }
    }
  }
  const unique = [...new Set(values)];
  if (unique.length === 0) throw new RehearsalError('at least one external state reference is required', 'EXTERNAL_STATE_REQUIRED');
  return Object.freeze(unique as ExternalStateReference[]);
}

function normalizeVolumes(input: ExternalVolumeList | undefined): readonly NormalizedVolume[] {
  const values = input ?? DEFAULT_VOLUME_NAMES;
  if (values.length === 0) throw new RehearsalError('at least one external volume is required', 'VOLUMES_REQUIRED');
  const names = new Set<string>();
  const volumes: NormalizedVolume[] = [];
  for (const item of values) {
    const object = typeof item === 'string' ? undefined : recordOf(item, 'volumes[]');
    const name = safeName(object?.name ?? item, 'volumes[].name');
    if (names.has(name)) throw new RehearsalError(`volume ${name} is listed more than once`, 'DUPLICATE_VOLUME');
    names.add(name);
    const fingerprint = object?.fingerprint === undefined
      ? `external-${name}`
      : safeEventId(object.fingerprint, `volumes[].fingerprint`);
    volumes.push(Object.freeze({ name, fingerprint }));
  }
  return Object.freeze(volumes);
}

function normalizeReadiness(input: ReadinessPolicyInput | undefined, platform: RehearsalPlatform, greenReady: boolean): ReadinessSnapshot {
  const value = input === undefined ? {} : recordOf(input, 'readiness');
  const selectedGreenReady = value.greenReady ?? greenReady;
  const startupProbe = value.startupProbe ?? true;
  const livenessProbe = value.livenessProbe ?? true;
  const readinessProbe = value.readinessProbe ?? true;
  const maxUnavailable = integerValue(value.maxUnavailable ?? 0, 'readiness.maxUnavailable', 0, 100);
  const maxSurge = integerValue(value.maxSurge ?? 1, 'readiness.maxSurge', 1, 10);
  const pdb = integerValue(value.podDisruptionBudgetMinAvailable ?? 1, 'readiness.podDisruptionBudgetMinAvailable', 1, 100);
  const grace = integerValue(value.terminationGracePeriodSeconds ?? 60, 'readiness.terminationGracePeriodSeconds', 10, 900);
  const result = {
    greenReady: booleanValue(selectedGreenReady, 'readiness.greenReady'),
    startupProbe: booleanValue(startupProbe, 'readiness.startupProbe'),
    livenessProbe: booleanValue(livenessProbe, 'readiness.livenessProbe'),
    readinessProbe: booleanValue(readinessProbe, 'readiness.readinessProbe'),
    maxUnavailable,
    maxSurge,
    podDisruptionBudgetMinAvailable: pdb,
    terminationGracePeriodSeconds: grace,
  };
  if (platform === 'kubernetes' && result.maxUnavailable !== 0) {
    throw new RehearsalError('Kubernetes rehearsal requires maxUnavailable to be zero', 'READINESS_POLICY_VIOLATION');
  }
  return Object.freeze(result);
}

function normalizeQueueInput(input: readonly QueueMessageInput[] | undefined): readonly QueueMessageInput[] {
  if (input !== undefined && !Array.isArray(input)) {
    throw new RehearsalError('queue must be an array', 'INVALID_CONFIGURATION');
  }
  return Object.freeze([...(input ?? DEFAULT_QUEUE)]);
}

function normalizeImapInput(input: ImapIdleInput | undefined): ImapIdleInput {
  if (input === undefined) return Object.freeze({ events: [], sessions: DEFAULT_SESSIONS });
  recordOf(input, 'imapIdle');
  if (input.events !== undefined && !Array.isArray(input.events)) {
    throw new RehearsalError('imapIdle.events must be an array', 'INVALID_CONFIGURATION');
  }
  if (input.sessions !== undefined && !Array.isArray(input.sessions)) {
    throw new RehearsalError('imapIdle.sessions must be an array', 'INVALID_CONFIGURATION');
  }
  return Object.freeze({
    events: Object.freeze([...(input.events ?? [])]),
    sessions: Object.freeze([...(input.sessions ?? DEFAULT_SESSIONS)]),
  });
}

function normalizeConnections(input: BaseRehearsalInput['connections']): Readonly<Record<string, number>> {
  if (input === undefined) return Object.freeze({});
  const object = recordOf(input, 'connections');
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(object)) {
    if (!['http', 'websocket', 'imap_idle', 'smtp', 'dav'].includes(key)) {
      throw new RehearsalError(`connections.${key} is not supported`, 'INVALID_CONNECTION_TYPE');
    }
    result[key] = integerValue(value, `connections.${key}`, 0, 1_000_000);
  }
  return Object.freeze(result);
}

function normalizeConfig(platform: RehearsalPlatform, input: BaseRehearsalInput & Partial<DockerRehearsalInput> & Partial<KubernetesRehearsalInput>): NormalizedConfig {
  recordOf(input, 'rehearsal');
  const value = input;
  const sourceVersion = value.sourceVersion ?? '0.0.0';
  const targetVersion = value.targetVersion ?? '0.1.0';
  const sourceDigest = value.sourceDigest ?? DEFAULT_SOURCE_DIGEST;
  const targetDigest = value.targetDigest ?? DEFAULT_TARGET_DIGEST;
  const source = normalizeRelease(value.source, sourceVersion as string, sourceDigest as string, 'source');
  const target = normalizeRelease(value.target, targetVersion as string, targetDigest as string, 'target');
  if (source.version === target.version || source.digest === target.digest) {
    throw new RehearsalError('source and target must differ', 'SAME_SOURCE_AND_TARGET');
  }
  const initialGreenReady = value.greenReady ?? value.readiness?.greenReady ?? true;
  const readiness = normalizeReadiness(value.readiness, platform, booleanValue(initialGreenReady, 'greenReady'));
  const projectName = value.projectName === undefined ? 'gulogulo' : safeName(value.projectName, 'projectName');
  const edgeName = value.edgeName === undefined ? 'gulogulo-edge' : safeName(value.edgeName, 'edgeName');
  const namespace = value.namespace === undefined ? 'gulogulo' : safeName(value.namespace, 'namespace');
  const deploymentPrefix = value.deploymentPrefix === undefined ? 'gulogulo' : safeName(value.deploymentPrefix, 'deploymentPrefix');
  const serviceName = value.serviceName === undefined ? 'gulogulo-web' : safeName(value.serviceName, 'serviceName');
  const selector = value.serviceSelector ?? {};
  recordOf(selector, 'serviceSelector');
  const serviceApp = selector.app === undefined ? serviceName : safeName(selector.app, 'serviceSelector.app');
  if (selector.track !== undefined && selector.track !== 'blue') {
    throw new RehearsalError('the stable service must initially select blue', 'INVALID_SERVICE_SELECTOR');
  }
  const startAt = value.startAt === undefined ? DEFAULT_START_AT : stringValue(value.startAt, 'startAt');
  if (Number.isNaN(Date.parse(startAt))) throw new RehearsalError('startAt must be an ISO timestamp', 'INVALID_CONFIGURATION');
  return Object.freeze({
    platform,
    source,
    target,
    externalReferences: normalizeExternalReferences(value.externalState),
    volumes: normalizeVolumes(value.volumes),
    readiness,
    initialGreenReady: readiness.greenReady,
    projectName,
    edgeName,
    namespace,
    deploymentPrefix,
    serviceName,
    serviceApp,
    startAt,
    clock: value.clock,
    queue: normalizeQueueInput(value.queue),
    imapIdle: normalizeImapInput(value.imapIdle),
    connections: normalizeConnections(value.connections),
  });
}

function createQueueRuntime(
  inputs: readonly QueueMessageInput[],
): QueueRuntime {
  const entries = new Map<string, InternalQueueEntry>();
  const envelopeIds = new Set<string>();
  let sequence = 0;
  for (const input of inputs) {
    const object = typeof input === 'string' ? undefined : input;
    if (object !== undefined) recordOf(object, 'queue[]');
    const fallbackId = `delivery-${String(++sequence).padStart(6, '0')}`;
    const deliveryId = safeEventId(object?.deliveryId ?? object?.id ?? (typeof input === 'string' ? input : fallbackId), 'queue[].deliveryId');
    const envelopeId = safeEventId(object?.envelopeId ?? deliveryId, 'queue[].envelopeId');
    if (entries.has(deliveryId)) throw new RehearsalError(`queue item ${deliveryId} is duplicated`, 'DUPLICATE_QUEUE_ITEM');
    if (envelopeIds.has(envelopeId)) throw new RehearsalError(`queue envelope ${envelopeId} is duplicated`, 'DUPLICATE_QUEUE_ENVELOPE');
    envelopeIds.add(envelopeId);
    const state: 'queued' | 'delivered' = object?.state ?? 'queued';
    entries.set(deliveryId, {
      deliveryId: deliveryId || fallbackId,
      envelopeId,
      state,
      deliveryCount: state === 'delivered' ? 1 : 0,
    });
  }
  return { entries, consumer: 'blue', handoffCount: 0, duplicateDeliveriesPrevented: 0 };
}

function createImapRuntime(input: ImapIdleInput): ImapRuntime {
  const runtime: ImapRuntime = {
    events: [],
    sessions: new Map<string, InternalSession>(),
    eventSequence: 0,
    reconnectCount: 0,
    deliveredEventCount: 0,
    duplicateEventsPrevented: 0,
  };
  const eventInputs = input.events ?? [];
  const eventIds = new Set<string>();
  for (const item of eventInputs) {
    const object = typeof item === 'string' ? undefined : recordOf(item, 'imapIdle.events[]');
    const fallbackId = `imap-event-${String(runtime.eventSequence + 1).padStart(6, '0')}`;
    const eventId = safeEventId(object?.eventId ?? (typeof item === 'string' ? item : fallbackId), 'imapIdle.events[].eventId');
    if (eventIds.has(eventId)) throw new RehearsalError(`IMAP event ${eventId} is duplicated`, 'DUPLICATE_IMAP_EVENT');
    eventIds.add(eventId);
    const event: InternalEvent = {
      eventId,
      sequence: ++runtime.eventSequence,
      mailbox: safeEventId(object?.mailbox ?? 'INBOX', 'imapIdle.events[].mailbox'),
      kind: safeEventId(object?.kind ?? 'exists', 'imapIdle.events[].kind'),
      occurredAt: object?.occurredAt === undefined
        ? `2026-08-27T00:00:${String(runtime.eventSequence).padStart(2, '0')}.000Z`
        : stringValue(object.occurredAt, 'imapIdle.events[].occurredAt'),
    };
    runtime.events.push(event);
  }
  const sessionInputs = input.sessions ?? [];
  const sessionIds = new Set<string>();
  for (const item of sessionInputs) {
    const object = typeof item === 'string' ? undefined : recordOf(item, 'imapIdle.sessions[]');
    const id = safeEventId(object?.id ?? item, 'imapIdle.sessions[].id');
    if (sessionIds.has(id)) throw new RehearsalError(`IMAP session ${id} is duplicated`, 'DUPLICATE_IMAP_SESSION');
    sessionIds.add(id);
    const lastEventSequence = object?.lastEventSequence === undefined
      ? 0
      : integerValue(object.lastEventSequence, 'imapIdle.sessions[].lastEventSequence', 0, runtime.eventSequence);
    runtime.sessions.set(id, {
      id,
      side: 'blue',
      connected: true,
      lastEventSequence,
      deliveredEventIds: new Set<string>(),
    });
  }
  return runtime;
}

function createQueueController(runtime: QueueRuntime): QueueHandoffController {
  function snapshot(): QueueSnapshot {
    const entries = [...runtime.entries.values()].map((entry) => Object.freeze({
      deliveryId: entry.deliveryId,
      envelopeId: entry.envelopeId,
      state: entry.state,
      deliveryCount: entry.deliveryCount,
    }));
    return freezeDeep({
      queueRef: 'persistent-mail-queue',
      persistent: true,
      consumer: runtime.consumer,
      handoffCount: runtime.handoffCount,
      entries: Object.freeze(entries),
      deliveredIds: Object.freeze(entries.filter((entry) => entry.state === 'delivered').map((entry) => entry.deliveryId)),
      duplicateDeliveriesPrevented: runtime.duplicateDeliveriesPrevented,
      noDuplicateDelivery: true,
    });
  }

  function handoff(side: RehearsalSide): QueueSnapshot {
    runtime.consumer = side;
    runtime.handoffCount += 1;
    return snapshot();
  }

  function deliver(deliveryId: string, consumer = runtime.consumer): QueueDeliveryResult {
    const id = safeEventId(deliveryId, 'deliveryId');
    const entry = runtime.entries.get(id);
    if (entry === undefined) throw new RehearsalError(`queue item ${id} does not exist`, 'QUEUE_ITEM_NOT_FOUND');
    if (consumer !== runtime.consumer) throw new RehearsalError('delivery attempted by a stale queue consumer', 'QUEUE_CONSUMER_MISMATCH');
    if (entry.state === 'delivered') {
      runtime.duplicateDeliveriesPrevented += 1;
      return freezeDeep({
        deliveryId: id,
        consumer,
        accepted: false,
        duplicatePrevented: true,
        deliveryCount: entry.deliveryCount,
      });
    }
    entry.state = 'delivered';
    entry.deliveryCount += 1;
    return freezeDeep({
      deliveryId: id,
      consumer,
      accepted: true,
      duplicatePrevented: false,
      deliveryCount: entry.deliveryCount,
    });
  }

  return Object.freeze({ handoff, deliver, snapshot });
}

function createImapController(
  runtime: ImapRuntime,
  timestamp: () => string,
): ImapIdleController {
  function sessionSnapshot(session: InternalSession): ImapIdleSessionSnapshot {
    return freezeDeep({
      id: session.id,
      side: session.side,
      connected: session.connected,
      lastEventSequence: session.lastEventSequence,
      deliveredEventIds: Object.freeze([...session.deliveredEventIds]),
    });
  }

  function snapshot(): ImapIdleSnapshot {
    return freezeDeep({
      sessions: Object.freeze([...runtime.sessions.values()].map(sessionSnapshot)),
      eventHistory: Object.freeze(runtime.events.map((event) => Object.freeze({ ...event }))),
      reconnectCount: runtime.reconnectCount,
      deliveredEventCount: runtime.deliveredEventCount,
      duplicateEventsPrevented: runtime.duplicateEventsPrevented,
      lostEvents: 0,
      eventContinuity: true,
    });
  }

  function getSession(sessionId: string): InternalSession {
    const id = safeEventId(sessionId, 'sessionId');
    const session = runtime.sessions.get(id);
    if (session === undefined) throw new RehearsalError(`IMAP session ${id} does not exist`, 'IMAP_SESSION_NOT_FOUND');
    return session;
  }

  function createSession(sessionId: string, side: RehearsalSide): InternalSession {
    const id = safeEventId(sessionId, 'sessionId');
    const session: InternalSession = {
      id,
      side,
      connected: true,
      lastEventSequence: 0,
      deliveredEventIds: new Set<string>(),
    };
    runtime.sessions.set(id, session);
    return session;
  }

  function connect(sessionId: string, side: RehearsalSide = 'blue'): ImapIdleSessionSnapshot {
    const id = safeEventId(sessionId, 'sessionId');
    const session = runtime.sessions.get(id) ?? createSession(id, side);
    session.side = side;
    session.connected = true;
    return sessionSnapshot(session);
  }

  function disconnect(sessionId: string): ImapIdleSessionSnapshot {
    const session = getSession(sessionId);
    session.connected = false;
    return sessionSnapshot(session);
  }

  function deliverToSession(session: InternalSession, event: InternalEvent): boolean {
    if (session.deliveredEventIds.has(event.eventId)) {
      runtime.duplicateEventsPrevented += 1;
      return false;
    }
    session.deliveredEventIds.add(event.eventId);
    session.lastEventSequence = Math.max(session.lastEventSequence, event.sequence);
    runtime.deliveredEventCount += 1;
    return true;
  }

  function reconnect(sessionId: string, side: RehearsalSide = 'green'): ImapReconnectResult {
    const session = getSession(sessionId);
    session.side = side;
    session.connected = true;
    runtime.reconnectCount += 1;
    const events: ImapIdleEventSnapshot[] = [];
    for (const event of runtime.events) {
      if (event.sequence <= session.lastEventSequence) continue;
      if (deliverToSession(session, event)) events.push(Object.freeze({ ...event }));
    }
    return freezeDeep({
      sessionId: session.id,
      side: session.side,
      reconnected: true,
      events: Object.freeze(events),
      duplicateEventsPrevented: runtime.duplicateEventsPrevented,
      eventContinuity: true,
    });
  }

  function emit(input: string | ImapEventInput = 'exists'): ImapIdleEventSnapshot {
    const object = typeof input === 'string' ? undefined : recordOf(input, 'imapIdle.event');
    const eventId = safeEventId(object?.eventId ?? `imap-event-${String(runtime.eventSequence + 1).padStart(6, '0')}`, 'imapIdle.event.eventId');
    if (runtime.events.some((event) => event.eventId === eventId)) {
      throw new RehearsalError(`IMAP event ${eventId} is duplicated`, 'DUPLICATE_IMAP_EVENT');
    }
    const event: InternalEvent = {
      eventId,
      sequence: ++runtime.eventSequence,
      mailbox: safeEventId(object?.mailbox ?? 'INBOX', 'imapIdle.event.mailbox'),
      kind: safeEventId(typeof input === 'string' ? input : object?.kind ?? 'exists', 'imapIdle.event.kind'),
      occurredAt: object?.occurredAt === undefined ? timestamp() : stringValue(object.occurredAt, 'imapIdle.event.occurredAt'),
    };
    runtime.events.push(event);
    for (const session of runtime.sessions.values()) {
      if (session.connected) deliverToSession(session, event);
    }
    return freezeDeep({ ...event });
  }

  return Object.freeze({ connect, disconnect, reconnect, emit, snapshot });
}

function createEngine(
  platform: RehearsalPlatform,
  input: BaseRehearsalInput & Partial<DockerRehearsalInput> & Partial<KubernetesRehearsalInput>,
): UpgradeRehearsal {
  const config = normalizeConfig(platform, input);
  const queue = createQueueRuntime(config.queue);
  const imap = createImapRuntime(config.imapIdle);
  const state: InternalState = {
    phase: 'planned',
    active: 'blue',
    greenReady: false,
    rollbackReady: true,
    contractCleanupApplied: false,
    blue: {
      side: 'blue',
      release: config.source,
      lifecycle: 'serving',
      ready: true,
      serving: true,
    },
    green: {
      side: 'green',
      release: config.target,
      lifecycle: 'absent',
      ready: false,
      serving: false,
    },
    queue,
    imap,
    operations: [],
    timestamps: {},
    connectionsDrained: false,
    timestampSequence: 0,
  };

  function timestamp(): string {
    const raw = config.clock === undefined
      ? new Date(Date.parse(config.startAt) + state.timestampSequence * 1_000)
      : config.clock();
    state.timestampSequence += 1;
    const date = typeof raw === 'string' ? new Date(raw) : raw;
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new RehearsalError('clock must return a valid timestamp', 'INVALID_CLOCK');
    return date.toISOString();
  }

  function operation(action: RehearsalOperationName, side = state.active): void {
    state.operations.push(Object.freeze({
      sequence: state.operations.length + 1,
      action,
      at: timestamp(),
      side,
    }));
  }

  const queueController = createQueueController(queue);
  const imapController = createImapController(imap, timestamp);

  function reconnectAll(side: RehearsalSide): void {
    for (const session of imap.sessions.values()) {
      if (!session.connected || session.side !== side) {
        if (session.connected) imapController.disconnect(session.id);
        imapController.reconnect(session.id, side);
      }
    }
  }

  function setFailure(reason: string): void {
    const safeReason = stringValue(reason, 'reason');
    if (state.phase === 'finalized') throw new RehearsalError('finalized rehearsals cannot fail', 'INVALID_STATE_TRANSITION');
    const phaseBeforeFailure = state.phase;
    const at = timestamp();
    state.phase = 'failed';
    state.failure = Object.freeze({ reason: safeReason, at, phaseBeforeFailure });
    state.active = 'blue';
    state.blue.lifecycle = 'serving';
    state.blue.ready = true;
    state.blue.serving = true;
    state.green.serving = false;
    state.green.lifecycle = state.green.ready ? 'rollback_ready' : 'failed';
    state.queue.consumer = 'blue';
    reconnectAll('blue');
    state.operations.push(Object.freeze({
      sequence: state.operations.length + 1,
      action: 'failure',
      at,
      side: 'blue',
    }));
  }

  function replicaSnapshot(replica: InternalReplica): ReplicaSnapshot {
    return Object.freeze({
      side: replica.side,
      release: replica.release,
      lifecycle: replica.lifecycle,
      ready: replica.ready,
      serving: replica.serving,
      externalStateShared: true,
      volumeNames: Object.freeze(config.volumes.map((volume) => volume.name)),
    });
  }

  function externalStateSnapshot(): ExternalStateSnapshot {
    return Object.freeze({
      references: config.externalReferences,
      retained: true,
      sharedByBlueAndGreen: true,
      copied: false,
      mutationCount: 0,
    });
  }

  function volumeSnapshots(): readonly ExternalVolumeSnapshot[] {
    return Object.freeze(config.volumes.map((volume) => Object.freeze({
      name: volume.name,
      fingerprint: volume.fingerprint,
      retained: true,
      copied: false,
      deleted: false,
    })));
  }

  function readinessSnapshot(): ReadinessSnapshot {
    return Object.freeze({ ...config.readiness, greenReady: state.greenReady });
  }

  function serviceSnapshot(): ServiceSnapshot | undefined {
    if (platform !== 'kubernetes') return undefined;
    return Object.freeze({
      name: config.serviceName as string,
      namespace: config.namespace as string,
      selector: Object.freeze({ app: config.serviceApp as string, track: state.active }),
    });
  }

  function snapshot(): RehearsalSnapshot {
    const service = serviceSnapshot();
    const docker = platform === 'docker'
      ? Object.freeze({ projectName: config.projectName as string, edgeName: config.edgeName as string, edgeTarget: state.active })
      : undefined;
    const kubernetes = platform === 'kubernetes'
      ? Object.freeze({
        namespace: config.namespace as string,
        blueDeployment: `${config.deploymentPrefix as string}-blue`,
        greenDeployment: `${config.deploymentPrefix as string}-green`,
        service: service as ServiceSnapshot,
        readiness: readinessSnapshot(),
      })
      : undefined;
    const result: RehearsalSnapshot = {
      kind: 'synthetic-upgrade-rehearsal',
      platform,
      phase: state.phase,
      active: state.active,
      source: config.source,
      target: config.target,
      blue: replicaSnapshot(state.blue),
      green: replicaSnapshot(state.green),
      externalState: externalStateSnapshot(),
      volumes: volumeSnapshots(),
      queue: queueController.snapshot(),
      imapIdle: imapController.snapshot(),
      connections: Object.freeze({
        counts: config.connections,
        drained: state.connectionsDrained,
        reconnectable: true,
      }),
      readiness: readinessSnapshot(),
      service,
      docker,
      kubernetes,
      timestamps: Object.freeze({ ...state.timestamps }),
      rollbackReady: state.rollbackReady,
      sourcePreserved: true,
      volumesRetained: true,
      noMailboxCopy: true,
      contractCleanupApplied: state.contractCleanupApplied,
      safety: Object.freeze({
        rawCommands: false,
        unrestrictedHostAccess: false,
        volumeDeletion: false,
        mailboxCopy: false,
        schemaCleanupBeforeFinalize: false,
      }),
      operations: Object.freeze([...state.operations]),
      rollbackReason: state.rollbackReason,
      failure: state.failure,
    };
    return freezeDeep(result);
  }

  function readinessResult(): RehearsalReadinessResult {
    const checks = readinessSnapshot();
    const passed = checks.greenReady
      && checks.startupProbe
      && checks.livenessProbe
      && checks.readinessProbe
      && checks.maxUnavailable === 0
      && checks.podDisruptionBudgetMinAvailable >= 1;
    return freezeDeep({ passed, checks, snapshot: snapshot() });
  }

  function prepare(): RehearsalSnapshot {
    if (state.phase === 'prepared' || state.phase === 'ready' || state.phase === 'cutover' || state.phase === 'drained') return snapshot();
    if (state.phase !== 'planned') throw new RehearsalError('green preparation is not available in the current phase', 'INVALID_STATE_TRANSITION');
    state.phase = 'prepared';
    state.green.lifecycle = 'prepared';
    state.green.ready = false;
    state.green.serving = false;
    state.timestamps.preparedAt = timestamp();
    operation('prepare_green', 'green');
    return snapshot();
  }

  function markGreenReady(ready: boolean): RehearsalSnapshot {
    booleanValue(ready, 'greenReady');
    if (state.phase !== 'prepared' && state.phase !== 'ready') {
      if (state.phase === 'failed') return snapshot();
      throw new RehearsalError('green readiness can only be changed after preparation', 'READINESS_BEFORE_PREPARE');
    }
    state.greenReady = ready;
    state.green.ready = ready;
    if (!ready) {
      setFailure('green readiness check failed');
      operation('check_readiness', 'green');
      return snapshot();
    }
    state.phase = 'ready';
    state.green.lifecycle = 'rollback_ready';
    state.timestamps.readyAt = timestamp();
    operation('check_readiness', 'green');
    return snapshot();
  }

  function checkReadiness(): RehearsalReadinessResult {
    if (state.phase === 'planned') throw new RehearsalError('green must be prepared before readiness checks', 'READINESS_BEFORE_PREPARE');
    if (state.phase === 'prepared') markGreenReady(config.initialGreenReady);
    return readinessResult();
  }

  function cutover(): RehearsalSnapshot {
    if (state.phase === 'cutover' || state.phase === 'drained') return snapshot();
    if (state.phase === 'failed' && !state.greenReady) throw new RehearsalError('green is not ready; blue remains active', 'GREEN_NOT_READY');
    if (state.phase !== 'ready') throw new RehearsalError('cutover requires a passed readiness check', 'READINESS_REQUIRED');
    state.active = 'green';
    state.green.serving = true;
    state.green.lifecycle = 'serving';
    state.blue.serving = true;
    state.blue.lifecycle = 'rollback_ready';
    state.queue.consumer = 'green';
    state.queue.handoffCount += 1;
    state.phase = 'cutover';
    state.timestamps.cutoverAt = timestamp();
    operation('handoff_queue', 'green');
    operation('cutover_green', 'green');
    if (platform === 'kubernetes') operation('cutover_service', 'green');
    return snapshot();
  }

  function drain(): RehearsalSnapshot {
    if (state.phase === 'drained') return snapshot();
    if (state.phase !== 'cutover') throw new RehearsalError('connection drain requires green cutover', 'CUTOVER_REQUIRED');
    for (const session of imap.sessions.values()) {
      if (session.side === 'blue' && session.connected) {
        imapController.disconnect(session.id);
        imapController.reconnect(session.id, 'green');
      }
    }
    state.phase = 'drained';
    state.connectionsDrained = true;
    state.timestamps.drainedAt = timestamp();
    operation('reconnect_imap_idle', 'green');
    operation('drain_blue', 'blue');
    return snapshot();
  }

  function rollback(reason = 'synthetic rehearsal rollback'): RehearsalSnapshot {
    const safeReason = stringValue(reason, 'reason');
    if (state.phase === 'finalized') throw new RehearsalError('finalized rehearsals cannot roll back', 'ROLLBACK_NOT_AVAILABLE');
    if (state.phase === 'rolled_back') return snapshot();
    state.active = 'blue';
    state.blue.serving = true;
    state.blue.ready = true;
    state.blue.lifecycle = 'serving';
    state.green.serving = false;
    state.green.lifecycle = state.green.ready ? 'rollback_ready' : 'failed';
    state.queue.consumer = 'blue';
    state.queue.handoffCount += 1;
    reconnectAll('blue');
    state.phase = 'rolled_back';
    state.rollbackReason = safeReason;
    state.timestamps.rollbackAt = timestamp();
    operation('handoff_queue', 'blue');
    operation('rollback_blue', 'blue');
    return snapshot();
  }

  function finalize(): RehearsalSnapshot {
    if (state.phase === 'finalized') return snapshot();
    if (state.phase !== 'drained' && state.phase !== 'rolled_back') {
      throw new RehearsalError('finalization requires drain or rollback', 'FINALIZE_BEFORE_DRAIN');
    }
    if (state.phase === 'rolled_back') {
      state.active = 'blue';
      state.blue.serving = true;
      state.blue.lifecycle = 'serving';
      state.green.serving = false;
      state.green.lifecycle = 'retired';
    } else {
      state.active = 'green';
      state.green.serving = true;
      state.green.lifecycle = 'serving';
      state.blue.serving = false;
      state.blue.lifecycle = 'retired';
    }
    state.phase = 'finalized';
    state.rollbackReady = false;
    state.contractCleanupApplied = true;
    state.timestamps.finalizedAt = timestamp();
    operation('finalize', state.active);
    return snapshot();
  }

  function fail(reason: string): RehearsalSnapshot {
    setFailure(reason);
    return snapshot();
  }

  function readiness(): RehearsalReadinessResult {
    return checkReadiness();
  }

  return Object.freeze({
    prepare,
    checkReadiness,
    readiness,
    markGreenReady,
    cutover,
    drain,
    rollback,
    finalize,
    fail,
    snapshot,
    queue: queueController,
    imapIdle: imapController,
  });
}

export function createDockerReplacementRehearsal(input: DockerRehearsalInput = {}): UpgradeRehearsal {
  return createEngine('docker', input);
}

export function createDockerBlueGreenRehearsal(input: DockerRehearsalInput = {}): UpgradeRehearsal {
  return createDockerReplacementRehearsal(input);
}

export function createDockerRehearsal(input: DockerRehearsalInput = {}): UpgradeRehearsal {
  return createDockerReplacementRehearsal(input);
}

export function createKubernetesBlueGreenRehearsal(input: KubernetesRehearsalInput = {}): UpgradeRehearsal {
  return createEngine('kubernetes', input);
}

export function createKubernetesRehearsal(input: KubernetesRehearsalInput = {}): UpgradeRehearsal {
  return createKubernetesBlueGreenRehearsal(input);
}

export function createUpgradeRehearsal(input: UpgradeRehearsalInput): UpgradeRehearsal {
  return input.platform === 'docker'
    ? createDockerReplacementRehearsal(input)
    : createKubernetesBlueGreenRehearsal(input);
}

function runSuccessful(rehearsal: UpgradeRehearsal): RehearsalSnapshot {
  rehearsal.prepare();
  const readiness = rehearsal.checkReadiness();
  if (!readiness.passed) throw new RehearsalError('synthetic green did not pass readiness', 'GREEN_NOT_READY');
  rehearsal.cutover();
  rehearsal.drain();
  return rehearsal.finalize();
}

export function runDockerReplacementRehearsal(input: DockerRehearsalInput = {}): RehearsalSnapshot {
  return runSuccessful(createDockerReplacementRehearsal(input));
}

export function runDockerBlueGreenRehearsal(input: DockerRehearsalInput = {}): RehearsalSnapshot {
  return runDockerReplacementRehearsal(input);
}

export function runKubernetesBlueGreenRehearsal(input: KubernetesRehearsalInput = {}): RehearsalSnapshot {
  return runSuccessful(createKubernetesBlueGreenRehearsal(input));
}
