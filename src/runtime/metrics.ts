// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

const METRIC_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_LABEL_PATTERN =
  /(?:authorization|cookie|password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|content|payload|message|body)/i;
const SAFE_VALUE_PATTERN = /^[\x20-\x7E]{1,128}$/;
const DEPENDENCY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

export const DEPENDENCY_STATUSES = Object.freeze([
  'ok',
  'starting',
  'degraded',
  'failed',
  'unknown',
  'disabled',
]);

export const DEPENDENCY_STATUS_CODES = Object.freeze({
  ok: 1,
  starting: 0,
  degraded: 0,
  failed: 0,
  unknown: 0,
  disabled: 1,
});

function assertMetricName(name) {
  if (typeof name !== 'string' || !METRIC_NAME_PATTERN.test(name)) {
    throw new TypeError('Metric names must use Prometheus-compatible characters');
  }

  if (SENSITIVE_LABEL_PATTERN.test(name)) {
    throw new TypeError('Sensitive values cannot be used as metric names');
  }

  return name;
}

function normalizeLabels(labels = {}) {
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new TypeError('Metric labels must be an object');
  }

  const normalized = {};
  for (const key of Object.keys(labels).sort()) {
    if (!LABEL_NAME_PATTERN.test(key) || SENSITIVE_LABEL_PATTERN.test(key)) {
      throw new TypeError('Metric labels must use safe, non-sensitive names');
    }

    const value = String(labels[key]);
    if (!SAFE_VALUE_PATTERN.test(value) || /["\\\r\n]/.test(value)) {
      throw new TypeError('Metric label values must be short printable strings');
    }

    normalized[key] = value;
  }

  return normalized;
}

function seriesKey(name, labels) {
  return name + '|' + JSON.stringify(labels);
}

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(name + ' must be a finite number');
  }

  return value;
}

function cloneLabels(labels) {
  return { ...labels };
}

function cloneSeries(series) {
  return {
    name: series.name,
    labels: cloneLabels(series.labels),
    value: series.value,
  };
}

function renderLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }

  return (
    '{' +
    entries
      .map(([key, value]) => key + '="' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')
      .join(',') +
    '}'
  );
}

function renderValue(value) {
  return Number.isFinite(value) ? String(value) : '0';
}

/**
 * Dependency-free metrics registry.
 *
 * The contract intentionally exposes counters, gauges, and histogram
 * count/sum observations plus a Prometheus-compatible text representation.
 * Labels are validated and sensitive label names are rejected to prevent
 * credentials, cookies, or message data from becoming high-cardinality
 * telemetry.
 */
export function createMetrics({ clock = () => new Date() } = {}) {
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();

  function increment(name, amount = 1, labels = {}) {
    assertMetricName(name);
    const value = finiteNumber(amount, 'Counter increment');
    if (value < 0) {
      throw new RangeError('Counter increments cannot be negative');
    }

    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(name, normalizedLabels);
    const current = counters.get(key) ?? {
      name,
      labels: normalizedLabels,
      value: 0,
    };
    current.value += value;
    counters.set(key, current);
    return current.value;
  }

  function set(name, value, labels = {}) {
    assertMetricName(name);
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(name, normalizedLabels);
    const current = gauges.get(key) ?? {
      name,
      labels: normalizedLabels,
      value: 0,
    };
    current.value = finiteNumber(value, 'Gauge value');
    gauges.set(key, current);
    return current.value;
  }

  function add(name, amount, labels = {}) {
    assertMetricName(name);
    const value = finiteNumber(amount, 'Gauge increment');
    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(name, normalizedLabels);
    const current = gauges.get(key) ?? {
      name,
      labels: normalizedLabels,
      value: 0,
    };
    current.value += value;
    gauges.set(key, current);
    return current.value;
  }

  function observe(name, value, labels = {}) {
    assertMetricName(name);
    const observation = finiteNumber(value, 'Histogram observation');
    if (observation < 0) {
      throw new RangeError('Histogram observations cannot be negative');
    }

    const normalizedLabels = normalizeLabels(labels);
    const key = seriesKey(name, normalizedLabels);
    const current = histograms.get(key) ?? {
      name,
      labels: normalizedLabels,
      count: 0,
      sum: 0,
    };
    current.count += 1;
    current.sum += observation;
    histograms.set(key, current);
    return { count: current.count, sum: current.sum };
  }

  function recordRequest({
    method = 'GET',
    route = 'unknown',
    statusCode = 500,
    durationMs = 0,
  } = {}) {
    const normalizedMethod = String(method).toUpperCase();
    const normalizedRoute = String(route);
    const normalizedStatus = String(statusCode);
    increment('gulogulo_http_requests_total', 1, {
      method: normalizedMethod,
      route: normalizedRoute,
      status: normalizedStatus,
    });
    observe('gulogulo_http_request_duration_ms', durationMs, {
      method: normalizedMethod,
      route: normalizedRoute,
    });
  }

  function snapshot() {
    return {
      generated_at: clock().toISOString(),
      counters: [...counters.values()].sort((left, right) => left.name.localeCompare(right.name)).map(cloneSeries),
      gauges: [...gauges.values()].sort((left, right) => left.name.localeCompare(right.name)).map(cloneSeries),
      histograms: [...histograms.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((series) => ({
          name: series.name,
          labels: cloneLabels(series.labels),
          count: series.count,
          sum: series.sum,
        })),
    };
  }

  function toPrometheus() {
    const lines = [];
    const names = new Set([
      ...[...counters.values()].map((series) => series.name),
      ...[...gauges.values()].map((series) => series.name),
      ...[...histograms.values()].map((series) => series.name),
    ]);

    for (const name of [...names].sort()) {
      const counterSeries = [...counters.values()].filter((series) => series.name === name);
      const gaugeSeries = [...gauges.values()].filter((series) => series.name === name);
      const histogramSeries = [...histograms.values()].filter((series) => series.name === name);
      const type = counterSeries.length > 0 ? 'counter' : gaugeSeries.length > 0 ? 'gauge' : 'histogram';
      lines.push('# TYPE ' + name + ' ' + type);

      for (const series of counterSeries) {
        lines.push(name + renderLabels(series.labels) + ' ' + renderValue(series.value));
      }
      for (const series of gaugeSeries) {
        lines.push(name + renderLabels(series.labels) + ' ' + renderValue(series.value));
      }
      for (const series of histogramSeries) {
        lines.push(name + '_count' + renderLabels(series.labels) + ' ' + renderValue(series.count));
        lines.push(name + '_sum' + renderLabels(series.labels) + ' ' + renderValue(series.sum));
      }
    }

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  function reset() {
    counters.clear();
    gauges.clear();
    histograms.clear();
  }

  return Object.freeze({
    increment,
    set,
    add,
    observe,
    recordRequest,
    snapshot,
    toPrometheus,
    reset,
  });
}

function normalizeDependencyName(name) {
  if (typeof name !== 'string' || !DEPENDENCY_NAME_PATTERN.test(name)) {
    throw new TypeError('Dependency names must use short safe identifiers');
  }

  return name;
}

function normalizeDependencyStatus(status) {
  if (!DEPENDENCY_STATUSES.includes(status)) {
    throw new TypeError('Unsupported dependency status');
  }

  return status;
}

function normalizeReason(reason) {
  if (reason === undefined || reason === null) {
    return undefined;
  }

  const value = String(reason);
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
    return undefined;
  }

  return value;
}

function cloneDependency(entry) {
  return {
    status: entry.status,
    ...(entry.latency_ms === undefined ? {} : { latency_ms: entry.latency_ms }),
  };
}

/**
 * Keep dependency readiness explicit without attempting network calls.
 *
 * An empty registry is disabled rather than ready or failed. Disabled
 * dependencies do not block readiness; starting, degraded, failed, and
 * unknown dependencies do. The response contains only safe identifiers and
 * status values, never endpoints, DSNs, usernames, or secrets.
 */
export function createDependencyRegistry({
  initial = {},
  metrics = null,
  clock = () => new Date(),
} = {}) {
  const entries = new Map();

  function setStatus(name, status, { latencyMs, reason } = {}) {
    const normalizedName = normalizeDependencyName(name);
    const normalizedStatus = normalizeDependencyStatus(status);
    const entry = {
      status: normalizedStatus,
      checked_at: clock().toISOString(),
    };
    if (latencyMs !== undefined) {
      const value = finiteNumber(latencyMs, 'Dependency latency');
      if (value >= 0) {
        entry.latency_ms = value;
      }
    }

    const safeReason = normalizeReason(reason);
    if (safeReason !== undefined) {
      entry.reason = safeReason;
    }
    entries.set(normalizedName, entry);

    if (metrics !== null) {
      metrics.set(
        'gulogulo_dependency_status',
        DEPENDENCY_STATUS_CODES[normalizedStatus],
        { dependency: normalizedName },
      );
    }

    return cloneDependency(entry);
  }

  function loadInitial() {
    if (initial === null || typeof initial !== 'object' || Array.isArray(initial)) {
      throw new TypeError('Initial dependencies must be an object');
    }

    for (const [name, value] of Object.entries(initial)) {
      if (typeof value === 'string') {
        setStatus(name, value);
        continue;
      }

      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Dependency entries must be a status or options object');
      }

      setStatus(name, value.status ?? 'unknown', value);
    }
  }

  loadInitial();

  function get(name) {
    const entry = entries.get(normalizeDependencyName(name));
    return entry === undefined ? undefined : cloneDependency(entry);
  }

  function snapshot() {
    const result = {};
    for (const name of [...entries.keys()].sort()) {
      result[name] = cloneDependency(entries.get(name));
    }
    return result;
  }

  function overallStatus() {
    if (entries.size === 0) {
      return 'disabled';
    }

    for (const entry of entries.values()) {
      if (entry.status !== 'ok' && entry.status !== 'disabled') {
        return 'not_ready';
      }
    }

    return 'ok';
  }

  function isReady() {
    return overallStatus() !== 'not_ready';
  }

  return Object.freeze({
    setStatus,
    set: setStatus,
    get,
    snapshot,
    overallStatus,
    isReady,
  });
}
