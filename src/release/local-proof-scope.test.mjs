// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_PROOF_RELEASE_LABEL,
  LOCAL_PROOF_REQUIRED_SERVICES,
  createLocalProofScope,
} from './local-proof-scope.mjs';

const VALID_SCOPE = {
  spdxLicenseIdentifier: 'MIT',
  spdxFileCopyrightText: '2026 Sythos (https://www.sythos.net)',
  author: 'Sythos (https://www.sythos.net)',
  schemaVersion: 1,
  proofType: 'local',
  releaseLabel: LOCAL_PROOF_RELEASE_LABEL,
  networkPolicy: 'offline_runtime',
  syntheticDataOnly: true,
  publicDnsRequired: false,
  publicAcmeEnabled: false,
  targetPlatforms: ['linux/amd64', 'linux/arm64'],
  localNames: ['gulogulo.test', 'webmail.localhost', 'calendar.localhost', 'contacts.localhost'],
  requiredServices: [...LOCAL_PROOF_REQUIRED_SERVICES],
  externalPhaseDeferred: true,
  status: 'frozen',
};

test('LP0 accepts the frozen, offline, synthetic local scope', () => {
  const scope = createLocalProofScope(VALID_SCOPE);

  assert.equal(scope.releaseLabel, LOCAL_PROOF_RELEASE_LABEL);
  assert.equal(scope.networkPolicy, 'offline_runtime');
  assert.equal(scope.syntheticDataOnly, true);
  assert.deepEqual(scope.targetPlatforms, ['linux/amd64', 'linux/arm64']);
  assert(Object.isFrozen(scope));
  assert(Object.isFrozen(scope.requiredServices));
});

test('LP0 rejects public-network and public-ACME claims', () => {
  assert.throws(
    () => createLocalProofScope({ ...VALID_SCOPE, publicDnsRequired: true }),
    (error) => error.code === 'LP0_EXTERNAL_BOUNDARY_INVALID',
  );
  assert.throws(
    () => createLocalProofScope({ ...VALID_SCOPE, publicAcmeEnabled: true }),
    (error) => error.code === 'LP0_EXTERNAL_BOUNDARY_INVALID',
  );
});

test('LP0 rejects non-reserved names and incomplete service inventories', () => {
  assert.throws(
    () => createLocalProofScope({ ...VALID_SCOPE, localNames: ['mail.example.com'] }),
    (error) => error.code === 'LP0_LOCAL_NAME_INVALID',
  );
  assert.throws(
    () => createLocalProofScope({ ...VALID_SCOPE, requiredServices: VALID_SCOPE.requiredServices.slice(1) }),
    (error) => error.code === 'LP0_SERVICES_INVALID',
  );
});

test('LP0 rejects absolute paths and unsafe release labels', () => {
  assert.throws(
    () => createLocalProofScope({ ...VALID_SCOPE, releaseLabel: 'v0.1.0-local-proof.1/secret' }),
    (error) => error.code === 'LP0_RELEASE_LABEL_INVALID',
  );
  assert.throws(
    () => createLocalProofScope({ ...VALID_SCOPE, author: 'C:\\Users\\Sythos' }),
    (error) => error.code === 'LP0_METADATA_INVALID',
  );
});
