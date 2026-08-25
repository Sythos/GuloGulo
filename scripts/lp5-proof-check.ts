// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createImapIdleBroker } from '../src/mail/imap-idle.ts';
import { createMailQueue } from '../src/mail/mail-queue.ts';
import { AMD64_LOCAL_PROOF_BUDGET, evaluateCapacity, percentile, type CapacityMeasurement } from '../src/capacity/capacity-contract.ts';
import { createTenantContext } from '../src/integrations/tenant-context.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`LP5 proof check requires ${name}.`);
  return value;
}

function requiredNumber(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isFinite(value) || value < 0) throw new Error(`LP5 proof check requires a non-negative number in ${name}.`);
  return value;
}

function requiredInteger(name: string): number {
  const value = requiredNumber(name);
  if (!Number.isSafeInteger(value)) throw new Error(`LP5 proof check requires an integer in ${name}.`);
  return value;
}

async function timedRequest(baseUrl: string, path: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  if (response.status >= 500) throw new Error(`${path} returned ${response.status}`);
  await response.arrayBuffer();
  return performance.now() - started;
}

async function p95(baseUrl: string, path: string, count: number): Promise<{ readonly p95: number; readonly errors: number }> {
  const results = await Promise.allSettled(Array.from({ length: count }, () => timedRequest(baseUrl, path)));
  const values = results.filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled').map((result) => result.value);
  if (values.length === 0) throw new Error(`all LP5 ${path} probes failed`);
  return Object.freeze({ p95: percentile(values, 95), errors: results.length - values.length });
}

const baseUrl = requiredEnvironment('LP5_BASE_URL').replace(/\/$/u, '');
requiredEnvironment('LP5_LOGIN_EMAIL');
requiredEnvironment('LP5_LOGIN_PASSWORD');
const startupMs = requiredNumber('LP5_STARTUP_MS');
const readinessMs = requiredNumber('LP5_READINESS_MS');
const memoryMiB = requiredNumber('LP5_MEMORY_MIB');
const cpuMillis = requiredNumber('LP5_CPU_MILLIS');
const pids = requiredInteger('LP5_PIDS');
const web = await p95(baseUrl, '/', 24);
const dav = await p95(baseUrl, '/.well-known/caldav', 16);
const ready = await fetch(`${baseUrl}/health/ready`);
if (!ready.ok) throw new Error(`LP5 readiness returned ${ready.status}`);

const context = createTenantContext({
  tenantId: requiredEnvironment('LP5_TENANT_ID'),
  domain: requiredEnvironment('LP5_TENANT_DOMAIN'),
  actorId: requiredEnvironment('LP5_USER_ID'),
  role: 'user',
});
const queue = createMailQueue();
const queueStarted = performance.now();
for (let index = 0; index < 16; index += 1) {
  const entry = queue.enqueue(context, { sender: 'alice@example.test', recipients: ['alice@example.test'], sizeBytes: 128 } as never);
  queue.claim(entry.queueId, context);
  queue.complete(entry.queueId, context, { state: 'delivered' } as never);
}
const queueP95Ms = performance.now() - queueStarted;

const idle = createImapIdleBroker();
const subscriptions = Array.from({ length: 8 }, () => idle.subscribe(context, { userId: 'alice', mailbox: 'INBOX', onEvent: () => undefined }));
const idleStarted = performance.now();
const notification = idle.notify(context, { userId: 'alice', mailbox: 'INBOX', uidNext: 2 });
const idleNotifyP95Ms = performance.now() - idleStarted;
for (const subscription of subscriptions) subscription.close();
if (notification.delivered !== 8 || idle.count() !== 0) throw new Error('LP5 IDLE probe did not deliver and close all subscriptions');

const measurement: CapacityMeasurement = {
  platform: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
  startupMs,
  readinessMs,
  webP95Ms: web.p95,
  davP95Ms: dav.p95,
  queueP95Ms,
  idleNotifyP95Ms,
  httpErrorRate: (web.errors + dav.errors) / 40,
  activeIdleConnections: 8,
  memoryMiB,
  cpuMillis,
  pids,
};
const report = evaluateCapacity(measurement, AMD64_LOCAL_PROOF_BUDGET);
if (report.status !== 'pass') throw new Error(`LP5 proof failed: ${JSON.stringify(report.violations)}`);

console.log(JSON.stringify({
  milestone: 'LP5',
  platform: report.platform,
  budget: report.budget,
  measured: report.measured,
  status: report.status,
}, null, 2));
