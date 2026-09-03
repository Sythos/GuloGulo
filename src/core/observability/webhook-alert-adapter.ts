// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 5;
const MAX_TEXT_LENGTH = 1_000;
const FORMATS = Object.freeze(['generic', 'slack', 'discord']);

export type AlertSeverity = 'warning' | 'critical';
export type WebhookPayloadFormat = 'generic' | 'slack' | 'discord';

/** The shape `alert-policy.ts`'s `evaluate().alerts` entries already have. */
export interface AlertRecord {
  readonly code: string;
  readonly severity: AlertSeverity;
  readonly source: string;
  readonly subject: string;
  readonly observed: unknown;
  readonly threshold: unknown;
  readonly message: string;
  readonly generated_at: string;
}

/** The subset of `createAlertPolicy().evaluate()`'s return value this module needs. */
export interface AlertEvaluation {
  readonly alerts: readonly AlertRecord[];
}

export interface AlertAdapterLogger {
  warn?: (event: string, details?: Record<string, unknown>) => void;
  info?: (event: string, details?: Record<string, unknown>) => void;
}

export interface AlertDeliveryError {
  readonly alertCode: string;
  readonly code: string;
  readonly message: string;
}

export interface AlertDeliveryResult {
  readonly delivered: number;
  readonly failed: number;
  readonly errors: readonly AlertDeliveryError[];
}

/**
 * The seam `alert-policy.ts`'s evaluation is wired to. `alert-policy.ts`
 * stays pure — it only decides whether/how severely to alert; this is the
 * one piece that actually performs I/O, and it is always injectable so a
 * test (or a `PlatformAdapter` that predates alert-delivery wiring) can
 * substitute a fake instead of opening a real socket.
 */
export interface AlertDeliveryAdapter {
  readonly enabled: boolean;
  deliver(alerts: readonly AlertRecord[]): Promise<AlertDeliveryResult>;
}

export interface WebhookAlertAdapterOptions {
  /** The full webhook URL, already resolved from its secret reference — never logged. */
  readonly webhookUrl: string;
  readonly format?: WebhookPayloadFormat;
  readonly timeoutMs?: number;
  readonly retryAttempts?: number;
  /** Injectable for tests; defaults to Node's global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable for tests so backoff does not slow the suite down. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: AlertAdapterLogger;
}

interface CodedError extends Error {
  readonly code: string;
  readonly status?: number;
}

function webhookAlertError(message: string, code = 'ALERT_WEBHOOK_ERROR', status?: number): CodedError {
  const error = new Error(`Webhook alert delivery error: ${message}`) as CodedError;
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  if (status !== undefined) {
    Object.defineProperty(error, 'status', { value: status, enumerable: true });
  }
  return error;
}

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Network failures and timeouts are transient by nature; a 5xx response is
 * usually the receiving end having a bad moment too. A 4xx (bad URL, bad
 * payload, revoked token, ...) will not fix itself on a retry, so it is
 * surfaced immediately instead of hammering the endpoint.
 */
function isRetryable(error: unknown): boolean {
  const coded = error as Partial<CodedError> | null;
  if (coded === null || typeof coded !== 'object') return false;
  if (coded.code === 'TIMEOUT' || coded.code === 'NETWORK_ERROR') return true;
  return coded.code === 'HTTP_ERROR' && typeof coded.status === 'number' && coded.status >= 500;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readWebhookUrl(value: string): URL {
  if (typeof value !== 'string' || value.length === 0) {
    throw webhookAlertError('webhookUrl is required', 'CONFIGURATION');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw webhookAlertError('webhookUrl is not a valid URL', 'CONFIGURATION');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username.length > 0 || parsed.password.length > 0) {
    throw webhookAlertError('webhookUrl must use http:// or https:// without embedded credentials', 'CONFIGURATION');
  }
  return parsed;
}

function readFormat(value: WebhookPayloadFormat | undefined): WebhookPayloadFormat {
  const format = value ?? 'generic';
  if (!FORMATS.includes(format)) {
    throw webhookAlertError(`format must be one of: ${FORMATS.join(', ')}`, 'CONFIGURATION');
  }
  return format;
}

function readTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw webhookAlertError(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`, 'CONFIGURATION');
  }
  return value;
}

function readRetryAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETRY_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RETRY_ATTEMPTS) {
    throw webhookAlertError(`retryAttempts must be an integer between 0 and ${MAX_RETRY_ATTEMPTS}`, 'CONFIGURATION');
  }
  return value;
}

function truncate(value: string, maxLength = MAX_TEXT_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function scalar(value: unknown): string | number {
  return typeof value === 'number' || typeof value === 'string' ? value : String(value);
}

function formatText(alert: AlertRecord): string {
  return truncate([
    `[${String(alert.severity).toUpperCase()}] ${alert.message}`,
    `code=${alert.code}`,
    `source=${alert.source}`,
    `subject=${alert.subject}`,
    `observed=${scalar(alert.observed)}`,
    `threshold=${scalar(alert.threshold)}`,
  ].join(' | '));
}

/**
 * Builds the JSON body POSTed to the webhook.
 *
 * `slack` and `discord` send the one field each platform's *incoming
 * webhook* actually requires — `{"text": "..."}` for Slack, `{"content":
 * "..."}` for Discord, per both platforms' publicly documented incoming-
 * webhook contracts. Neither needs blocks/embeds/username/avatar to accept a
 * message; those are optional decoration this adapter deliberately does not
 * add, to keep one payload shape working across every Slack/Discord webhook
 * without per-workspace formatting assumptions.
 *
 * `generic` sends the alert's own structured fields (code/severity/source/
 * subject/observed/threshold/message/generated_at) as-is, for a listener
 * that understands Gulo Gulo's own alert shape — a custom collector, or a
 * relay in front of a service with its own richer schema (e.g. PagerDuty's
 * Events API v2, which needs `routing_key`/`event_action`/a nested
 * `payload` object this adapter does not attempt to fabricate). It does not
 * assume the receiving end wants a human-readable string, so unlike
 * `slack`/`discord` it carries no `text` field.
 *
 * This mapping has been verified against Slack's and Discord's published
 * incoming-webhook documentation, not against a live Slack/Discord/PagerDuty
 * endpoint — see doc/observability.md for what is and is not confirmed.
 */
function buildPayload(alert: AlertRecord, format: WebhookPayloadFormat): Record<string, unknown> {
  if (format === 'slack') {
    return { text: formatText(alert) };
  }
  if (format === 'discord') {
    return { content: formatText(alert) };
  }
  return {
    event: 'gulogulo.alert',
    code: alert.code,
    severity: alert.severity,
    source: alert.source,
    subject: alert.subject,
    observed: alert.observed,
    threshold: alert.threshold,
    message: alert.message,
    generated_at: alert.generated_at,
  };
}

/**
 * A generic, injectable webhook delivery adapter for `alert-policy.ts`'s
 * output: one JSON `POST` per alert, with a bounded timeout and a limited,
 * exponential-backoff retry that only re-attempts transient failures
 * (network errors, timeouts, 5xx) — never a 4xx, which will not succeed on
 * retry. The webhook URL is never included in a thrown error or a log call;
 * only its hostname is (a webhook token lives in the path/body, never the
 * host).
 *
 * Verified so far only against a local `node:http` fake
 * (`webhook-alert-adapter.test.ts`), the same principle already used for the
 * IMAP/SMTP protocol fakes — real Slack/Discord/PagerDuty interoperability
 * is unverified operational work (see doc/observability.md).
 */
export function createWebhookAlertAdapter({
  webhookUrl,
  format,
  timeoutMs,
  retryAttempts,
  fetchImpl = fetch,
  sleep: sleepFunction = defaultSleep,
  logger = console,
}: WebhookAlertAdapterOptions): AlertDeliveryAdapter {
  const parsedUrl = readWebhookUrl(webhookUrl);
  const canonicalFormat = readFormat(format);
  const canonicalTimeoutMs = readTimeoutMs(timeoutMs);
  const canonicalRetryAttempts = readRetryAttempts(retryAttempts);
  const safeHost = parsedUrl.hostname;

  async function postOnce(alert: AlertRecord): Promise<void> {
    const body = JSON.stringify(buildPayload(alert, canonicalFormat));
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), canonicalTimeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(parsedUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw webhookAlertError(`delivery timed out after ${canonicalTimeoutMs}ms`, 'TIMEOUT');
      }
      throw webhookAlertError('delivery request failed', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!response.ok) {
      throw webhookAlertError(`webhook responded with HTTP ${response.status}`, 'HTTP_ERROR', response.status);
    }
  }

  async function postWithRetry(alert: AlertRecord): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= canonicalRetryAttempts; attempt += 1) {
      try {
        await postOnce(alert);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === canonicalRetryAttempts || !isRetryable(error)) {
          break;
        }
        logger.warn?.('alert_webhook_retry', {
          host: safeHost,
          alert_code: alert.code,
          attempt: attempt + 1,
          error_code: (error as CodedError).code,
        });
        await sleepFunction(Math.min(1_000, 100 * (2 ** attempt)));
      }
    }
    throw lastError;
  }

  async function deliver(alerts: readonly AlertRecord[]): Promise<AlertDeliveryResult> {
    let delivered = 0;
    const errors: AlertDeliveryError[] = [];
    for (const alert of alerts) {
      try {
        await postWithRetry(alert);
        delivered += 1;
      } catch (error) {
        const coded = error as Partial<CodedError>;
        const code = typeof coded.code === 'string' ? coded.code : 'UNKNOWN';
        logger.warn?.('alert_webhook_delivery_failed', {
          host: safeHost,
          alert_code: alert.code,
          error_code: code,
        });
        errors.push({
          alertCode: alert.code,
          code,
          message: code === 'HTTP_ERROR' ? `HTTP ${coded.status}` : code,
        });
      }
    }
    return Object.freeze({ delivered, failed: errors.length, errors: Object.freeze(errors) });
  }

  return Object.freeze({ enabled: true as const, deliver });
}

/** The safe no-op shape used whenever alert delivery is disabled or unconfigured. */
export function createDisabledAlertDelivery(): AlertDeliveryAdapter {
  return Object.freeze({
    enabled: false as const,
    deliver: async () => Object.freeze({ delivered: 0, failed: 0, errors: Object.freeze([]) }),
  });
}

/**
 * The wiring between `alert-policy.ts`'s pure evaluation and an injected
 * `AlertDeliveryAdapter`. `alert-policy.ts` itself never calls this — it has
 * no reference to any adapter — so this is the one explicit call site that
 * turns "these thresholds were breached" into "these alerts were delivered".
 * A disabled adapter or an empty evaluation is a safe no-op.
 */
export async function deliverAlertEvaluation(
  evaluation: AlertEvaluation,
  delivery: AlertDeliveryAdapter,
): Promise<AlertDeliveryResult> {
  if (!delivery.enabled || evaluation.alerts.length === 0) {
    return { delivered: 0, failed: 0, errors: [] };
  }
  return delivery.deliver(evaluation.alerts);
}
