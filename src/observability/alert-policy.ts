// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

const SAFE_SUBJECT_PATTERN = /^[A-Za-z0-9_.@:+/%/-]{1,192}$/u;
const SEVERITIES = Object.freeze(['warning', 'critical']);
const DEPENDENCY_STATUSES = new Set(['ok', 'starting', 'degraded', 'failed', 'unknown', 'disabled']);

const DEFAULT_THRESHOLDS = Object.freeze({
  dependency: Object.freeze({ failedAfterSeconds: 60 }),
  queue: Object.freeze({
    warningDepth: 100,
    criticalDepth: 1_000,
    warningOldestAgeSeconds: 300,
    criticalOldestAgeSeconds: 1_800,
  }),
  certificate: Object.freeze({ warningDaysRemaining: 30, criticalDaysRemaining: 7 }),
  storage: Object.freeze({ warningPercent: 80, criticalPercent: 90 }),
  quota: Object.freeze({ warningPercent: 80, criticalPercent: 90 }),
  authAbuse: Object.freeze({ warningFailures: 5, criticalFailures: 20, windowSeconds: 300 }),
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function positiveNumber(value, name, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be a finite number between 0 and ${maximum}`);
  }
  return value;
}

function integer(value, name, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function percent(value, name) {
  return positiveNumber(value, name, { maximum: 100 });
}

function mergeThresholds(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Alert thresholds must be an object');
  }

  const merged = {};
  for (const [category, defaults] of Object.entries(DEFAULT_THRESHOLDS)) {
    const override = overrides[category] ?? {};
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
      throw new TypeError(`Alert threshold ${category} must be an object`);
    }
    merged[category] = { ...defaults, ...override };
  }

  const dependency = merged.dependency;
  integer(dependency.failedAfterSeconds, 'dependency.failedAfterSeconds', { maximum: 86_400 });

  const queue = merged.queue;
  integer(queue.warningDepth, 'queue.warningDepth', { maximum: 1_000_000_000 });
  integer(queue.criticalDepth, 'queue.criticalDepth', { maximum: 1_000_000_000 });
  integer(queue.warningOldestAgeSeconds, 'queue.warningOldestAgeSeconds', { maximum: 31_536_000 });
  integer(queue.criticalOldestAgeSeconds, 'queue.criticalOldestAgeSeconds', { maximum: 31_536_000 });
  if (queue.criticalDepth < queue.warningDepth || queue.criticalOldestAgeSeconds < queue.warningOldestAgeSeconds) {
    throw new RangeError('Critical queue thresholds cannot be lower than warning thresholds');
  }

  const certificate = merged.certificate;
  integer(certificate.warningDaysRemaining, 'certificate.warningDaysRemaining', { maximum: 3650 });
  integer(certificate.criticalDaysRemaining, 'certificate.criticalDaysRemaining', { maximum: 3650 });
  if (certificate.criticalDaysRemaining > certificate.warningDaysRemaining) {
    throw new RangeError('Critical certificate threshold cannot exceed warning threshold');
  }

  for (const category of ['storage', 'quota']) {
    percent(merged[category].warningPercent, `${category}.warningPercent`);
    percent(merged[category].criticalPercent, `${category}.criticalPercent`);
    if (merged[category].criticalPercent < merged[category].warningPercent) {
      throw new RangeError(`Critical ${category} threshold cannot be lower than warning threshold`);
    }
  }

  const auth = merged.authAbuse;
  integer(auth.warningFailures, 'authAbuse.warningFailures', { maximum: 1_000_000 });
  integer(auth.criticalFailures, 'authAbuse.criticalFailures', { maximum: 1_000_000 });
  integer(auth.windowSeconds, 'authAbuse.windowSeconds', { maximum: 86_400 });
  if (auth.criticalFailures < auth.warningFailures) {
    throw new RangeError('Critical authentication threshold cannot be lower than warning threshold');
  }

  return merged;
}

function subject(value, fallback = 'global') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value);
  return SAFE_SUBJECT_PATTERN.test(normalized) ? normalized : fallback;
}

function numberValue(value, name) {
  return positiveNumber(value, name);
}

function addAlert(alerts, { code, severity, source, subject: alertSubject, observed, threshold, message }) {
  if (!SEVERITIES.includes(severity)) {
    throw new TypeError('Unsupported alert severity');
  }

  alerts.push({
    code,
    severity,
    source,
    subject: subject(alertSubject),
    observed,
    threshold,
    message,
  });
}

function evaluateDependencies(snapshot, thresholds, alerts) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return;
  }

  for (const [name, entry] of Object.entries(snapshot)) {
    if (entry === null || typeof entry !== 'object' || !DEPENDENCY_STATUSES.has(entry.status)) {
      continue;
    }
    const dependencySubject = subject(name);
    if (entry.status === 'failed') {
      addAlert(alerts, {
        code: 'dependency_failed',
        severity: 'critical',
        source: 'dependency',
        subject: dependencySubject,
        observed: entry.status,
        threshold: 'failed',
        message: 'A required dependency is failing',
      });
    } else if (entry.status === 'degraded' || entry.status === 'unknown' || entry.status === 'starting') {
      addAlert(alerts, {
        code: 'dependency_unready',
        severity: 'warning',
        source: 'dependency',
        subject: dependencySubject,
        observed: entry.status,
        threshold: thresholds.failedAfterSeconds,
        message: 'A dependency is not ready',
      });
    }
  }
}

function evaluateQueue(queue, thresholds, alerts) {
  if (queue === null || typeof queue !== 'object' || Array.isArray(queue)) {
    return;
  }
  if (queue.depth !== undefined) {
    const depth = numberValue(queue.depth, 'Queue depth');
    if (depth >= thresholds.criticalDepth) {
      addAlert(alerts, {
        code: 'queue_depth_critical', severity: 'critical', source: 'queue',
        observed: depth, threshold: thresholds.criticalDepth,
        message: 'Mail queue depth is critical',
      });
    } else if (depth >= thresholds.warningDepth) {
      addAlert(alerts, {
        code: 'queue_depth_high', severity: 'warning', source: 'queue',
        observed: depth, threshold: thresholds.warningDepth,
        message: 'Mail queue depth is high',
      });
    }
  }
  if (queue.oldestAgeSeconds !== undefined) {
    const age = numberValue(queue.oldestAgeSeconds, 'Oldest queue age');
    if (age >= thresholds.criticalOldestAgeSeconds) {
      addAlert(alerts, {
        code: 'queue_age_critical', severity: 'critical', source: 'queue',
        observed: age, threshold: thresholds.criticalOldestAgeSeconds,
        message: 'The oldest queued message is too old',
      });
    } else if (age >= thresholds.warningOldestAgeSeconds) {
      addAlert(alerts, {
        code: 'queue_age_high', severity: 'warning', source: 'queue',
        observed: age, threshold: thresholds.warningOldestAgeSeconds,
        message: 'The oldest queued message is aging',
      });
    }
  }
}

function evaluateCertificates(certificates, thresholds, alerts) {
  if (!Array.isArray(certificates)) {
    return;
  }
  for (const certificate of certificates) {
    if (certificate === null || typeof certificate !== 'object' || certificate.daysRemaining === undefined) {
      continue;
    }
    const days = Number(certificate.daysRemaining);
    if (!Number.isFinite(days)) {
      continue;
    }
    if (days <= thresholds.criticalDaysRemaining) {
      addAlert(alerts, {
        code: days < 0 ? 'certificate_expired' : 'certificate_expiry_critical',
        severity: 'critical', source: 'certificate', subject: certificate.name,
        observed: days, threshold: thresholds.criticalDaysRemaining,
        message: days < 0 ? 'A certificate is expired' : 'A certificate is close to expiry',
      });
    } else if (days <= thresholds.warningDaysRemaining) {
      addAlert(alerts, {
        code: 'certificate_expiry_warning', severity: 'warning', source: 'certificate', subject: certificate.name,
        observed: days, threshold: thresholds.warningDaysRemaining,
        message: 'A certificate is approaching expiry',
      });
    }
  }
}

function evaluateCapacity(entry, category, thresholds, alerts) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return;
  }
  let usedPercent = entry.usedPercent;
  if (usedPercent === undefined && entry.usedBytes !== undefined && entry.capacityBytes !== undefined) {
    const usedBytes = numberValue(entry.usedBytes, `${category} usedBytes`);
    const capacityBytes = numberValue(entry.capacityBytes, `${category} capacityBytes`);
    if (capacityBytes <= 0) {
      addAlert(alerts, {
        code: `${category}_capacity_invalid`, severity: 'critical', source: category,
        observed: capacityBytes, threshold: 1,
        message: `${category} capacity is invalid`,
      });
      return;
    }
    usedPercent = (usedBytes / capacityBytes) * 100;
  }
  if (usedPercent === undefined || !Number.isFinite(Number(usedPercent))) {
    return;
  }
  const percentage = positiveNumber(Number(usedPercent), `${category} usedPercent`);
  const limit = thresholds;
  const categorySubject = entry.subject;
  if (percentage >= limit.criticalPercent) {
    addAlert(alerts, {
      code: `${category}_pressure_critical`, severity: 'critical', source: category,
      subject: categorySubject, observed: percentage, threshold: limit.criticalPercent,
      message: `${category} usage is critical`,
    });
  } else if (percentage >= limit.warningPercent) {
    addAlert(alerts, {
      code: `${category}_pressure_high`, severity: 'warning', source: category,
      subject: categorySubject, observed: percentage, threshold: limit.warningPercent,
      message: `${category} usage is high`,
    });
  }
}

function evaluateAuthAbuse(entry, thresholds, alerts) {
  if (entry === null || typeof entry !== 'object' || entry.failedAttempts === undefined) {
    return;
  }
  const failures = numberValue(entry.failedAttempts, 'Authentication failures');
  const subjectValue = entry.subject;
  if (failures >= thresholds.criticalFailures) {
    addAlert(alerts, {
      code: 'auth_abuse_critical', severity: 'critical', source: 'auth_abuse',
      subject: subjectValue, observed: failures, threshold: thresholds.criticalFailures,
      message: 'Repeated authentication failures indicate abuse',
    });
  } else if (failures >= thresholds.warningFailures) {
    addAlert(alerts, {
      code: 'auth_abuse_warning', severity: 'warning', source: 'auth_abuse',
      subject: subjectValue, observed: failures, threshold: thresholds.warningFailures,
      message: 'Authentication failures are above the alert threshold',
    });
  }
}

/**
 * Create deterministic operational alerts from metadata-only health inputs.
 * The evaluator never accepts message bodies, endpoints, addresses, or
 * credentials and emits only safe identifiers and numeric measurements.
 */
export function createAlertPolicy({ thresholds = {}, clock = () => new Date() } = {}) {
  const normalizedThresholds = deepFreeze(mergeThresholds(thresholds));

  function evaluate(snapshot = {}) {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError('Alert snapshot must be an object');
    }

    const alerts = [];
    evaluateDependencies(snapshot.dependencies, normalizedThresholds.dependency, alerts);
    evaluateQueue(snapshot.queue, normalizedThresholds.queue, alerts);
    evaluateCertificates(snapshot.certificates, normalizedThresholds.certificate, alerts);
    evaluateCapacity(snapshot.storage, 'storage', normalizedThresholds.storage, alerts);
    evaluateCapacity(snapshot.quota, 'quota', normalizedThresholds.quota, alerts);
    evaluateAuthAbuse(snapshot.authAbuse, normalizedThresholds.authAbuse, alerts);

    const severityRank = { critical: 0, warning: 1 };
    alerts.sort((left, right) => {
      const severityDifference = severityRank[left.severity] - severityRank[right.severity];
      return severityDifference || left.code.localeCompare(right.code) || left.subject.localeCompare(right.subject);
    });

    const generatedAt = new Date(clock());
    if (Number.isNaN(generatedAt.getTime())) {
      throw new TypeError('Alert clock must return a valid date');
    }
    const frozenAlerts = alerts.map((alert) => Object.freeze({
      ...alert,
      generated_at: generatedAt.toISOString(),
    }));
    const critical = frozenAlerts.filter((alert) => alert.severity === 'critical').length;
    const warning = frozenAlerts.filter((alert) => alert.severity === 'warning').length;
    return Object.freeze({
      generated_at: generatedAt.toISOString(),
      status: critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'ok',
      critical,
      warning,
      alerts: Object.freeze(frozenAlerts),
    });
  }

  return Object.freeze({
    thresholds: normalizedThresholds,
    evaluate,
  });
}

export { DEFAULT_THRESHOLDS };
