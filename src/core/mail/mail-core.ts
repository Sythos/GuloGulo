// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createImapIdleBroker } from './imap-idle.ts';
import { createMailQueue } from './mail-queue.ts';
import { createClamAvScanner, createRspamdScanner, normalizeClamAvVerdict, normalizeRspamdVerdict } from './mail-scanners.ts';
import type { ImapIdleBroker } from './imap-idle.ts';
import type { MailScanMetadata, MailScannerLogger } from './mail-scanners.ts';
import type { createMailPolicy, MailEnvelopeOptions, ResolvedRecipient } from './mail-policy.ts';

export interface LmtpDeliveryInput { tenantId: string; userId: string; address: string; sizeBytes: number; messageRef: string | null }
export interface LmtpDeliveryResult { status: string; mailbox?: string; uidNext?: number | null }
export interface MailCoreOptions {
  policy?: ReturnType<typeof createMailPolicy>;
  rspamd?: { scan(metadata: MailScanMetadata): unknown };
  clamav?: { scan(metadata: MailScanMetadata): unknown };
  lmtp?: { deliver(input: LmtpDeliveryInput): Promise<LmtpDeliveryResult> };
  queue?: ReturnType<typeof createMailQueue>; idle?: ImapIdleBroker;
  quota?: { reserve(context: unknown, input: { userId: string; sizeBytes: number }): Promise<{ accepted: boolean }> };
  logger?: MailScannerLogger; clock?: () => Date;
}
function errorName(error: unknown): string { return error instanceof Error ? error.name : 'Error'; }

function coreError(message: string, code = 'MAIL_CORE_ERROR') {
  return Object.assign(new Error(`Mail core error: ${message}`), { code });
}

function messageMetadata(options: MailEnvelopeOptions = {}) {
  return {
    sender: options.sender,
    recipients: options.recipients,
    sizeBytes: options.sizeBytes ?? 0,
    messageRef: options.messageRef ?? null,
  };
}

function auditOrNull(policy: ReturnType<typeof createMailPolicy>, context: unknown, eventType: string, result: string, reason: string, details: Record<string, unknown>) {
  return typeof policy.audit === 'function'
    ? policy.audit({ eventType, context, result, reason, details })
    : null;
}

/**
 * Orchestrate the mail protocol contracts. It deliberately keeps message
 * content opaque: scanners and LMTP receive a private message reference,
 * while queue views, logs, and audit metadata contain only safe metadata.
 */
export function createMailCore({
  policy: configuredPolicy,
  rspamd,
  clamav,
  lmtp = { async deliver() { return { status: 'temporary_failure' }; } },
  queue = createMailQueue(),
  idle = createImapIdleBroker(),
  quota = { async reserve() { return { accepted: true }; } },
  logger = console,
  clock = () => new Date(),
}: MailCoreOptions = {}) {
  if (configuredPolicy === undefined || configuredPolicy === null || typeof configuredPolicy !== 'object') throw coreError('a mail policy is required', 'CONFIGURATION');
  const policy = configuredPolicy;
  const rspamdScanner = rspamd ?? createRspamdScanner({ logger });
  const clamavScanner = clamav ?? createClamAvScanner({ logger });
  const acceptedOrDeferred = (status: string) => status === 'clean' || status === 'accepted';

  async function scan(options: MailEnvelopeOptions) {
    const metadata = messageMetadata(options);
    let rspamdVerdict;
    try {
      rspamdVerdict = normalizeRspamdVerdict(await rspamdScanner.scan(metadata));
    } catch (error) {
      logger.warn?.('mail_rspamd_verdict_invalid', { error: { name: errorName(error) } });
      return { status: 'deferred', reason: 'rspamd_unavailable' };
    }
    if (rspamdVerdict.action === 'reject') return { status: 'rejected', reason: 'spam_policy', rspamdVerdict };
    if (rspamdVerdict.action === 'quarantine' || rspamdVerdict.action === 'soft_reject' || rspamdVerdict.action === 'unavailable') {
      return { status: rspamdVerdict.action === 'quarantine' ? 'quarantined' : 'deferred', reason: rspamdVerdict.action === 'unavailable' ? 'rspamd_unavailable' : `rspamd_${rspamdVerdict.action}`, rspamdVerdict };
    }

    let clamavVerdict;
    try {
      clamavVerdict = normalizeClamAvVerdict(await clamavScanner.scan(metadata));
    } catch (error) {
      logger.warn?.('mail_clamav_verdict_invalid', { error: { name: errorName(error) } });
      return { status: 'deferred', reason: 'clamav_unavailable', rspamdVerdict };
    }
    if (clamavVerdict.status === 'infected') return { status: 'quarantined', reason: 'malware_detected', rspamdVerdict, clamavVerdict };
    if (clamavVerdict.status === 'unavailable') return { status: 'deferred', reason: 'clamav_unavailable', rspamdVerdict, clamavVerdict };
    return { status: 'accepted', reason: 'clean', rspamdVerdict, clamavVerdict };
  }

  async function receiveInbound(context: unknown, options: MailEnvelopeOptions = {}) {
    const authorization = policy.authorizeInbound(context, options);
    const result = await scan(options);
    const baseDetails = { path: 'inbound', recipientCount: authorization.resolved.length, sizeBytes: options.sizeBytes ?? 0 };
    if (result.status === 'deferred') {
      const queued = queue.enqueue(context, { ...messageMetadata(options), reason: result.reason });
      const audit = auditOrNull(policy, context, 'mail.delivery.failed', 'deferred', result.reason, { ...baseDetails, queueId: queued.queueId });
      return Object.freeze({ status: 'deferred', reason: result.reason, queue: queued, audit });
    }
    if (!acceptedOrDeferred(result.status)) {
      const audit = auditOrNull(policy, context, 'mail.delivery.failed', result.status, result.reason, baseDetails);
      return Object.freeze({ status: result.status, reason: result.reason, audit });
    }

    const delivered: ResolvedRecipient[] = [];
    const deferred: string[] = [];
    for (const recipient of authorization.resolved) {
      const reservation = await quota.reserve(context, { userId: recipient.userId, sizeBytes: options.sizeBytes ?? 0 });
      if (reservation?.accepted !== true) {
        throw coreError('mail delivery would exceed the assigned quota', 'QUOTA_EXCEEDED');
      }
      const delivery = await lmtp.deliver({
        tenantId: policy.tenantId,
        userId: recipient.userId,
        address: recipient.address,
        sizeBytes: options.sizeBytes ?? 0,
        messageRef: options.messageRef ?? null,
      });
      if (delivery?.status === 'temporary_failure') {
        deferred.push(recipient.address);
        continue;
      }
      if (delivery?.status !== 'delivered') {
        const audit = auditOrNull(policy, context, 'mail.delivery.failed', 'rejected', 'lmtp_failure', { ...baseDetails, address: recipient.address });
        return Object.freeze({ status: 'rejected', reason: 'lmtp_failure', audit });
      }
      delivered.push(recipient);
      idle.notify(context, { userId: recipient.userId, mailbox: delivery.mailbox ?? 'INBOX', kind: 'exists', uidNext: delivery.uidNext ?? null });
    }
    if (deferred.length > 0) {
      const queued = queue.enqueue(context, { ...messageMetadata(options), reason: 'lmtp_temporary_failure' });
      const audit = auditOrNull(policy, context, 'mail.delivery.failed', 'deferred', 'lmtp_temporary_failure', { ...baseDetails, queueId: queued.queueId });
      return Object.freeze({ status: delivered.length > 0 ? 'partial' : 'deferred', delivered: Object.freeze(delivered.map((entry) => entry.address)), queue: queued, audit });
    }
    const audit = auditOrNull(policy, context, 'mail.delivery.accepted', 'accepted', 'delivered', baseDetails);
    return Object.freeze({ status: 'delivered', delivered: Object.freeze(delivered.map((entry) => entry.address)), audit });
  }

  async function submit(context: unknown, options: MailEnvelopeOptions = {}) {
    const authorization = policy.authorizeSubmission(context, options);
    const result = await scan(options);
    if (result.status !== 'accepted') {
      const audit = auditOrNull(policy, context, 'mail.delivery.failed', result.status, result.reason, { path: 'submission', sizeBytes: options.sizeBytes ?? 0 });
      return Object.freeze({ status: result.status, reason: result.reason, audit });
    }
    const queued = queue.enqueue(context, {
      ...messageMetadata(options),
      reason: 'authenticated_submission',
    });
    const audit = auditOrNull(policy, context, 'mail.queue.enqueued', 'accepted', 'authenticated_submission', { path: 'submission', queueId: queued.queueId, recipientCount: authorization.requested.length });
    return Object.freeze({ status: 'queued', queue: queued, audit });
  }

  function validateSieve(context: unknown, script: unknown) {
    const result = policy.validateSieve(script);
    const actorId = context !== null && typeof context === 'object' && 'actorId' in context ? context.actorId : null;
    return Object.freeze({ ...result, tenantId: policy.tenantId, actorId });
  }

  return Object.freeze({
    receiveInbound,
    submit,
    scan,
    validateSieve,
    subscribeIdle: idle.subscribe,
    notifyIdle: idle.notify,
    viewQueue: queue.view,
    queue,
    idle,
    clock,
  });
}

export { coreError };
