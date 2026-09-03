// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

export type CapacityMetricName =
  | 'startupMs'
  | 'readinessMs'
  | 'webP95Ms'
  | 'davP95Ms'
  | 'queueP95Ms'
  | 'idleNotifyP95Ms'
  | 'httpErrorRate'
  | 'activeIdleConnections'
  | 'memoryMiB'
  | 'cpuMillis'
  | 'pids';

export interface CapacityBudget {
  readonly startupMs: number;
  readonly readinessMs: number;
  readonly webP95Ms: number;
  readonly davP95Ms: number;
  readonly queueP95Ms: number;
  readonly idleNotifyP95Ms: number;
  readonly httpErrorRate: number;
  readonly activeIdleConnections: number;
  readonly memoryMiB: number;
  readonly cpuMillis: number;
  readonly pids: number;
}

export interface CapacityMeasurement extends Partial<CapacityBudget> {
  readonly platform: 'linux/amd64' | 'linux/arm64';
  readonly samples?: Readonly<Record<string, readonly number[]>>;
}

export interface CapacityViolation {
  readonly metric: CapacityMetricName;
  readonly actual: number;
  readonly expected: number;
  readonly comparison: 'maximum' | 'minimum';
}

export interface CapacityReport {
  readonly platform: CapacityMeasurement['platform'];
  readonly status: 'pass' | 'fail';
  readonly measured: Readonly<CapacityMeasurement>;
  readonly budget: Readonly<CapacityBudget>;
  readonly violations: readonly CapacityViolation[];
}

export const AMD64_LOCAL_PROOF_BUDGET: Readonly<CapacityBudget> = Object.freeze({
  startupMs: 60_000,
  readinessMs: 45_000,
  webP95Ms: 750,
  davP95Ms: 1_000,
  queueP95Ms: 1_000,
  idleNotifyP95Ms: 1_000,
  httpErrorRate: 0,
  activeIdleConnections: 8,
  memoryMiB: 768,
  cpuMillis: 2_000,
  pids: 256,
});

const METRICS: readonly CapacityMetricName[] = Object.freeze([
  'startupMs', 'readinessMs', 'webP95Ms', 'davP95Ms', 'queueP95Ms',
  'idleNotifyP95Ms', 'httpErrorRate', 'activeIdleConnections', 'memoryMiB',
  'cpuMillis', 'pids',
]);
const MINIMUM_METRICS = new Set<CapacityMetricName>(['activeIdleConnections']);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cloneMeasurement(measurement: CapacityMeasurement): CapacityMeasurement {
  const samples = measurement.samples === undefined
    ? undefined
    : Object.freeze(Object.fromEntries(Object.entries(measurement.samples).map(([key, values]) => [key, Object.freeze([...values])]))) as Readonly<Record<string, readonly number[]>>;
  return Object.freeze({ ...measurement, ...(samples === undefined ? {} : { samples }) });
}

function assertPlatform(value: unknown): asserts value is CapacityMeasurement['platform'] {
  if (value !== 'linux/amd64' && value !== 'linux/arm64') throw new TypeError('capacity platform must be linux/amd64 or linux/arm64');
}

export function percentile(samples: readonly number[], percentileValue: number): number {
  if (!Number.isInteger(percentileValue) || percentileValue < 1 || percentileValue > 100) throw new RangeError('percentile must be an integer between 1 and 100');
  if (samples.length === 0 || samples.some((value) => !isFiniteNonNegative(value))) throw new TypeError('samples must contain finite non-negative numbers');
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1];
}

export function createCapacityMeasurement(input: CapacityMeasurement): Readonly<CapacityMeasurement> {
  assertPlatform(input.platform);
  for (const metric of METRICS) {
    const value = input[metric];
    if (value !== undefined && !isFiniteNonNegative(value)) throw new TypeError(`${metric} must be a finite non-negative number`);
  }
  for (const [name, values] of Object.entries(input.samples ?? {})) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/u.test(name) || !Array.isArray(values)) throw new TypeError('sample keys and values are invalid');
    percentile(values, 95);
  }
  return cloneMeasurement(input);
}

export function evaluateCapacity(input: CapacityMeasurement, budget: CapacityBudget = AMD64_LOCAL_PROOF_BUDGET): CapacityReport {
  const measured = createCapacityMeasurement(input);
  for (const metric of METRICS) {
    if (!isFiniteNonNegative(budget[metric])) throw new TypeError(`budget ${metric} must be a finite non-negative number`);
    if (measured[metric] === undefined) throw new TypeError(`measurement ${metric} is required`);
  }
  const violations: CapacityViolation[] = [];
  for (const metric of METRICS) {
    const actual = measured[metric]!;
    const expected = budget[metric];
    const comparison = MINIMUM_METRICS.has(metric) ? 'minimum' : 'maximum';
    if ((comparison === 'minimum' && actual < expected) || (comparison === 'maximum' && actual > expected)) {
      violations.push(Object.freeze({ metric, actual, expected, comparison }));
    }
  }
  return Object.freeze({
    platform: measured.platform,
    status: violations.length === 0 ? 'pass' : 'fail',
    measured,
    budget: Object.freeze({ ...budget }),
    violations: Object.freeze(violations),
  });
}
