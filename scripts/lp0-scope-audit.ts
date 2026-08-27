// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createLocalProofScope } from '../src/release/local-proof-scope.ts';

const manifestPath = resolve(process.cwd(), 'release/local-proof-scope.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const scope = createLocalProofScope(manifest);

console.log(JSON.stringify({
  proofType: scope.proofType,
  releaseLabel: scope.releaseLabel,
  networkPolicy: scope.networkPolicy,
  syntheticDataOnly: scope.syntheticDataOnly,
  publicDnsRequired: scope.publicDnsRequired,
  publicAcmeEnabled: scope.publicAcmeEnabled,
  targetPlatforms: scope.targetPlatforms,
  localNames: scope.localNames,
  requiredServices: scope.requiredServices,
  externalPhaseDeferred: scope.externalPhaseDeferred,
  status: scope.status,
}, null, 2));
