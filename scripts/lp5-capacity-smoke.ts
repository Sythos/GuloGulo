// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { percentile, type CapacityMeasurement } from '../src/capacity/capacity-contract.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`LP5 capacity smoke requires ${name}.`);
  return value;
}

function requiredNumber(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isFinite(value) || value < 0) throw new Error(`LP5 capacity smoke requires a non-negative number in ${name}.`);
  return value;
}

function requiredInteger(name: string): number {
  const value = requiredNumber(name);
  if (!Number.isSafeInteger(value)) throw new Error(`LP5 capacity smoke requires an integer in ${name}.`);
  return value;
}

async function timedRequest(baseUrl: string, path: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
  if (response.status >= 500) throw new Error(`${path} returned ${response.status}`);
  await response.arrayBuffer();
  return performance.now() - started;
}

async function p95(baseUrl: string, path: string, count: number): Promise<{ p95: number; errors: number }> {
  const results = await Promise.allSettled(Array.from({ length: count }, () => timedRequest(baseUrl, path)));
  const durations = results.filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled').map((result) => result.value);
  const errors = results.length - durations.length;
  if (durations.length === 0) throw new Error(`all ${path} probes failed`);
  return { p95: percentile(durations, 95), errors };
}

const baseUrl = requiredEnvironment('LP5_BASE_URL').replace(/\/$/u, '');
const outputPath = requiredEnvironment('LP5_CAPACITY_REPORT_PATH');
const startupMs = requiredNumber('LP5_STARTUP_MS');
const readinessMs = requiredNumber('LP5_READINESS_MS');
const queueP95Ms = requiredNumber('LP5_QUEUE_P95_MS');
const idleNotifyP95Ms = requiredNumber('LP5_IDLE_NOTIFY_P95_MS');
const activeIdleConnections = requiredInteger('LP5_ACTIVE_IDLE_CONNECTIONS');
const memoryMiB = requiredNumber('LP5_MEMORY_MIB');
const cpuMillis = requiredNumber('LP5_CPU_MILLIS');
const pids = requiredInteger('LP5_PIDS');
const web = await p95(baseUrl, '/', 24);
const dav = await p95(baseUrl, '/.well-known/caldav', 16);

const measurement: CapacityMeasurement = {
  platform: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
  startupMs,
  readinessMs,
  webP95Ms: web.p95,
  davP95Ms: dav.p95,
  queueP95Ms,
  idleNotifyP95Ms,
  httpErrorRate: (web.errors + dav.errors) / 40,
  activeIdleConnections,
  memoryMiB,
  cpuMillis,
  pids,
  samples: { webRequestMs: [web.p95], davRequestMs: [dav.p95] },
};

await writeFile(resolve(outputPath), `${JSON.stringify(measurement, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ milestone: 'LP5', reportPath: outputPath, platform: measurement.platform, status: 'measured' }, null, 2));
