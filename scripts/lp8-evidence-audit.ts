#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

type JsonObject = Record<string, unknown>;
type Reference = { path: string; purpose?: string };
type AuditSummary = {
  milestone: 'LP8';
  status: string;
  filesChecked: number;
  bridgesChecked: number;
  ciRuns: string[];
  exactDigests: number;
  deferredDigestEntries: number;
};

const BUNDLE_PATH = 'release/lp8-local-proof-bundle.json';
const AUTHOR = 'Sythos (https://www.sythos.net)';
const BASE_DIGEST = 'sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b';
const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
const RUN_URL = /^https:\/\/github\.com\/Sythos\/GuloGulo\/actions\/runs\/[0-9]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9 .:_+@-]{0,127}$/;
const SECRET_VALUE = /(?:-----BEGIN [^-]+ PRIVATE KEY-----|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}\b|\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,}]+)/i;
const ABSOLUTE_PATH = /(?:^[A-Za-z]:[\\/]|^\\\\|^\/|\b(?:C|D|E|F):\\Users\\|F:\\Dev\\GuloGulo|C:\\Users\\)/i;

function auditError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw auditError('LP8_INVALID_SHAPE', `${label} must be an object.`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
    throw auditError('LP8_INVALID_FIELD', `${label} must be a trimmed string.`);
  }
  return value;
}

function safeText(value: unknown, label: string): string {
  const text = string(value, label);
  if (SECRET_VALUE.test(text) || ABSOLUTE_PATH.test(text)) {
    throw auditError('LP8_UNSAFE_CONTENT', `${label} contains a secret-like value or host path.`);
  }
  return text;
}

export function safeRepositoryPath(value: unknown, label: string): string {
  const path = string(value, label, 512);
  if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..') || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith('//')) {
    throw auditError('LP8_UNSAFE_PATH', `${label} must be a repository-relative POSIX path.`);
  }
  if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.startsWith('/') || path.endsWith('/')) {
    throw auditError('LP8_UNSAFE_PATH', `${label} contains an invalid repository path.`);
  }
  return path;
}

function exactList(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    throw auditError('LP8_ARCHITECTURE_INVALID', `${label} must be ${expected.join(', ')} in that order.`);
  }
}

function references(value: unknown, label: string): Reference[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw auditError('LP8_REFERENCES_EMPTY', `${label} must contain at least one reference.`);
  }
  return value.map((entry, index) => {
    const item = object(entry, `${label}[${index}]`);
    const path = safeRepositoryPath(item.path, `${label}[${index}].path`);
    if (item.purpose !== undefined) safeText(item.purpose, `${label}[${index}].purpose`);
    return { path, purpose: item.purpose as string | undefined };
  });
}

function assertBridgeContent(source: string, bridge: string): void {
  const withoutComments = source
    .replace(/^\s*#!.*$/gm, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim();
  if (!withoutComments || /\b(?:function|class|const|let|var|require|process|JSON|fetch|fs\.)\b/.test(withoutComments)) {
    throw auditError('LP8_BRIDGE_NOT_THIN', `${bridge} contains executable compatibility logic.`);
  }
  const statements = withoutComments.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const statement of statements) {
    if (!/^(?:import\s+['"][^'"]+\.ts['"];?|export\s+\*\s+from\s+['"][^'"]+\.ts['"];?)$/.test(statement)) {
      throw auditError('LP8_BRIDGE_NOT_THIN', `${bridge} contains a non-TypeScript bridge statement.`);
    }
  }
}

function checkArchitecture(bundle: JsonObject): void {
  const architecture = object(bundle.architecture, 'architecture');
  if (architecture.defaultWorkflowMode !== 'amd64' || architecture.functionalProofPlatform !== 'linux/amd64' || architecture.finalWorkflowMode !== 'multiarch' || architecture.multiarchFunctionalProof !== false || architecture.artifactProvenanceOnly !== true) {
    throw auditError('LP8_ARCHITECTURE_INVALID', 'LP8 must use AMD64 functional proof and multiarch artifact-only final proof.');
  }
  exactList(architecture.finalModePlatforms, PLATFORMS, 'architecture.finalModePlatforms');
  const baseImage = object(architecture.baseImage, 'architecture.baseImage');
  if (baseImage.name !== 'ubuntu:26.04' || baseImage.digest !== BASE_DIGEST || !RUN_URL.test(string(baseImage.evidenceRun, 'architecture.baseImage.evidenceRun'))) {
    throw auditError('LP8_BASE_DIGEST_INVALID', 'The verified Ubuntu 26.04 base digest or its evidence run is invalid.');
  }
}

function checkImageDigests(value: unknown): { exact: number; deferred: number } {
  if (!Array.isArray(value) || value.length === 0) throw auditError('LP8_DIGESTS_EMPTY', 'imageDigests must contain an honest digest inventory.');
  let exact = 0;
  let deferred = 0;
  for (const [index, entry] of value.entries()) {
    const item = object(entry, `imageDigests[${index}]`);
    const name = string(item.name, `imageDigests[${index}].name`, 128);
    if (!SAFE_NAME.test(name)) throw auditError('LP8_INVALID_FIELD', `imageDigests[${index}].name contains unsafe characters.`);
    exactList(item.platforms, PLATFORMS, `imageDigests[${index}].platforms`);
    const status = string(item.digestStatus, `imageDigests[${index}].digestStatus`, 64);
    if (status === 'exact') {
      if (!DIGEST.test(string(item.digest, `imageDigests[${index}].digest`, 80))) throw auditError('LP8_BASE_DIGEST_INVALID', `${name} has an invalid exact digest.`);
      if (!RUN_URL.test(string(item.evidence, `imageDigests[${index}].evidence`))) throw auditError('LP8_CI_REFERENCE_INVALID', `${name} has an invalid evidence URL.`);
      exact += 1;
    } else if (status === 'not_published_local_proof') {
      if (item.digest !== undefined && item.digest !== null) throw auditError('LP8_DIGEST_CLAIM_INVALID', `${name} must not claim a registry digest before publication.`);
      if (!RUN_URL.test(string(item.evidence, `imageDigests[${index}].evidence`))) throw auditError('LP8_CI_REFERENCE_INVALID', `${name} has an invalid evidence URL.`);
      safeText(item.note, `imageDigests[${index}].note`);
      deferred += 1;
    } else {
      throw auditError('LP8_DIGEST_CLAIM_INVALID', `${name} uses an unsupported digest status.`);
    }
  }
  if (exact === 0) throw auditError('LP8_BASE_DIGEST_INVALID', 'At least one exact immutable digest is required.');
  return { exact, deferred };
}

export function validateBundle(bundle: unknown, repoRoot: string): AuditSummary {
  const input = object(bundle, 'LP8 bundle');
  if (input.spdxLicenseIdentifier !== 'MIT' || input.spdxFileCopyrightText !== `2026 ${AUTHOR}` || input.author !== AUTHOR) {
    throw auditError('LP8_METADATA_INVALID', 'MIT/SPDX/author metadata is not canonical.');
  }
  if (input.schemaVersion !== 1 || input.milestone !== 'LP8' || input.product !== 'Gulo Gulo' || input.proofType !== 'local_synthetic_evidence_bundle' || input.status !== 'ready_for_lp9') {
    throw auditError('LP8_IDENTITY_INVALID', 'The bundle identity or status is invalid.');
  }
  if (input.syntheticDataOnly !== true || input.publicDnsRequired !== false || input.publicAcmeEnabled !== false || input.externalPhaseDeferred !== true || input.safeToShare !== true) {
    throw auditError('LP8_EXTERNAL_BOUNDARY_INVALID', 'LP8 must remain synthetic, offline, and safe to share.');
  }
  safeText(input.generatedAt, 'generatedAt');
  checkArchitecture(input);
  const digestCounts = checkImageDigests(input.imageDigests);
  const allReferences: string[] = [];
  for (const field of ['manifests', 'fixtures', 'protocolEvidence', 'operationsEvidence', 'apiMcpExamples', 'backupRestore', 'migration'] as const) {
    allReferences.push(...references(input[field], field).map((entry) => entry.path));
  }
  const unique = new Set(allReferences);
  if (unique.size !== allReferences.length) throw auditError('LP8_DUPLICATE_REFERENCE', 'The bundle contains duplicate file references.');
  for (const path of unique) {
    if (!resolve(repoRoot, path).startsWith(resolve(repoRoot))) throw auditError('LP8_UNSAFE_PATH', `${path} escapes the repository.`);
  }
  const commands = input.commands;
  if (!Array.isArray(commands) || commands.length < 3) throw auditError('LP8_COMMANDS_EMPTY', 'commands must describe reproducible local checks.');
  commands.forEach((command, index) => safeText(command, `commands[${index}]`));

  const runs = input.ciRuns;
  if (!Array.isArray(runs) || runs.length === 0) throw auditError('LP8_CI_EMPTY', 'ciRuns must contain recorded GitHub Actions evidence.');
  const ciIds: string[] = [];
  for (const [index, entry] of runs.entries()) {
    const item = object(entry, `ciRuns[${index}]`);
    const id = string(item.id, `ciRuns[${index}].id`, 32);
    if (!/^[0-9]+$/.test(id) || !RUN_URL.test(string(item.url, `ciRuns[${index}].url`)) || item.result !== 'passed') throw auditError('LP8_CI_REFERENCE_INVALID', `ciRuns[${index}] must be a passed Sythos/GuloGulo Actions run.`);
    safeText(item.mode, `ciRuns[${index}].mode`);
    safeText(item.scope, `ciRuns[${index}].scope`);
    ciIds.push(id);
  }

  const shims = input.temporaryShims;
  if (!Array.isArray(shims) || shims.length === 0) throw auditError('LP8_SHIMS_EMPTY', 'temporaryShims must make the LP9 debt explicit.');
  const bridges: string[] = [];
  for (const [index, entry] of shims.entries()) {
    const item = object(entry, `temporaryShims[${index}]`);
    const bridge = safeRepositoryPath(item.bridge, `temporaryShims[${index}].bridge`);
    const canonical = safeRepositoryPath(item.canonical, `temporaryShims[${index}].canonical`);
    if (!bridge.endsWith('.mjs') || !canonical.endsWith('.ts') || item.owner !== 'LP9') throw auditError('LP8_SHIM_OWNER_INVALID', `${bridge} must point to a TypeScript canonical owned by LP9.`);
    safeText(item.reason, `temporaryShims[${index}].reason`);
    bridges.push(bridge);
  }
  const risks = input.residualRisks;
  if (!Array.isArray(risks) || risks.length === 0) throw auditError('LP8_RISKS_EMPTY', 'residualRisks must remain explicit.');
  risks.forEach((risk, index) => safeText(risk, `residualRisks[${index}]`));
  if (JSON.stringify(input).match(/\b(?:productionSecret|realUserData|privateKey)\b/i)) throw auditError('LP8_UNSAFE_CONTENT', 'The bundle contains an unsafe content marker.');
  return { milestone: 'LP8', status: String(input.status), filesChecked: unique.size, bridgesChecked: bridges.length, ciRuns: ciIds, exactDigests: digestCounts.exact, deferredDigestEntries: digestCounts.deferred };
}

export async function auditBundle(repoRoot = process.cwd(), bundlePath = BUNDLE_PATH): Promise<AuditSummary> {
  const absoluteBundle = resolve(repoRoot, safeRepositoryPath(bundlePath, 'bundlePath'));
  const raw = await readFile(absoluteBundle, 'utf8');
  if (SECRET_VALUE.test(raw) || ABSOLUTE_PATH.test(raw)) throw auditError('LP8_UNSAFE_CONTENT', 'The bundle file contains a secret-like value or host path.');
  const bundle = JSON.parse(raw) as unknown;
  const summary = validateBundle(bundle, repoRoot);
  const input = object(bundle, 'LP8 bundle');
  for (const entry of input.temporaryShims as unknown[]) {
    const item = object(entry, 'temporaryShim');
    const bridge = safeRepositoryPath(item.bridge, 'temporaryShim.bridge');
    const canonical = safeRepositoryPath(item.canonical, 'temporaryShim.canonical');
    await access(resolve(repoRoot, bridge));
    await access(resolve(repoRoot, canonical));
    assertBridgeContent(await readFile(resolve(repoRoot, bridge), 'utf8'), bridge);
  }
  for (const path of new Set(summary.ciRuns)) {
    if (!/^\d+$/.test(path)) throw auditError('LP8_CI_REFERENCE_INVALID', 'CI run identifiers must be numeric.');
  }
  return summary;
}

async function main(): Promise<void> {
  const summary = await auditBundle(process.cwd(), process.argv[2] ?? BUNDLE_PATH);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/lp8-evidence-audit.ts')) {
  await main();
}

export { BASE_DIGEST, PLATFORMS };
