# Runtime and observability

> **⚠️ Documento in transizione.** Le sezioni di questo documento che descrivono deployment container/Docker/Kubernetes (volumi, socket, sidecar, rollout blue/green) si riferiscono al modello precedente, abbandonato — vedi [ADR-002](../../ADR-002-gulogulo-packaging-and-distribution-targets.md). Il contenuto su protocolli, sicurezza applicativa, e logica di business resta valido; gli aspetti di deployment container-specifici non sono più applicabili e saranno riscritti quando necessario.

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
  "version": "0.1.4",
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

## A quick probe

```powershell
curl.exe -i http://127.0.0.1:8080/health/ready
curl.exe -i -H 'x-request-id: manual-001' http://127.0.0.1:8080/ops/patch/status
curl.exe http://127.0.0.1:8080/metrics
```

Do not use health endpoints to test credentials or tenant content. They are
intentionally safe and intentionally small.
