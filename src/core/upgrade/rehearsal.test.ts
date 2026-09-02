// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_STATE_REFERENCES,
  REHEARSAL_OPERATIONS,
  createDockerReplacementRehearsal,
  createKubernetesBlueGreenRehearsal,
} from './rehearsal.ts';

const SOURCE_DIGEST = `sha256:${'1'.repeat(64)}`;
const TARGET_DIGEST = `sha256:${'2'.repeat(64)}`;

const BASE_INPUT = Object.freeze({
  source: Object.freeze({ version: '0.0.0', digest: SOURCE_DIGEST }),
  target: Object.freeze({ version: '0.1.0', digest: TARGET_DIGEST }),
  externalState: EXTERNAL_STATE_REFERENCES,
  volumes: Object.freeze([
    Object.freeze({ name: 'runtime-state', fingerprint: 'runtime-fingerprint' }),
    Object.freeze({ name: 'mail-data', fingerprint: 'mail-fingerprint' }),
    Object.freeze({ name: 'dav-data', fingerprint: 'dav-fingerprint' }),
    Object.freeze({ name: 'backup-data', fingerprint: 'backup-fingerprint' }),
  ]),
  startAt: '2026-08-27T10:00:00.000Z',
});

test('Docker replacement retains external state and completes every blue/green phase', () => {
  const rehearsal = createDockerReplacementRehearsal({
    ...BASE_INPUT,
    queue: [
      { deliveryId: 'delivery-a', envelopeId: 'envelope-a' },
      { deliveryId: 'delivery-b', envelopeId: 'envelope-b' },
    ],
    imapIdle: { sessions: ['idle-a'] },
    connections: { http: 2, websocket: 1, imap_idle: 1, smtp: 1, dav: 1 },
  });

  const initial = rehearsal.snapshot();
  assert.equal(initial.phase, 'planned');
  assert.equal(initial.active, 'blue');
  assert.equal(initial.green.lifecycle, 'absent');
  assert.equal(initial.blue.release.version, '0.0.0');
  assert.deepEqual(initial.externalState.references, EXTERNAL_STATE_REFERENCES);

  const prepared = rehearsal.prepare();
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.green.externalStateShared, true);
  assert.deepEqual(prepared.green.volumeNames, prepared.volumes.map((volume) => volume.name));
  assert.equal(prepared.volumes.every((volume) => volume.retained && !volume.copied && !volume.deleted), true);

  const ready = rehearsal.checkReadiness();
  assert.equal(ready.passed, true);
  assert.equal(ready.checks.maxUnavailable, 0);
  assert.equal(ready.checks.greenReady, true);

  const cutover = rehearsal.cutover();
  assert.equal(cutover.phase, 'cutover');
  assert.equal(cutover.active, 'green');
  assert.equal(cutover.docker?.edgeTarget, 'green');
  assert.equal(cutover.queue.consumer, 'green');
  assert.equal(cutover.blue.serving, true);
  assert.equal(cutover.green.serving, true);

  const delivered = rehearsal.queue.deliver('delivery-a', 'green');
  const duplicate = rehearsal.queue.deliver('delivery-a', 'green');
  assert.equal(delivered.accepted, true);
  assert.equal(delivered.deliveryCount, 1);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicatePrevented, true);
  assert.equal(rehearsal.queue.snapshot().noDuplicateDelivery, true);

  rehearsal.imapIdle.disconnect('idle-a');
  const pendingEvent = rehearsal.imapIdle.emit({ eventId: 'event-a', kind: 'exists' });
  const reconnect = rehearsal.imapIdle.reconnect('idle-a', 'blue');
  const reconnectAgain = rehearsal.imapIdle.reconnect('idle-a', 'blue');
  assert.equal(reconnect.events.some((event) => event.eventId === pendingEvent.eventId), true);
  assert.equal(reconnectAgain.events.length, 0);
  assert.equal(reconnect.eventContinuity, true);

  const drained = rehearsal.drain();
  assert.equal(drained.phase, 'drained');
  assert.equal(drained.connections.drained, true);
  assert.equal(drained.connections.reconnectable, true);
  assert.equal(drained.imapIdle.eventContinuity, true);
  assert.equal(drained.imapIdle.lostEvents, 0);
  assert.equal(drained.imapIdle.sessions[0]?.side, 'green');
  assert.equal(drained.imapIdle.sessions[0]?.connected, true);

  const finalized = rehearsal.finalize();
  assert.equal(finalized.phase, 'finalized');
  assert.equal(finalized.active, 'green');
  assert.equal(finalized.blue.serving, false);
  assert.equal(finalized.green.serving, true);
  assert.equal(finalized.rollbackReady, false);
  assert.equal(finalized.sourcePreserved, true);
  assert.equal(finalized.volumesRetained, true);
  assert.equal(finalized.externalState.mutationCount, 0);
  assert.equal(finalized.contractCleanupApplied, true);
  assert.equal(finalized.safety.rawCommands, false);
  assert.equal(finalized.safety.unrestrictedHostAccess, false);
  assert.equal(finalized.safety.volumeDeletion, false);
  assert.equal(finalized.safety.mailboxCopy, false);
  assert.equal(finalized.operations.every((operation) => operation.rawCommand === undefined), true);
  assert.equal(finalized.operations.some((operation) => operation.action === 'prepare_green'), true);
  assert.equal(finalized.operations.some((operation) => operation.action === 'cutover_green'), true);
  assert.equal(finalized.operations.some((operation) => operation.action === 'drain_blue'), true);
  assert.equal(finalized.operations.some((operation) => operation.action === 'finalize'), true);
  assert.deepEqual(REHEARSAL_OPERATIONS.includes('rollback_blue'), true);
});

test('Kubernetes rehearsal gates readiness and changes only the stable service selector', () => {
  const rehearsal = createKubernetesBlueGreenRehearsal({
    ...BASE_INPUT,
    namespace: 'gulogulo',
    deploymentPrefix: 'gulogulo',
    serviceName: 'gulogulo-web',
    serviceSelector: { app: 'gulogulo-web', track: 'blue' },
    readiness: {
      maxUnavailable: 0,
      maxSurge: 2,
      podDisruptionBudgetMinAvailable: 1,
      startupProbe: true,
      livenessProbe: true,
      readinessProbe: true,
      terminationGracePeriodSeconds: 120,
    },
  });

  const before = rehearsal.snapshot();
  assert.equal(before.kubernetes?.blueDeployment, 'gulogulo-blue');
  assert.equal(before.kubernetes?.greenDeployment, 'gulogulo-green');
  assert.equal(before.service?.selector.track, 'blue');
  assert.equal(before.readiness.maxUnavailable, 0);
  assert.equal(before.readiness.maxSurge, 2);

  rehearsal.prepare();
  const readiness = rehearsal.readiness();
  assert.equal(readiness.passed, true);
  const cutover = rehearsal.cutover();
  assert.equal(cutover.service?.selector.track, 'green');
  assert.equal(cutover.kubernetes?.service.selector.track, 'green');
  assert.equal(cutover.kubernetes?.readiness.maxUnavailable, 0);
  assert.equal(cutover.blue.serving, true);

  rehearsal.drain();
  const finalized = rehearsal.finalize();
  assert.equal(finalized.service?.selector.track, 'green');
  assert.equal(finalized.kubernetes?.service.namespace, 'gulogulo');
  assert.equal(finalized.volumes.every((volume) => volume.retained), true);
});

test('Kubernetes rollback restores the blue selector while retaining green metadata for audit', () => {
  const rehearsal = createKubernetesBlueGreenRehearsal({
    ...BASE_INPUT,
    serviceSelector: { app: 'gulogulo-web', track: 'blue' },
    imapIdle: { sessions: ['idle-kubernetes'] },
  });

  rehearsal.prepare();
  assert.equal(rehearsal.checkReadiness().passed, true);
  assert.equal(rehearsal.cutover().service?.selector.track, 'green');
  const rolledBack = rehearsal.rollback('synthetic Kubernetes health regression');
  assert.equal(rolledBack.phase, 'rolled_back');
  assert.equal(rolledBack.active, 'blue');
  assert.equal(rolledBack.service?.selector.track, 'blue');
  assert.equal(rolledBack.kubernetes?.service.selector.track, 'blue');
  assert.equal(rolledBack.blue.release.version, '0.0.0');
  assert.equal(rolledBack.green.release.version, '0.1.0');
  assert.equal(rolledBack.blue.serving, true);
  assert.equal(rolledBack.green.serving, false);
  assert.equal(rolledBack.volumesRetained, true);
  assert.equal(rolledBack.imapIdle.sessions[0]?.side, 'blue');
});

test('failed readiness keeps blue and source active, and rollback is safe and idempotent', () => {
  const rehearsal = createDockerReplacementRehearsal({
    ...BASE_INPUT,
    greenReady: false,
    queue: ['delivery-failed'],
    imapIdle: { sessions: ['idle-failed'] },
  });

  rehearsal.prepare();
  const readiness = rehearsal.checkReadiness();
  assert.equal(readiness.passed, false);
  assert.equal(readiness.snapshot.phase, 'failed');
  assert.equal(readiness.snapshot.active, 'blue');
  assert.equal(readiness.snapshot.source.version, '0.0.0');
  assert.equal(readiness.snapshot.blue.serving, true);
  assert.equal(readiness.snapshot.green.serving, false);
  assert.equal(readiness.snapshot.sourcePreserved, true);
  assert.throws(
    () => rehearsal.cutover(),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'GREEN_NOT_READY',
  );

  const rolledBack = rehearsal.rollback('green readiness regression');
  assert.equal(rolledBack.phase, 'rolled_back');
  assert.equal(rolledBack.active, 'blue');
  assert.equal(rolledBack.queue.consumer, 'blue');
  assert.equal(rolledBack.rollbackReason, 'green readiness regression');
  assert.equal(rolledBack.failure?.reason, 'green readiness check failed');
  assert.equal(rolledBack.blue.release.digest, SOURCE_DIGEST);
  assert.equal(rolledBack.blue.serving, true);
  assert.equal(rolledBack.green.serving, false);
  assert.equal(rolledBack.volumesRetained, true);
  assert.equal(rolledBack.safety.volumeDeletion, false);

  const repeatedRollback = rehearsal.rollback('ignored on idempotent rollback');
  assert.deepEqual(repeatedRollback, rolledBack);
  const finalized = rehearsal.finalize();
  assert.equal(finalized.active, 'blue');
  assert.equal(finalized.blue.serving, true);
  assert.equal(finalized.green.lifecycle, 'retired');
  assert.equal(finalized.sourcePreserved, true);
});

test('strict input validation rejects unsafe selectors, duplicate queue entries, and invalid readiness', () => {
  assert.throws(
    () => createKubernetesBlueGreenRehearsal({ ...BASE_INPUT, serviceSelector: { track: 'green' } }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INVALID_SERVICE_SELECTOR',
  );
  assert.throws(
    () => createKubernetesBlueGreenRehearsal({ ...BASE_INPUT, readiness: { maxUnavailable: 1 } }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'READINESS_POLICY_VIOLATION',
  );
  assert.throws(
    () => createDockerReplacementRehearsal({
      ...BASE_INPUT,
      queue: [
        { deliveryId: 'delivery-duplicate', envelopeId: 'envelope-duplicate' },
        { deliveryId: 'delivery-other', envelopeId: 'envelope-duplicate' },
      ],
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'DUPLICATE_QUEUE_ENVELOPE',
  );
});
