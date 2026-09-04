// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_REVIEWS,
  REQUIRED_SECTION30_ITEMS,
  createReleaseEvidence,
  evaluateReleaseEvidence,
} from './release-evidence.ts';

const COMMIT = 'a'.repeat(40);

function section30(statusOverrides = {}) {
  return REQUIRED_SECTION30_ITEMS.map((id) => ({
    id,
    status: statusOverrides[id] ?? 'verified',
    evidence: [`doc/release-readiness.md#${id}`],
    ...(statusOverrides[id] === 'deferred' ? {
      owner: 'Sythos',
      mitigation: 'Keep the deployment in contract-preview until the external rehearsal is recorded.',
      rationale: 'The local checkout cannot operate a live external service.',
      approval: { approvedBy: 'Sythos', approvedAt: '2026-08-23T00:00:00Z' },
    } : {}),
  }));
}

function validEvidence(overrides = {}) {
  return {
    evidenceVersion: '1.0',
    product: 'Gulo Gulo',
    version: '0.1.8',
    commitSha: COMMIT,
    generatedAt: '2026-08-23T00:00:00Z',
    releaseDecision: 'conditional',
    section30: section30({
      'operations.blue-green-rehearsal': 'deferred',
      ...overrides.section30,
    }),
    reviews: REQUIRED_REVIEWS.map((id) => ({
      id,
      status: id === 'blue-green-upgrade' ? 'deferred' : 'passed',
      evidence: [`doc/release-readiness.md#${id}`],
      ...(id === 'blue-green-upgrade' ? {
        owner: 'Sythos',
        mitigation: 'Keep the release conditional until a provider cutover rehearsal is recorded.',
        approval: { approvedBy: 'Sythos', approvedAt: '2026-08-23T00:00:00Z' },
      } : {}),
    })),
    securityFindings: [],
    tests: [{ name: 'M10 contract suite', command: 'npm run test:m10', status: 'passed', evidence: 'src/core/release/release-evidence.test.ts' }],
    artifacts: [{ name: 'operator guide', path: 'doc/release-readiness.md', purpose: 'Release evidence and operator boundary.' }],
    residualRisks: ['Live vendor interoperability and cutover still require an approved deployment environment.'],
    nextCandidates: ['Wire the provider adapters and rehearse a real blue/green cutover.'],
    ...overrides,
  };
}

test('M10 evidence requires every applicable Section 30 item', () => {
  assert.equal(REQUIRED_SECTION30_ITEMS.length, 46);
  assert.throws(
    () => createReleaseEvidence({ ...validEvidence(), section30: section30().slice(1) }),
    (error) => error.code === 'SECTION30_INCOMPLETE',
  );
});

test('M10 evidence requires every hardening review', () => {
  assert.equal(REQUIRED_REVIEWS.length, 10);
  assert.throws(
    () => createReleaseEvidence({ ...validEvidence(), reviews: validEvidence().reviews.slice(1) }),
    (error) => error.code === 'M10_REVIEWS_INCOMPLETE',
  );
});

test('deferred evidence requires an approved owner and mitigation', () => {
  const evidence = createReleaseEvidence(validEvidence());
  const result = evaluateReleaseEvidence(evidence);
  assert.equal(result.section30Complete, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.conditional, true);
  assert.equal(result.section30StatusCounts.deferred, 1);
  assert.throws(
    () => createReleaseEvidence({
      ...validEvidence(),
      section30: section30({ 'operations.blue-green-rehearsal': 'deferred' }).map((entry) =>
        entry.id === 'operations.blue-green-rehearsal' ? { ...entry, approval: undefined } : entry),
    }),
    (error) => error.code === 'INVALID_RELEASE_SHAPE',
  );
});

test('critical and high findings cannot remain open', () => {
  assert.throws(
    () => createReleaseEvidence({
      ...validEvidence(),
      securityFindings: [{ id: 'SEC-001', title: 'Open high finding', severity: 'high', status: 'open' }],
    }),
    (error) => error.code === 'UNRESOLVED_SECURITY_FINDING',
  );

  const accepted = createReleaseEvidence({
    ...validEvidence(),
    securityFindings: [{
      id: 'SEC-002',
      title: 'Accepted medium residual',
      severity: 'medium',
      status: 'accepted',
      owner: 'Sythos',
      mitigation: 'Keep the external adapter disabled until its review is complete.',
      approval: { approvedBy: 'Sythos', approvedAt: '2026-08-23T00:00:00Z' },
    }],
  });
  assert.equal(evaluateReleaseEvidence(accepted).productionReady, false);
});

test('release evidence rejects secrets and local paths', () => {
  assert.throws(
    () => createReleaseEvidence({ ...validEvidence(), residualRisks: ['token=secret-value'] }),
    (error) => error.code === 'UNSAFE_RELEASE_EVIDENCE',
  );
  assert.throws(
    () => createReleaseEvidence({
      ...validEvidence(),
      artifacts: [{ name: 'unsafe', path: 'C:\\Users\\Sythos\\Desktop\\evidence.json', purpose: 'not portable' }],
    }),
    (error) => error.code === 'UNSAFE_RELEASE_EVIDENCE',
  );
});
