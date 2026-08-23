// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPATIBILITY_WINDOWS,
  CONNECTION_TYPES,
  CONTROL_PLANE_OPERATIONS,
  DEPLOYMENT_ACTIONS,
  MIGRATION_PHASES,
  OPERATION_STATES,
  createConnectionDrainPlan,
  createDockerReplacementPlan,
  createKubernetesBlueGreenPlan,
  createMigrationCheckpoint,
  createPreflightEvidence,
  createSchemaMigrationPlan,
  createUpgradeController,
  createUpgradeRequest,
  evaluateCompatibility,
  validateAllowlistedAction,
} from './index.mjs';

const SOURCE_DIGEST = `sha256:${'1'.repeat(64)}`;
const TARGET_DIGEST = `sha256:${'2'.repeat(64)}`;
const ACTOR = Object.freeze({ role: 'provider', actorId: 'ops-001', providerId: 'provider-001' });
const TARGET = Object.freeze({
  sourceVersion: '0.0.0',
  sourceDigest: SOURCE_DIGEST,
  targetVersion: '0.1.0',
  targetDigest: TARGET_DIGEST,
  platform: 'docker',
  idempotencyKey: 'upgrade-001',
});

function allPreflight() {
  return {
    imageVerified: true,
    schemaCompatible: true,
    greenReady: true,
    dependenciesHealthy: true,
    sharedExternalState: true,
    queuePersistent: true,
    connectionsReconnectable: true,
    backupFresh: true,
    auditReady: true,
  };
}

function dockerDeployment() {
  return {
    projectName: 'gulogulo',
    externalVolumes: ['runtime-state', 'mail-data', 'dav-data', 'backup-data'],
    sharedState: [
      'external-postgresql',
      'external-ldap',
      'mail-data',
      'dav-data',
      'backup-data',
      'persistent-mail-queue',
    ],
    queue: { queueRef: 'persistent-mail-queue' },
    drain: { gracePeriodSeconds: 90, connections: { http: 3, websocket: 2, imap_idle: 4, smtp: 1, dav: 1 } },
  };
}

test('migration compatibility follows expand, backfill, switch, contract', () => {
  const plan = createSchemaMigrationPlan({ sourceVersion: '1.2.0', targetVersion: '1.3.0' });
  assert.deepEqual(plan.phases, MIGRATION_PHASES);
  assert.equal(plan.compatibilityWindow, COMPATIBILITY_WINDOWS[0]);
  assert.equal(plan.rollbackSafe, true);
  assert.throws(
    () => createSchemaMigrationPlan({ sourceVersion: '1.2.0', targetVersion: '1.3.0', phases: ['expand', 'switch', 'backfill', 'contract'] }),
    (error) => error.code === 'INVALID_MIGRATION_PHASES',
  );
  assert.throws(
    () => createSchemaMigrationPlan({ sourceVersion: '1.2.0', targetVersion: '1.3.0', destructiveChanges: true }),
    (error) => error.code === 'DESTRUCTIVE_MIGRATION_FORBIDDEN',
  );
});

test('upgrade request rejects same targets and unsafe execution inputs', () => {
  const request = createUpgradeRequest(TARGET);
  assert.equal(request.strategy, 'blue_green');
  assert.equal(request.migration.sourceVersion, TARGET.sourceVersion);
  assert.throws(
    () => createUpgradeRequest({ ...TARGET, sourceDigest: TARGET_DIGEST }),
    (error) => error.code === 'SAME_SOURCE_AND_TARGET',
  );
  assert.throws(
    () => createUpgradeRequest({ ...TARGET, platform: 'shell' }),
    (error) => error.code === 'INVALID_PLATFORM',
  );
  assert.throws(
    () => createUpgradeRequest({ ...TARGET, idempotencyKey: '../docker socket' }),
    (error) => error.code === 'INVALID_CONFIGURATION',
  );
});

test('Docker replacement shares external state and never copies mailbox data', () => {
  const plan = createDockerReplacementPlan({ sourceDigest: SOURCE_DIGEST, targetDigest: TARGET_DIGEST, ...dockerDeployment() });
  assert.equal(plan.platform, 'docker');
  assert.equal(plan.mailboxCopy, false);
  assert.equal(plan.rollbackReady, true);
  assert.ok(plan.externalVolumes.includes('mail-data'));
  assert.ok(plan.actions.includes('edge.cutover_green'));
  assert.equal(plan.queue.idempotentDelivery, true);
  assert.equal(plan.drain.duplicateDeliveryProtection, true);
  assert.throws(
    () => createDockerReplacementPlan({ sourceDigest: SOURCE_DIGEST, targetDigest: TARGET_DIGEST, sharedState: ['mailbox-copy'] }),
    (error) => error.code === 'STATE_REFERENCE_FORBIDDEN',
  );
  assert.throws(
    () => createDockerReplacementPlan({ sourceDigest: SOURCE_DIGEST, targetDigest: TARGET_DIGEST, queue: { persistent: false } }),
    (error) => error.code === 'QUEUE_NOT_PERSISTENT',
  );
});

test('Kubernetes plan enforces readiness, PDB, external state, and bounded drain', () => {
  const plan = createKubernetesBlueGreenPlan({
    sourceDigest: SOURCE_DIGEST,
    targetDigest: TARGET_DIGEST,
    namespace: 'gulogulo',
    deploymentPrefix: 'gulogulo',
    serviceName: 'gulogulo-web',
    maxSurge: 2,
    maxUnavailable: 0,
    podDisruptionBudgetMinAvailable: 1,
    terminationGracePeriodSeconds: 120,
  });
  assert.equal(plan.blueDeployment, 'gulogulo-blue');
  assert.equal(plan.greenDeployment, 'gulogulo-green');
  assert.equal(plan.readiness.maxUnavailable, 0);
  assert.equal(plan.readiness.startupProbe, true);
  assert.equal(plan.readiness.podDisruptionBudgetMinAvailable, 1);
  assert.ok(plan.actions.includes('kubernetes.cutover_service'));
  assert.throws(
    () => createKubernetesBlueGreenPlan({ sourceDigest: SOURCE_DIGEST, targetDigest: TARGET_DIGEST, maxUnavailable: 1 }),
    (error) => error.code === 'READINESS_POLICY_VIOLATION',
  );
});

test('allowlisted actions contain no raw shell or kubectl command', () => {
  const action = validateAllowlistedAction({
    platform: 'kubernetes',
    action: 'kubernetes.cutover_service',
    namespace: 'gulogulo',
    resource: 'gulogulo-web',
    imageDigest: TARGET_DIGEST,
  });
  assert.equal(action.rawCommand, undefined);
  assert.throws(
    () => validateAllowlistedAction({ platform: 'kubernetes', action: 'kubectl delete pvc', namespace: 'gulogulo', resource: 'gulogulo-web' }),
    (error) => error.code === 'ACTION_NOT_ALLOWLISTED',
  );
});

test('connection drain covers HTTP, WebSocket, IMAP IDLE, SMTP, and DAV', () => {
  const plan = createConnectionDrainPlan({ connections: { websocket: 2, imap_idle: 5 } });
  assert.deepEqual(Object.keys(plan.connections), CONNECTION_TYPES);
  assert.deepEqual(plan.drainOrder, ['websocket', 'imap_idle', 'dav', 'smtp', 'http']);
  assert.equal(plan.eventContinuity, 'resume_from_last_event_id');
  assert.equal(plan.duplicateDeliveryProtection, true);
  assert.throws(
    () => createConnectionDrainPlan({ gracePeriodSeconds: 1 }),
    (error) => error.code === 'INVALID_CONFIGURATION',
  );
});

test('provider control plane is idempotent and tenant roles are denied', () => {
  let tick = 0;
  const controller = createUpgradeController({ clock: () => `2026-08-23T00:00:0${tick++}.000Z` });
  const capabilities = controller.capabilities();
  assert.deepEqual(capabilities.operations, CONTROL_PLANE_OPERATIONS);
  assert.equal(capabilities.arbitraryDockerSocket, false);
  assert.equal(capabilities.unrestrictedKubectl, false);

  assert.throws(
    () => controller.plan({ actor: { role: 'tenant', actorId: 'tenant-001', providerId: 'provider-001' }, request: TARGET }),
    (error) => error.code === 'TENANT_CONTROL_PLANE_FORBIDDEN',
  );
  const first = controller.plan({ actor: ACTOR, request: TARGET });
  const second = controller.plan({ actor: ACTOR, request: TARGET });
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.correlationId, 'corr-upgrade-000001');
  assert.equal(first.state, 'planned');
  assert.throws(
    () => controller.plan({ actor: ACTOR, request: { ...TARGET, targetVersion: '0.2.0', idempotencyKey: TARGET.idempotencyKey } }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('provider control plane enforces preflight, prepare, cutover, rollback, and finalize gates', () => {
  const controller = createUpgradeController({ operationIdFactory: () => 'upgrade-test-001', clock: () => '2026-08-23T00:00:00.000Z' });
  const planned = controller.plan({ actor: ACTOR, request: TARGET });
  assert.throws(
    () => controller.prepare({ actor: ACTOR, operationId: planned.operationId, deployment: dockerDeployment() }),
    (error) => error.code === 'PREFLIGHT_REQUIRED',
  );
  assert.throws(
    () => controller.preflight({ actor: ACTOR, operationId: planned.operationId, evidence: { ...allPreflight(), greenReady: false } }),
    (error) => error.code === 'PREFLIGHT_FAILED',
  );
  const failedRollback = controller.rollback({ actor: ACTOR, operationId: planned.operationId, reason: 'preflight failed; keep blue serving' });
  assert.equal(failedRollback.state, 'rolled_back');

  const secondController = createUpgradeController({ operationIdFactory: () => 'upgrade-test-002', clock: () => '2026-08-23T00:00:00.000Z' });
  const second = secondController.plan({ actor: ACTOR, request: { ...TARGET, idempotencyKey: 'upgrade-002' } });
  const preflight = secondController.preflight({ actor: ACTOR, operationId: second.operationId, evidence: allPreflight() });
  assert.equal(preflight.state, 'preflight_passed');
  const prepared = secondController.prepare({ actor: ACTOR, operationId: second.operationId, deployment: dockerDeployment() });
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.rollout.mailboxCopy, false);
  assert.throws(
    () => secondController.cutover({ actor: ACTOR, operationId: second.operationId }),
    (error) => error.code === 'GREEN_NOT_READY',
  );
  const servingGreen = secondController.cutover({ actor: ACTOR, operationId: second.operationId, greenReady: true });
  assert.equal(servingGreen.state, 'serving_green');
  const rolledBack = secondController.rollback({ actor: ACTOR, operationId: second.operationId, reason: 'synthetic SLO breach' });
  assert.equal(rolledBack.state, 'rolled_back');
  const finalized = secondController.finalize({ actor: ACTOR, operationId: second.operationId, observationWindowComplete: true, restoreCheckPassed: true });
  assert.equal(finalized.state, 'finalized');
  assert.equal(finalized.rollbackReady, false);
  assert.ok(finalized.audit.some((event) => event.event === 'upgrade.rollback'));
});

test('checkpoints require forward compatibility and are auditable', () => {
  const checkpoint = createMigrationCheckpoint({
    operationId: 'upgrade-000001',
    phase: 'backfill',
    completedAt: '2026-08-23T00:00:00.000Z',
    processedItems: 100,
    remainingItems: 20,
    forwardCompatible: true,
  });
  assert.equal(checkpoint.forwardCompatible, true);
  assert.throws(
    () => createMigrationCheckpoint({ ...checkpoint, forwardCompatible: false }),
    (error) => error.code === 'INCOMPATIBLE_CHECKPOINT',
  );
  const compatibility = evaluateCompatibility({
    sourceVersion: '0.0.0',
    sourceDigest: SOURCE_DIGEST,
    targetVersion: '0.1.0',
    targetDigest: TARGET_DIGEST,
  });
  assert.equal(compatibility.rollbackKeepsSourceReadable, true);
  assert.equal(compatibility.contractDeferredUntilFinalize, true);
});

test('preflight evidence defaults closed and requires every gate', () => {
  const failed = createPreflightEvidence({ imageVerified: true });
  assert.equal(failed.passed, false);
  assert.throws(() => createPreflightEvidence({ imageVerified: 'true' }), (error) => error.code === 'INVALID_CONFIGURATION');
  const passed = createPreflightEvidence(allPreflight());
  assert.equal(passed.passed, true);
  assert.equal(OPERATION_STATES.includes('finalized'), true);
  assert.deepEqual(DEPLOYMENT_ACTIONS.docker.includes('docker.prepare_green'), true);
});
