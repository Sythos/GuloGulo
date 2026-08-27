// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

/**
 * LP0 local-proof scope contract.
 *
 * LP0 freezes the boundary for the local deployment rehearsal. It does not
 * start services or claim that a local fixture is a production provider.
 */

const LOCAL_PROOF_RELEASE_PATTERN = /^v\d+\.\d+\.\d+-local-proof\.\d+$/;
const LOCAL_NAME_PATTERN = /^(?:[a-z0-9-]+\.localhost|[a-z0-9-]+\.test)$/;
const PLATFORM_SET = Object.freeze(['linux/amd64', 'linux/arm64']);

const LOCAL_PROOF_REQUIRED_SERVICES = Object.freeze([
  'gulogulo',
  'ldap',
  'postgresql',
  'postfix',
  'dovecot',
  'rspamd',
  'clamav',
  'caldav',
  'carddav',
  'local-dns',
  'local-ca',
]);

const LOCAL_PROOF_RELEASE_LABEL = 'v0.1.0-local-proof.1';

function scopeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw scopeError(code, `${label} must be a plain object.`);
  }
}

function assertExactString(value, expected, code, label) {
  if (value !== expected) {
    throw scopeError(code, `${label} must be ${expected}.`);
  }
}

function assertSafeString(value, code, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\\/\0]|\.\.|https?:\/\//i.test(value)) {
    throw scopeError(code, `${label} contains an unsafe value.`);
  }
}

function assertPlatformList(platforms) {
  if (!Array.isArray(platforms) || platforms.length !== PLATFORM_SET.length ||
      platforms.some((platform, index) => platform !== PLATFORM_SET[index])) {
    throw scopeError('LP0_PLATFORMS_INVALID', 'LP0 must declare linux/amd64 and linux/arm64 in order.');
  }
}

function assertLocalNames(localNames) {
  if (!Array.isArray(localNames) || localNames.length === 0) {
    throw scopeError('LP0_LOCAL_NAMES_EMPTY', 'LP0 must declare at least one local-only name.');
  }
  for (const name of localNames) {
    if (typeof name !== 'string' || !LOCAL_NAME_PATTERN.test(name)) {
      throw scopeError('LP0_LOCAL_NAME_INVALID', `The local name ${String(name)} is not a reserved test name.`);
    }
  }
}

function assertRequiredServices(requiredServices) {
  if (!Array.isArray(requiredServices) || requiredServices.length !== LOCAL_PROOF_REQUIRED_SERVICES.length ||
      requiredServices.some((service, index) => service !== LOCAL_PROOF_REQUIRED_SERVICES[index])) {
    throw scopeError('LP0_SERVICES_INVALID', 'LP0 required services must match the frozen local service inventory.');
  }
}

/**
 * Validate and freeze the local-proof manifest.
 *
 * The validator deliberately rejects public DNS, public ACME, real secrets,
 * and absolute paths so the local proof cannot quietly become a deployment.
 */
export function createLocalProofScope(input) {
  assertPlainObject(input, 'LP0_SCOPE_INVALID', 'LP0 scope');
  assertExactString(input.proofType, 'local', 'LP0_PROOF_TYPE_INVALID', 'proofType');
  if (input.schemaVersion !== 1) {
    throw scopeError('LP0_SCHEMA_INVALID', 'LP0 scope schemaVersion must be 1.');
  }
  if (typeof input.releaseLabel !== 'string' || !LOCAL_PROOF_RELEASE_PATTERN.test(input.releaseLabel)) {
    throw scopeError('LP0_RELEASE_LABEL_INVALID', 'LP0 releaseLabel must use the local-proof version pattern.');
  }
  assertExactString(input.networkPolicy, 'offline_runtime', 'LP0_NETWORK_POLICY_INVALID', 'networkPolicy');
  if (input.syntheticDataOnly !== true || input.publicDnsRequired !== false || input.publicAcmeEnabled !== false) {
    throw scopeError('LP0_EXTERNAL_BOUNDARY_INVALID', 'LP0 requires synthetic data, no public DNS, and no public ACME.');
  }
  if (input.externalPhaseDeferred !== true || input.status !== 'frozen') {
    throw scopeError('LP0_STATUS_INVALID', 'LP0 must remain frozen while the external phase is deferred.');
  }
  assertPlatformList(input.targetPlatforms);
  assertLocalNames(input.localNames);
  assertRequiredServices(input.requiredServices);
  assertSafeString(input.spdxLicenseIdentifier, 'LP0_METADATA_INVALID', 'spdxLicenseIdentifier');
  assertExactString(input.spdxLicenseIdentifier, 'MIT', 'LP0_LICENSE_INVALID', 'spdxLicenseIdentifier');
  assertExactString(input.spdxFileCopyrightText, '2026 Sythos (https://www.sythos.net)', 'LP0_METADATA_INVALID', 'spdxFileCopyrightText');
  assertExactString(input.author, 'Sythos (https://www.sythos.net)', 'LP0_METADATA_INVALID', 'author');

  return Object.freeze({
    ...input,
    targetPlatforms: Object.freeze([...input.targetPlatforms]),
    localNames: Object.freeze([...input.localNames]),
    requiredServices: Object.freeze([...input.requiredServices]),
  });
}

export { LOCAL_PROOF_RELEASE_LABEL, LOCAL_PROOF_REQUIRED_SERVICES, PLATFORM_SET };
