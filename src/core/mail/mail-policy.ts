// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// Transitional typing waiver: the LP2-LP9 recovery plan closes this debt at
// the final server-language audit after each protocol slice is operational.
// @ts-nocheck

import { assertTenantContext } from '../../integrations/tenant-context.ts';

const LOCAL_PART_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const SIEVE_MAX_BYTES = 64 * 1024;
const FORWARDING_PATTERN = /(?:^|\s|:)redirect(?:\s|;|$)|(?:^|\s)forward(?:ing)?(?:\s|:|$)/i;

function policyError(message, code = 'MAIL_POLICY_ERROR') {
  const error = new Error(`Mail policy error: ${message}`);
  error.code = code;
  return error;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw policyError(`${name} is required`, 'INVALID_INPUT');
  }
  return value;
}

function normalizeAddress(address, name = 'address') {
  const value = requiredString(address, name).trim();
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    throw policyError(`${name} is not a valid mailbox address`, 'INVALID_ADDRESS');
  }

  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1).toLowerCase();
  if (!LOCAL_PART_PATTERN.test(localPart) || !DOMAIN_PATTERN.test(domain)) {
    throw policyError(`${name} is not a valid mailbox address`, 'INVALID_ADDRESS');
  }

  return `${localPart.toLowerCase()}@${domain}`;
}

function normalizeAddressForTenant(address, domain, name) {
  const normalized = normalizeAddress(address, name);
  if (normalized.slice(normalized.lastIndexOf('@') + 1) !== domain) {
    throw policyError(`${name} is outside the tenant domain`, 'CROSS_TENANT_ADDRESS');
  }
  return normalized;
}

function normalizeUserDirectory(users, domain) {
  const byAddress = new Map();
  const byId = new Map();
  for (const user of users ?? []) {
    if (user === null || typeof user !== 'object' || Array.isArray(user)) {
      throw policyError('user directory entries must be objects', 'INVALID_INPUT');
    }
    const userId = requiredString(user.userId, 'user.userId');
    const address = normalizeAddressForTenant(user.address ?? user.mailAddress, domain, 'user.address');
    if (user.status !== undefined && user.status !== 'active') {
      continue;
    }
    if (byAddress.has(address) || byId.has(userId)) {
      throw policyError('user directory contains a duplicate identity', 'CONFLICT');
    }
    const entry = Object.freeze({ userId, address });
    byAddress.set(address, entry);
    byId.set(userId, entry);
  }
  return { byAddress, byId };
}

function normalizeAliasDestinations(alias, directory, domain) {
  const destinations = alias.destinations ?? (alias.targetUserId === undefined ? [] : [alias.targetUserId]);
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw policyError('aliases require at least one explicit destination', 'INVALID_ALIAS');
  }

  const addresses = destinations.map((destination) => {
    if (typeof destination !== 'string') {
      throw policyError('alias destinations must be strings', 'INVALID_ALIAS');
    }
    const user = directory.byId.get(destination);
    if (user !== undefined) {
      return user.address;
    }
    return normalizeAddressForTenant(destination, domain, 'alias.destination');
  });

  const unique = [...new Set(addresses)];
  if (unique.some((address) => !directory.byAddress.has(address))) {
    throw policyError('aliases may target active users only', 'INVALID_ALIAS');
  }
  return unique;
}

function normalizeAliases(aliases, directory, domain) {
  const byAddress = new Map();
  const entries = aliases instanceof Map
    ? [...aliases.entries()].map(([address, destinations]) => ({ address, destinations }))
    : aliases ?? [];

  if (!Array.isArray(entries)) {
    throw policyError('aliases must be an array or map', 'INVALID_INPUT');
  }

  for (const alias of entries) {
    const value = alias === null || typeof alias !== 'object' || Array.isArray(alias)
      ? { address: alias[0], destinations: alias[1] }
      : alias;
    const address = normalizeAddressForTenant(value.address ?? value.aliasAddress, domain, 'alias.address');
    if (directory.byAddress.has(address) || byAddress.has(address)) {
      throw policyError('an alias cannot replace a mailbox or another alias', 'CONFLICT');
    }
    byAddress.set(address, Object.freeze(normalizeAliasDestinations(value, directory, domain)));
  }
  return byAddress;
}

function normalizeRecipients(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw policyError('at least one recipient is required', 'NO_RECIPIENTS');
  }
  return [...new Set(recipients.map((address, index) => normalizeAddress(address, `recipients[${index}]`)))];
}

function authorizeActor(context, userId) {
  const canonical = assertTenantContext(context);
  if (canonical.role === 'user' && canonical.actorId !== userId) {
    throw policyError('the user actor cannot submit as another user', 'SENDER_FORBIDDEN');
  }
  return canonical;
}

/**
 * Build the mail policy used by protocol adapters. It owns the negative
 * decisions (open relay, catch-all, forwarding, cross-tenant addresses) so
 * Postfix, Dovecot, Sieve, and future HTTP handlers cannot diverge.
 */
export function createMailPolicy({
  tenantId,
  domain,
  maxMessageBytes = 52_428_800,
  maxRecipients = 100,
  maxMessagesPerUserPerMinute = 60,
  clock = () => new Date(),
} = {}) {
  const canonicalDomain = requiredString(domain, 'domain').toLowerCase();
  if (!DOMAIN_PATTERN.test(canonicalDomain)) {
    throw policyError('domain is invalid', 'INVALID_DOMAIN');
  }
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    throw policyError('maxMessageBytes must be a positive safe integer', 'INVALID_INPUT');
  }
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 1000) {
    throw policyError('maxRecipients must be between 1 and 1000', 'INVALID_INPUT');
  }
  if (!Number.isSafeInteger(maxMessagesPerUserPerMinute) || maxMessagesPerUserPerMinute < 1) {
    throw policyError('maxMessagesPerUserPerMinute must be positive', 'INVALID_INPUT');
  }

  const tenant = requiredString(tenantId, 'tenantId');
  const submissionWindows = new Map();

  function consumeSubmissionRate(userId) {
    const key = requiredString(userId, 'userId');
    const now = clock().getTime();
    const current = submissionWindows.get(key);
    if (current === undefined || now - current.startedAt >= 60_000) {
      submissionWindows.set(key, { startedAt: now, count: 1 });
      return Object.freeze({ allowed: true, remaining: maxMessagesPerUserPerMinute - 1, retryAfterMs: 0 });
    }
    if (current.count >= maxMessagesPerUserPerMinute) {
      return Object.freeze({ allowed: false, remaining: 0, retryAfterMs: Math.max(1, 60_000 - (now - current.startedAt)) });
    }
    current.count += 1;
    return Object.freeze({ allowed: true, remaining: maxMessagesPerUserPerMinute - current.count, retryAfterMs: 0 });
  }

  function directory(options = {}) {
    const users = normalizeUserDirectory(options.users, canonicalDomain);
    const aliases = normalizeAliases(options.aliases, users, canonicalDomain);
    return { users, aliases };
  }

  function resolveRecipients({ recipients, users = [], aliases = [] } = {}) {
    const resolvedDirectory = directory({ users, aliases });
    const requested = normalizeRecipients(recipients);
    if (requested.length > maxRecipients) {
      throw policyError('recipient limit exceeded', 'RECIPIENT_LIMIT');
    }

    const resolved = [];
    const rejected = [];
    for (const address of requested) {
      if (address.slice(address.lastIndexOf('@') + 1) !== canonicalDomain) {
        rejected.push({ address, reason: 'external_recipient' });
        continue;
      }

      const user = resolvedDirectory.users.byAddress.get(address);
      if (user !== undefined) {
        resolved.push({ address, userId: user.userId, via: 'mailbox' });
        continue;
      }

      const destinations = resolvedDirectory.aliases.get(address);
      if (destinations === undefined) {
        rejected.push({ address, reason: 'unknown_recipient' });
        continue;
      }
      for (const destination of destinations) {
        const destinationUser = resolvedDirectory.users.byAddress.get(destination);
        resolved.push({ address: destination, userId: destinationUser.userId, via: 'alias', alias: address });
      }
    }

    return Object.freeze({
      requested,
      resolved: Object.freeze(resolved),
      rejected: Object.freeze(rejected),
      accepted: rejected.length === 0 && resolved.length > 0,
    });
  }

  function assertMessageSize(sizeBytes) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw policyError('sizeBytes must be a non-negative safe integer', 'INVALID_SIZE');
    }
    if (sizeBytes > maxMessageBytes) {
      throw policyError('message size limit exceeded', 'MESSAGE_TOO_LARGE');
    }
    return sizeBytes;
  }

  function authorizeInbound(context, options = {}) {
    const canonical = assertTenantContext(context);
    if (canonical.tenantId !== tenant) {
      throw policyError('mail policy tenant mismatch', 'CROSS_TENANT_ACCESS');
    }
    const sender = normalizeAddress(options.sender, 'sender');
    const recipients = resolveRecipients(options);
    assertMessageSize(options.sizeBytes ?? 0);
    if (!recipients.accepted) {
      throw policyError('one or more recipients are not explicit tenant mailboxes or aliases', 'RECIPIENT_REJECTED');
    }
    return Object.freeze({ sender, ...recipients, authenticated: false, path: 'inbound' });
  }

  function authorizeSubmission(context, options = {}) {
    const userId = requiredString(options.authenticatedUserId, 'authenticatedUserId');
    const canonical = authorizeActor(context, userId);
    if (canonical.tenantId !== tenant) {
      throw policyError('mail policy tenant mismatch', 'CROSS_TENANT_ACCESS');
    }
    if (options.authenticated !== true) {
      throw policyError('authenticated submission is required; open relay is disabled', 'OPEN_RELAY_DISABLED');
    }
    const sender = normalizeAddress(options.sender ?? options.envelopeFrom, 'sender');
    const fromDomain = sender.slice(sender.lastIndexOf('@') + 1);
    if (fromDomain !== canonicalDomain) {
      throw policyError('submission sender is outside the tenant domain', 'SENDER_FORBIDDEN');
    }
    const resolvedDirectory = directory({ users: options.users, aliases: options.aliases });
    const senderUser = resolvedDirectory.users.byAddress.get(sender);
    const senderAlias = resolvedDirectory.aliases.get(sender);
    const ownsSender = senderUser?.userId === userId || senderAlias?.some((address) => resolvedDirectory.users.byAddress.get(address)?.userId === userId);
    if (!ownsSender) {
      throw policyError('authenticated user is not authorized for the sender identity', 'SENDER_FORBIDDEN');
    }

    const recipients = normalizeRecipients(options.recipients);
    if (recipients.length > maxRecipients) {
      throw policyError('recipient limit exceeded', 'RECIPIENT_LIMIT');
    }
    const internalRecipients = recipients.filter((address) => address.endsWith(`@${canonicalDomain}`));
    if (internalRecipients.length > 0) {
      const internalResolution = resolveRecipients({ recipients: internalRecipients, users: options.users, aliases: options.aliases });
      if (!internalResolution.accepted) {
        throw policyError('submission contains an unknown internal recipient', 'RECIPIENT_REJECTED');
      }
    }
    assertMessageSize(options.sizeBytes ?? 0);
    const rate = consumeSubmissionRate(userId);
    if (!rate.allowed) {
      throw policyError('submission rate limit exceeded', 'RATE_LIMITED');
    }
    return Object.freeze({
      sender,
      requested: recipients,
      resolved: Object.freeze(recipients.filter((address) => address.endsWith(`@${canonicalDomain}`)).map((address) => ({ address, via: 'submission' }))),
      external: Object.freeze(recipients.filter((address) => !address.endsWith(`@${canonicalDomain}`))),
      authenticated: true,
      authenticatedUserId: userId,
      path: 'submission',
    });
  }

  function validateSieve(script) {
    if (typeof script !== 'string' || script.length === 0) {
      throw policyError('Sieve script must be a non-empty string', 'INVALID_SIEVE');
    }
    if (Buffer.byteLength(script, 'utf8') > SIEVE_MAX_BYTES) {
      throw policyError('Sieve script exceeds the size limit', 'INVALID_SIEVE');
    }
    if (FORWARDING_PATTERN.test(script)) {
      throw policyError('automatic forwarding and redirect actions are disabled', 'FORWARDING_DISABLED');
    }
    const actions = [...script.matchAll(/\b(fileinto|vacation|keep|discard|stop)\b/gi)].map((match) => match[1].toLowerCase());
    return Object.freeze({ valid: true, actions: Object.freeze([...new Set(actions)]) });
  }

  function audit({ eventType, context, result, reason = null, details = {} } = {}) {
    const canonical = assertTenantContext(context);
    return Object.freeze({
      eventType: requiredString(eventType, 'eventType'),
      tenantId: canonical.tenantId,
      actorId: canonical.actorId,
      result: requiredString(result, 'result'),
      reason,
      details: Object.freeze({ ...details }),
      occurredAt: clock().toISOString(),
    });
  }

  return Object.freeze({
    tenantId: tenant,
    domain: canonicalDomain,
    maxMessageBytes,
    maxRecipients,
    maxMessagesPerUserPerMinute,
    normalizeAddress,
    resolveRecipients,
    assertMessageSize,
    authorizeInbound,
    authorizeSubmission,
    consumeSubmissionRate,
    validateSieve,
    audit,
  });
}

export { FORWARDING_PATTERN, normalizeAddress, policyError };
