#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReleaseEvidence, evaluateReleaseEvidence } from '../src/core/release/release-evidence.ts';

const inputPath = process.argv[2] ?? 'release/v1-release-evidence.template.json';
const evidence = JSON.parse(await readFile(resolve(process.cwd(), inputPath), 'utf8'));
const normalized = createReleaseEvidence(evidence);
const evaluation = evaluateReleaseEvidence(normalized);

process.stdout.write(`${JSON.stringify({
  product: normalized.product,
  version: normalized.version,
  releaseDecision: evaluation.releaseDecision,
  productionReady: evaluation.productionReady,
  section30Complete: evaluation.section30Complete,
  section30StatusCounts: evaluation.section30StatusCounts,
  conditional: evaluation.conditional,
}, null, 2)}\n`);
