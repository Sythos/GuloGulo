#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { auditSource } from './lp9-source-audit.ts';

type JsonObject = Record<string, unknown>;
type ReleaseAuditSummary = {
  readonly milestone: 'LP9';
  readonly status: string;
  readonly source: Awaited<ReturnType<typeof auditSource>>;
  readonly ciRuns: readonly string[];
  readonly deferredEvidence: number;
};

const MANIFEST_PATH = 'release/lp9-local-proof.json';
const AUTHOR = 'Sythos (https://www.sythos.net)';
const RUN_URL = /^https:\/\/github\.com\/Sythos\/GuloGulo\/actions\/runs\/[0-9]+$/u;
const SECRET = /(?:-----BEGIN [^-]+ PRIVATE KEY-----|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}\b|\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*[^\s,}]+)/iu;

function failure(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('LP9_RELEASE_INVALID_SHAPE', `${label} must be an object.`);
  return value as JsonObject;
}

function nonEmptyString(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) throw failure('LP9_RELEASE_INVALID_FIELD', `${label} must be a trimmed string.`);
  if (SECRET.test(value)) throw failure('LP9_RELEASE_UNSAFE_CONTENT', `${label} contains a secret-like value.`);
  return value;
}

function exactPlatforms(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 2 || value[0] !== 'linux/amd64' || value[1] !== 'linux/arm64') {
    throw failure('LP9_RELEASE_ARCHITECTURE_INVALID', 'finalModePlatforms must be linux/amd64 and linux/arm64 in that order.');
  }
}

export function validateReleaseManifest(manifest: unknown): { ciRuns: string[]; deferredEvidence: number; status: string } {
  const input = object(manifest, 'LP9 release manifest');
  if (input.spdxLicenseIdentifier !== 'MIT' || input.spdxFileCopyrightText !== `2026 ${AUTHOR}` || input.author !== AUTHOR) throw failure('LP9_RELEASE_METADATA_INVALID', 'MIT/SPDX/author metadata is not canonical.');
  if (input.schemaVersion !== 1 || input.product !== 'Gulo Gulo' || input.milestone !== 'LP9' || input.proofType !== 'local_synthetic_release') throw failure('LP9_RELEASE_IDENTITY_INVALID', 'The release manifest identity is invalid.');
  const status = nonEmptyString(input.status, 'status', 64);
  if (!['ready_for_owner_review', 'complete'].includes(status)) throw failure('LP9_RELEASE_STATUS_INVALID', `Unsupported release status: ${status}.`);
  nonEmptyString(input.generatedAt, 'generatedAt');
  if (input.safeToShare !== true || input.syntheticDataOnly !== true || input.externalPhaseDeferred !== true) throw failure('LP9_RELEASE_BOUNDARY_INVALID', 'The local proof must be synthetic, safe to share, and externally deferred.');

  const sourceLanguage = object(input.sourceLanguage, 'sourceLanguage');
  if (sourceLanguage.canonical !== 'TypeScript' || sourceLanguage.browserRuntime !== 'compiled JavaScript generated from TypeScript' || sourceLanguage.applicationBackendAndNodeTests !== 'TypeScript' || sourceLanguage.behaviorFreeMjsBridges !== true || sourceLanguage.generatedBrowserJavaScriptAllowed !== true || sourceLanguage.removalOwner !== 'Sythos') throw failure('LP9_RELEASE_SOURCE_POLICY_INVALID', 'The source-language policy is not the accepted TypeScript policy.');
  nonEmptyString(sourceLanguage.bridgeInventory, 'sourceLanguage.bridgeInventory');
  nonEmptyString(sourceLanguage.existingTypeScriptWaivers, 'sourceLanguage.existingTypeScriptWaivers');

  const architecture = object(input.architecture, 'architecture');
  if (architecture.baseImage !== 'ubuntu:26.04' || architecture.defaultWorkflowMode !== 'amd64' || architecture.functionalProofPlatform !== 'linux/amd64' || architecture.finalWorkflowMode !== 'multiarch' || architecture.artifactProvenanceOnly !== true) throw failure('LP9_RELEASE_ARCHITECTURE_INVALID', 'The AMD64-first and multiarch artifact policy is invalid.');
  exactPlatforms(architecture.finalModePlatforms);

  if (!Array.isArray(input.localChecks) || input.localChecks.length < 5) throw failure('LP9_RELEASE_CHECKS_EMPTY', 'localChecks must contain the reproducible local release gates.');
  input.localChecks.forEach((entry, index) => nonEmptyString(entry, `localChecks[${index}]`, 1024));

  if (!Array.isArray(input.ciRuns) || input.ciRuns.length === 0) throw failure('LP9_RELEASE_CI_EMPTY', 'ciRuns must contain passed GitHub Actions evidence.');
  const ciRuns: string[] = [];
  input.ciRuns.forEach((entry, index) => {
    const run = object(entry, `ciRuns[${index}]`);
    const id = nonEmptyString(run.id, `ciRuns[${index}].id`, 32);
    if (!/^\d+$/u.test(id) || typeof run.url !== 'string' || !RUN_URL.test(run.url) || run.result !== 'passed') throw failure('LP9_RELEASE_CI_INVALID', `ciRuns[${index}] must be a passed Sythos/GuloGulo Actions run.`);
    nonEmptyString(run.mode, `ciRuns[${index}].mode`, 64);
    nonEmptyString(run.scope, `ciRuns[${index}].scope`, 1024);
    ciRuns.push(id);
  });

  if (!Array.isArray(input.deferredEvidence) || input.deferredEvidence.length === 0) throw failure('LP9_RELEASE_DEFERRED_EMPTY', 'deferredEvidence must keep external work visible.');
  input.deferredEvidence.forEach((entry, index) => nonEmptyString(entry, `deferredEvidence[${index}]`, 1024));
  return { ciRuns, deferredEvidence: input.deferredEvidence.length, status };
}

export async function auditReleaseManifest(root = process.cwd(), manifestPath = MANIFEST_PATH): Promise<ReleaseAuditSummary> {
  const safePath = manifestPath.replaceAll('\\', '/');
  if (safePath.startsWith('/') || safePath.includes('..') || !safePath.endsWith('.json')) throw failure('LP9_RELEASE_PATH_INVALID', 'manifestPath must be a repository-relative JSON path.');
  const manifest = JSON.parse(await readFile(resolve(root, safePath), 'utf8')) as unknown;
  const result = validateReleaseManifest(manifest);
  const source = await auditSource(root);
  return { milestone: 'LP9', status: result.status, source, ciRuns: result.ciRuns, deferredEvidence: result.deferredEvidence };
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await auditReleaseManifest(), null, 2)}\n`);
}

if ((process.argv[1] ?? '').replaceAll('\\', '/').endsWith('/lp9-release-audit.ts')) await main();
