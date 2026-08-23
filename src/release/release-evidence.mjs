// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

/**
 * M10 release-evidence contract.
 *
 * This module turns the final review into data that can be checked by a clean
 * checkout and by CI. It does not manufacture live infrastructure evidence:
 * an entry can be verified, contract-tested, or deliberately deferred with an
 * owner, mitigation, and approval. That distinction is what keeps a useful
 * V1 contract preview honest about the work still needed before production.
 */

const RELEASE_EVIDENCE_VERSION = '1.0';

const EVIDENCE_STATUSES = Object.freeze([
  'verified',
  'contract',
  'deferred',
  'exception',
]);

const SECURITY_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const SECURITY_FINDING_STATUSES = Object.freeze(['resolved', 'accepted', 'open']);
const RELEASE_DECISIONS = Object.freeze(['approved', 'conditional', 'blocked']);
const TEST_STATUSES = Object.freeze(['passed', 'conditional', 'not_run', 'failed']);
const REVIEW_STATUSES = Object.freeze(['passed', 'conditional', 'deferred']);

const REQUIRED_REVIEWS = Object.freeze([
  'threat-model',
  'tenant-isolation',
  'auth-and-abuse',
  'accessibility',
  'performance-capacity',
  'mail-interoperability',
  'dav-interoperability',
  'backup-restore',
  'blue-green-upgrade',
  'documentation-consistency',
]);

const REQUIRED_SECTION30_ITEMS = Object.freeze([
  'security.no-open-relay',
  'security.tls-certificates',
  'security.acme-renewal',
  'security.ldap-tls-bind',
  'security.postgresql-protection',
  'security.secret-store-rotation',
  'security.csp-csrf-headers',
  'security.email-html-sanitization',
  'security.rate-abuse-controls',
  'security.audit-no-secrets',
  'security.images-sbom-digest',
  'data.sources-of-truth',
  'data.quota-ledger',
  'data.retention-28-days',
  'data.user-backup-authorization',
  'data.provider-backup-encryption',
  'data.restore',
  'data.purge-idempotent',
  'data.account-deletion-runbook',
  'interop.smtp-imap',
  'interop.imap-idle',
  'interop.sieve',
  'interop.aliases',
  'interop.caldav',
  'interop.carddav',
  'interop.well-known',
  'interop.autodiscovery',
  'interop.ics-vcard',
  'interop.timezone',
  'operations.health-metrics',
  'operations.multi-architecture-images',
  'operations.log-rotation',
  'operations.alerts',
  'operations.postfix-queue',
  'operations.rspamd-clamav-updates',
  'operations.migration-contract',
  'operations.blue-green-rehearsal',
  'operations.rollback-rehearsal',
  'operations.rpo-rto',
  'operations.incident-dr',
  'governance.roles-delegation',
  'governance.master-log-access',
  'governance.api-mcp-readonly',
  'governance.future-features',
  'governance.adrs-current',
  'governance.deployment-docs',
]);

const SECTION30_DOMAINS = Object.freeze(['security', 'data', 'interop', 'operations', 'governance']);

const LOCAL_PATH_PATTERN = /(?:^[A-Za-z]:[\\/]|^\\\\|^\/Users\/|^\/home\/|^\/private\/|F:\\Dev\\GuloGulo|C:\\Users\\)/i;
const SECRET_PATTERN = /(?:-----BEGIN .*PRIVATE KEY-----|(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]|(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,})/i;

function releaseError(message, code = 'INVALID_RELEASE_EVIDENCE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw releaseError(`${field} must be an object`, 'INVALID_RELEASE_SHAPE');
  }
}

function assertString(value, field, { min = 1, max = 256 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || value.trim() !== value) {
    throw releaseError(`${field} must be a trimmed string of ${min}-${max} characters`, 'INVALID_RELEASE_FIELD');
  }
  return value;
}

function assertDate(value, field) {
  const date = assertString(value, field, { max: 64 });
  if (Number.isNaN(Date.parse(date))) {
    throw releaseError(`${field} must be an ISO-8601 date`, 'INVALID_RELEASE_DATE');
  }
  return date;
}

function assertSafeText(value, field) {
  const text = assertString(value, field, { max: 2048 });
  if (LOCAL_PATH_PATTERN.test(text) || SECRET_PATTERN.test(text)) {
    throw releaseError(`${field} contains a local path or secret-like value`, 'UNSAFE_RELEASE_EVIDENCE');
  }
  return text;
}

function assertSafeReference(value, field) {
  const reference = assertSafeText(value, field);
  if (reference.includes('\\') || reference.split('/').includes('..')) {
    throw releaseError(`${field} must be a repository-relative reference`, 'UNSAFE_RELEASE_REFERENCE');
  }
  return reference;
}

function assertEnum(value, field, allowed) {
  if (!allowed.includes(value)) {
    throw releaseError(`${field} must be one of: ${allowed.join(', ')}`, 'INVALID_RELEASE_ENUM');
  }
  return value;
}

function normalizeApproval(value, field) {
  assertPlainObject(value, field);
  return Object.freeze({
    approvedBy: assertSafeText(value.approvedBy, `${field}.approvedBy`),
    approvedAt: assertDate(value.approvedAt, `${field}.approvedAt`),
  });
}

function normalizeChecklistEntry(entry, index) {
  const field = `section30[${index}]`;
  assertPlainObject(entry, field);
  const id = assertString(entry.id, `${field}.id`, { max: 96 });
  if (!REQUIRED_SECTION30_ITEMS.includes(id)) {
    throw releaseError(`${field}.id is not an applicable Section 30 item`, 'UNKNOWN_SECTION30_ITEM');
  }
  const status = assertEnum(entry.status, `${field}.status`, EVIDENCE_STATUSES);
  const evidence = Array.isArray(entry.evidence)
    ? entry.evidence.map((value, evidenceIndex) => assertSafeReference(value, `${field}.evidence[${evidenceIndex}]`))
    : [];
  const normalized = {
    id,
    status,
    evidence: Object.freeze(evidence),
  };

  if (status === 'verified' || status === 'contract') {
    if (evidence.length === 0) {
      throw releaseError(`${field} needs at least one evidence reference`, 'MISSING_SECTION30_EVIDENCE');
    }
  } else {
    normalized.owner = assertSafeText(entry.owner, `${field}.owner`, { max: 128 });
    normalized.mitigation = assertSafeText(entry.mitigation, `${field}.mitigation`);
    normalized.rationale = assertSafeText(entry.rationale, `${field}.rationale`);
    normalized.approval = normalizeApproval(entry.approval, `${field}.approval`);
  }
  return Object.freeze(normalized);
}

function normalizeSecurityFinding(finding, index) {
  const field = `securityFindings[${index}]`;
  assertPlainObject(finding, field);
  const severity = assertEnum(finding.severity, `${field}.severity`, SECURITY_SEVERITIES);
  const status = assertEnum(finding.status, `${field}.status`, SECURITY_FINDING_STATUSES);
  if (status === 'open' && (severity === 'critical' || severity === 'high')) {
    throw releaseError(`${field} leaves a critical or high finding open`, 'UNRESOLVED_SECURITY_FINDING');
  }
  const normalized = {
    id: assertString(finding.id, `${field}.id`, { max: 96 }),
    title: assertSafeText(finding.title, `${field}.title`),
    severity,
    status,
  };
  if (status !== 'resolved') {
    normalized.owner = assertSafeText(finding.owner, `${field}.owner`, { max: 128 });
    normalized.mitigation = assertSafeText(finding.mitigation, `${field}.mitigation`);
    normalized.approval = normalizeApproval(finding.approval, `${field}.approval`);
  }
  return Object.freeze(normalized);
}

function normalizeTestEvidence(entry, index) {
  const field = `tests[${index}]`;
  assertPlainObject(entry, field);
  return Object.freeze({
    name: assertString(entry.name, `${field}.name`, { max: 128 }),
    command: assertSafeText(entry.command, `${field}.command`),
    status: assertEnum(entry.status, `${field}.status`, TEST_STATUSES),
    evidence: assertSafeReference(entry.evidence, `${field}.evidence`),
  });
}

function normalizeReview(entry, index) {
  const field = `reviews[${index}]`;
  assertPlainObject(entry, field);
  const status = assertEnum(entry.status, `${field}.status`, REVIEW_STATUSES);
  const normalized = {
    id: assertString(entry.id, `${field}.id`, { max: 96 }),
    status,
    evidence: Object.freeze((Array.isArray(entry.evidence) ? entry.evidence : [])
      .map((value, evidenceIndex) => assertSafeReference(value, `${field}.evidence[${evidenceIndex}]`))),
  };
  if (normalized.evidence.length === 0) {
    throw releaseError(`${field} needs at least one evidence reference`, 'MISSING_REVIEW_EVIDENCE');
  }
  if (status !== 'passed') {
    normalized.owner = assertSafeText(entry.owner, `${field}.owner`, { max: 128 });
    normalized.mitigation = assertSafeText(entry.mitigation, `${field}.mitigation`);
    normalized.approval = normalizeApproval(entry.approval, `${field}.approval`);
  }
  return Object.freeze(normalized);
}

function normalizeReviews(entries) {
  if (!Array.isArray(entries)) {
    throw releaseError('reviews must be an array', 'INVALID_RELEASE_SHAPE');
  }
  const normalized = entries.map(normalizeReview);
  const ids = new Set();
  for (const review of normalized) {
    if (!REQUIRED_REVIEWS.includes(review.id)) {
      throw releaseError(`${review.id} is not a required M10 review`, 'UNKNOWN_M10_REVIEW');
    }
    if (ids.has(review.id)) throw releaseError(`reviews contains duplicate item ${review.id}`, 'DUPLICATE_M10_REVIEW');
    ids.add(review.id);
  }
  const missing = REQUIRED_REVIEWS.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw releaseError(`reviews is missing: ${missing.join(', ')}`, 'M10_REVIEWS_INCOMPLETE');
  }
  return Object.freeze(normalized);
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw releaseError('artifacts must contain at least one repository-relative reference', 'MISSING_RELEASE_ARTIFACTS');
  }
  return Object.freeze(artifacts.map((artifact, index) => {
    const field = `artifacts[${index}]`;
    assertPlainObject(artifact, field);
    return Object.freeze({
      name: assertString(artifact.name, `${field}.name`, { max: 128 }),
      path: assertSafeReference(artifact.path, `${field}.path`),
      purpose: assertSafeText(artifact.purpose, `${field}.purpose`),
    });
  }));
}

function normalizeSection30(entries) {
  if (!Array.isArray(entries)) {
    throw releaseError('section30 must be an array', 'INVALID_RELEASE_SHAPE');
  }
  const normalized = entries.map(normalizeChecklistEntry);
  const ids = new Set();
  for (const entry of normalized) {
    if (ids.has(entry.id)) throw releaseError(`section30 contains duplicate item ${entry.id}`, 'DUPLICATE_SECTION30_ITEM');
    ids.add(entry.id);
  }
  const missing = REQUIRED_SECTION30_ITEMS.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    throw releaseError(`section30 is missing: ${missing.join(', ')}`, 'SECTION30_INCOMPLETE');
  }
  return Object.freeze(normalized);
}

function countStatuses(entries) {
  return Object.freeze(EVIDENCE_STATUSES.reduce((counts, status) => {
    counts[status] = entries.filter((entry) => entry.status === status).length;
    return counts;
  }, {}));
}

function createReleaseEvidence(input = {}) {
  assertPlainObject(input, 'releaseEvidence');
  const section30 = normalizeSection30(input.section30);
  const reviews = normalizeReviews(input.reviews);
  const securityFindings = Object.freeze((input.securityFindings ?? []).map(normalizeSecurityFinding));
  const tests = Object.freeze((input.tests ?? []).map(normalizeTestEvidence));
  const decision = assertEnum(input.releaseDecision, 'releaseDecision', RELEASE_DECISIONS);
  const normalized = {
    evidenceVersion: assertString(input.evidenceVersion ?? RELEASE_EVIDENCE_VERSION, 'evidenceVersion', { max: 16 }),
    product: assertString(input.product ?? 'Gulo Gulo', 'product', { max: 64 }),
    version: assertString(input.version, 'version', { max: 64 }),
    commitSha: assertString(input.commitSha, 'commitSha', { min: 40, max: 64 }),
    generatedAt: assertDate(input.generatedAt, 'generatedAt'),
    releaseDecision: decision,
    section30,
    section30StatusCounts: countStatuses(section30),
    reviews,
    securityFindings,
    tests,
    artifacts: normalizeArtifacts(input.artifacts),
    residualRisks: Object.freeze((input.residualRisks ?? []).map((value, index) => assertSafeText(value, `residualRisks[${index}]`))),
    nextCandidates: Object.freeze((input.nextCandidates ?? []).map((value, index) => assertSafeText(value, `nextCandidates[${index}]`))),
  };

  if (normalized.product !== 'Gulo Gulo') {
    throw releaseError('product must be Gulo Gulo', 'INVALID_RELEASE_PRODUCT');
  }
  if (!/^[0-9a-f]{40,64}$/i.test(normalized.commitSha)) {
    throw releaseError('commitSha must be a hexadecimal Git object identifier', 'INVALID_RELEASE_COMMIT');
  }
  if (normalized.tests.some((entry) => entry.status === 'failed')) {
    throw releaseError('failed test evidence blocks a release decision', 'FAILED_RELEASE_TEST');
  }
  if (decision === 'approved' && section30.some((entry) => entry.status === 'deferred' || entry.status === 'exception')) {
    throw releaseError('an approved release cannot contain deferred or exception checklist items', 'APPROVAL_CONFLICT');
  }
  return Object.freeze(normalized);
}

function evaluateReleaseEvidence(evidence) {
  const normalized = createReleaseEvidence(evidence);
  const contractOnly = normalized.section30.some((entry) => entry.status !== 'verified');
  const conditionalTests = normalized.tests.some((entry) => entry.status !== 'passed');
  const conditionalReviews = normalized.reviews.some((entry) => entry.status !== 'passed');
  const acceptedFindings = normalized.securityFindings.some((entry) => entry.status === 'accepted');
  const productionReady = normalized.releaseDecision === 'approved'
    && !contractOnly
    && !conditionalTests
    && !conditionalReviews
    && !acceptedFindings;
  return Object.freeze({
    releaseDecision: normalized.releaseDecision,
    productionReady,
    section30Complete: true,
    section30StatusCounts: normalized.section30StatusCounts,
    conditional: contractOnly || conditionalTests || conditionalReviews || acceptedFindings,
    unresolvedCriticalHigh: normalized.securityFindings.filter((entry) =>
      (entry.severity === 'critical' || entry.severity === 'high') && entry.status === 'open'),
  });
}

export {
  EVIDENCE_STATUSES,
  RELEASE_DECISIONS,
  RELEASE_EVIDENCE_VERSION,
  REQUIRED_SECTION30_ITEMS,
  SECTION30_DOMAINS,
  SECURITY_FINDING_STATUSES,
  SECURITY_SEVERITIES,
  REQUIRED_REVIEWS,
  REVIEW_STATUSES,
  TEST_STATUSES,
  createReleaseEvidence,
  evaluateReleaseEvidence,
};
