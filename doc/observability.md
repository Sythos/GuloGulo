# Runtime and observability

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

The current runtime is deliberately boring: one Node.js process, a small HTTP
surface, JSON logs on stdout/stderr, and no fake calls to LDAP or PostgreSQL.
That gives later milestones a stable place to plug in real dependencies.

## Health endpoints

All responses are JSON except `/metrics`:

| Endpoint | Meaning | Healthy status |
|---|---|---:|
| `GET /health/live` | The process can answer requests | 200 |
| `GET /health/ready` | The process is ready and registered dependencies are usable | 200 or 503 |
| `GET /healthz` | Compatibility alias for liveness | 200 |
| `GET /readyz` | Compatibility alias for readiness | 200 or 503 |
| `GET /ops/patch/status` | Read-only patch state | 200 |
| `GET /metrics` | Prometheus-compatible metrics text | 200 |

Liveness does not pretend that external services are available. Readiness is
fail-closed for dependencies in `starting`, `degraded`, `failed`, or `unknown`
state. An empty registry is reported as `disabled`, which is the correct state
for the empty scaffold.

Every response includes `request_id`, `correlation_id`, `version`, and
`build_digest`. The same request IDs are returned in `x-request-id` and
`x-correlation-id` response headers. A caller may provide safe ASCII IDs; the
runtime generates UUIDs when they are missing or invalid.

## Structured logs

Logs are one JSON object per line. Stable fields include:

```json
{
  "timestamp": "2026-08-22T00:00:00.000Z",
  "level": "info",
  "service": "gulogulo-runtime",
  "environment": "test",
  "version": "0.1.7",
  "build": "sha256:example",
  "event": "request_completed",
  "tenant": null,
  "actor": null,
  "subject": null,
  "correlation_id": "correlation-456",
  "request_id": "request-123",
  "result": "success",
  "reason": null
}
```

The logger redacts password-like keys, authorization headers, cookies, tokens,
private keys, message/body/content fields, inline bearer/basic credentials,
errors containing those values, circular references, non-finite numbers, and
BigInts. It is still better not to pass a mailbox object or request body to a
logger in the first place.

Services write to stdout/stderr. Rotation belongs to Docker, journald, or an
external collector; the application does not require a local log file.

## Metrics

The dependency-free registry supports counters, gauges, and histogram count and
sum observations. Labels are sorted, bounded, printable, and rejected when
their names could carry secrets or message content.

The runtime records HTTP request count and duration, dependency status, a
`gulogulo_build_info` gauge carrying the safe version/build labels, and
bounded `gulogulo_abuse_allowed_total` / `gulogulo_abuse_limited_total`
counters labelled only by channel. Rate-limit logs contain no raw IP, session,
cookie, credential, or message data. LP5's local capacity proof additionally
measures web/DAV p95 latency, queue and IMAP IDLE contract timing, and resource
limits without turning those fixture measurements into a production capacity
claim.

## Alerting

`src/core/observability/alert-policy.ts` decides **whether** and **how
severely** to alert from metadata-only health/capacity snapshots
(dependency status, mail queue depth/age, certificate expiry, storage/quota
pressure, authentication-failure bursts). It is deliberately pure: it
returns a frozen list of `{code, severity, source, subject, observed,
threshold, message, generated_at}` records and never performs I/O, opens a
socket, or knows that any delivery adapter exists.

`src/core/observability/webhook-alert-adapter.ts` is the layer that actually
delivers what `alert-policy.ts` decided: a generic, injectable HTTP webhook
adapter (`createWebhookAlertAdapter()`) that POSTs one JSON body per alert,
with a bounded timeout and a limited, exponential-backoff retry that only
re-attempts transient failures (network errors, timeouts, `5xx`) — never a
`4xx`, since a client error will not succeed on retry. The webhook URL's
hostname may appear in a retry/failure log line; the URL's path and query
(where a Slack/Discord/PagerDuty token normally lives) never does, in either
a log call or a thrown error.

**Payload format** (`alerting.format`, one of `generic`/`slack`/`discord`):

- `slack` sends `{"text": "..."}` — the one field Slack's documented
  incoming-webhook contract actually requires.
- `discord` sends `{"content": "..."}` — Discord's equivalent minimum.
- `generic` sends the alert's own structured fields (`code`, `severity`,
  `source`, `subject`, `observed`, `threshold`, `message`, `generated_at`)
  as-is, for a listener that understands Gulo Gulo's own alert shape — a
  custom collector, or a relay in front of a service with a richer schema of
  its own (PagerDuty's Events API v2 needs `routing_key`/`event_action`/a
  nested `payload` object this adapter does not fabricate; point a relay at
  the `generic` webhook if that translation is needed).

A single payload format was chosen deliberately over a dedicated adapter per
target service: Slack and Discord's incoming webhooks each need exactly one
field, so switching that one field is enough — there is no per-service
protocol difference beyond it.

**Wiring** (`src/platform/contract/platform-adapter.ts`):

- `PlatformAdapter.createAlertDelivery(config)` (optional, implemented by
  all three current targets) resolves an `AlertDeliveryAdapter` from
  `alerting.*` in the loaded configuration (`src/runtime/config.ts`):
  `enabled`, `webhookUrlSecretRef` (the webhook URL is a secret reference,
  never a plain config value — a Slack/Discord/PagerDuty webhook URL carries
  its own bearer token in its path, so it is resolved through the same
  `resolveSecret` mechanism as `ldap.bindSecretRef`/`postgres.dsnSecretRef`),
  `format`, `timeoutMs`, `retryAttempts`, and `minSeverity`. Disabled by
  default; disabled or unconfigured returns the same safe no-op shape
  `createLdapIdentityClient()`/`createPostgresStore()` already use for
  `enabled: false`.
- `deliverAlertEvaluation(evaluation, delivery)` in
  `webhook-alert-adapter.ts` is the explicit call site connecting the two:
  it takes `alertPolicy.evaluate(snapshot)`'s output and forwards
  `evaluation.alerts` to `delivery.deliver()` — a no-op when the adapter is
  disabled or there is nothing to alert on. Nothing today calls this on a
  timer; no periodic health-snapshot-to-alert-evaluation loop exists yet in
  the runtime (see "What is not built" below), so this is the ready-to-use
  wiring point for whichever milestone adds one.

**Paging.** `alerting.minSeverity` (`'warning'`, the default, or
`'critical'`) is also the paging knob: point the same webhook at a
PagerDuty/Opsgenie-compatible webhook URL and set `minSeverity: 'critical'`
to use it purely for paging on critical alerts, while a separate `'warning'`
target (e.g. Slack) sees everything. No dedicated paging adapter exists or
is needed — paging is this same mechanism, differentiated only by the
severity `alert-policy.ts` already computes.

**What is verified.** `webhook-alert-adapter.test.ts` runs a real
`node:http` server on `127.0.0.1` (the same principle as the IMAP/SMTP
protocol fakes) and confirms: payload shape per format, timeout handling,
retry-then-succeed on `5xx`, no retry on `4xx`, connection-refused handling,
and that no error or log call ever contains the webhook path/token.
`platform-adapter.test.ts` confirms `createConfiguredAlertDelivery()`'s
disabled-by-default behavior, secret-reference resolution, and
`minSeverity` filtering end to end against the same kind of fake server.

**What is VERIFY BEFORE USE.** None of this has been exercised against a
real Slack, Discord, or PagerDuty/Opsgenie endpoint — only against
Slack's/Discord's published incoming-webhook documentation and a local
fake. Before relying on this in production: send a real alert through a
real Slack/Discord webhook and a real paging service, confirm it renders
and pages as expected, and decide (operationally) which health signals
should actually feed `alert-policy.ts`'s `evaluate()` — that snapshot
assembly (reading live dependency/queue/certificate/capacity state and
calling `evaluate()` periodically) is not built; only the pure evaluator
and the delivery adapter are.

### Log collector

There is no separate application-level "log collector" and none was built
for this milestone. Services already write one JSON object per line to
stdout/stderr (see "Structured logs" above), and in the non-container
deployment model both the `cpanel` and `plesk` targets install and enable a
dedicated `gulogulo.service` systemd unit as part of `install.sh` (the
`standalone` target only stages `gulogulo.service.example` for the operator
to copy in manually, and otherwise leaves process supervision — systemd,
pm2, or a manual foreground process — up to them). Wherever systemd does
manage the process, journald already captures that stream automatically
(`journalctl -u gulogulo`), and `journald`'s own
`SystemMaxUse`/`SystemMaxFileSize`/retention settings (configurable host
policy, or via `createLogRotationPolicy({mode: 'journald', ...})` in
`src/core/observability/log-policy.ts`, which already validates a bounded
`journald`/`sidecar`/`docker-json-file` rotation policy) do the rotation. A
plain-file deployment can instead let `logrotate` own rotation, per its own
standard host configuration. Shipping those bytes onward to Loki/
Elasticsearch/etc. is a host/operator choice (a journald forwarder or a
logrotate `postrotate` hook), not something Gulo Gulo's own process needs to
do — building an in-process log-forwarding client would duplicate what the
host already does well, and would be one more thing that could itself leak
sanitized-but-still-sensitive log content if misconfigured. If a future
milestone needs a specific external log sink (e.g. a required Loki push),
that is new, explicit scope — not a gap in what exists today.

## A quick probe

```powershell
curl.exe -i http://127.0.0.1:8080/health/ready
curl.exe -i -H 'x-request-id: manual-001' http://127.0.0.1:8080/ops/patch/status
curl.exe http://127.0.0.1:8080/metrics
```

Do not use health endpoints to test credentials or tenant content. They are
intentionally safe and intentionally small.
