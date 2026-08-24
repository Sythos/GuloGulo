# LP3 local mail proof

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

LP3 is the first deployment rehearsal for the mail side of Gulo Gulo. It is a
small, deliberately synthetic mail room that can be started on a laptop or on
a GitHub-hosted runner without a real domain, public DNS, public ACME, or an
Internet mail peer. Think of it as a fire drill: the doors, alarms, queues,
and policy decisions are real enough to exercise, while the people and mail
inside are made up.

The machine-readable contract is
[release/lp3-local-mail.json](../release/lp3-local-mail.json). The static
Compose audit is [scripts/lp3-compose-audit.mjs](../scripts/lp3-compose-audit.mjs),
the Docker orchestration smoke is
[scripts/lp3-compose-smoke.mjs](../scripts/lp3-compose-smoke.mjs), and the
client-side protocol probe is
[scripts/lp3-proof-smoke.mjs](../scripts/lp3-proof-smoke.mjs).

## What this proof does and does not mean

The proof does exercise the boundaries we care about:

- Postfix SMTP ingress and authenticated-submission policy;
- rejection of unauthenticated external relay;
- explicit alias delivery and rejection of an unknown internal recipient;
- Dovecot IMAPS, IMAP IDLE capability, and a reconnect sequence;
- Dovecot LMTP readiness;
- Rspamd and ClamAV reachability;
- scanner-unavailable fail-closed behavior in the typed mail contracts;
- quota-before-LMTP acknowledgement as a typed contract;
- queue retry, exponential defer, bounce after the configured attempt limit,
  and metadata-only queue views;
- explicit Sieve actions with redirect/automatic forwarding denied;
- the 28-day trash contract;
- dual-stack addressing on an internal Compose network;
- persistent mail and queue volumes, including a service restart;
- Ubuntu 26.04 LTS image construction for linux/amd64 and linux/arm64;
- image patch metadata and the apt-get update && apt-get upgrade build step.

It does not claim that Gulo Gulo is ready to deliver real mail. The LP3
network is internal and the proof client has no route to an Internet SMTP
peer. No public names, real credentials, real mailbox exports, production
LDAP/PostgreSQL, public certificates, or provider-owned scanner feeds belong
in this rehearsal. Vendor image selection, immutable production digests,
freshclam/map update rehearsals, external TLS interoperability, reputation,
and real-domain delivery remain outside this local milestone.

## Service topology

The Compose profile names are intentionally explicit. They make it obvious in
CI which services belong to this proof and make it possible to run LP3 beside
other disposable proof projects without sharing names or volumes.

| Service | Main job | Internal endpoint used by the probe |
|---|---|---|
| lp3-tls | Disposable internal CA and leaf certificates for the mail endpoints | shared TLS volume |
| lp3-postfix | SMTP ingress, submission policy, aliases, relay denial | 25, 587, optional 465 |
| lp3-dovecot | IMAPS, IMAP IDLE, Sieve, LMTP, mailbox and quota boundary | 993, internal LMTP 24 |
| lp3-rspamd | Spam verdict service | HTTP 11333 |
| lp3-clamav | Antivirus verdict service | clamd 3310 |
| gulogulo-lp3-proof-check | Deterministic protocol and contract client | no published endpoint |
| gulogulo-lp3-proof-node | Compiled TypeScript mail contract client | no published endpoint |

All seven LP3 services join lp3-runtime, an internal IPv4/IPv6 network. The
network uses a private ULA subnet (fd42:4755:756c:7033::/64) and has no host
port bindings. The proof client talks to service names, never to localhost
and never to a Docker socket.

The logical role boundaries are kept even if a later deployment decides to
package two small roles in one image. Postfix owns SMTP protocol state,
Dovecot owns mailbox folders/UIDs and the IMAP boundary, PostgreSQL remains
the application policy and metadata source of truth, and the message store is
not copied into an API response or queue view.

## Volumes and restart safety

LP3 uses the following named volumes:

| Volume | Owner | Why it survives a container replacement |
|---|---|---|
| lp3-tls-data | Disposable CA service | Short-lived local certificates for the proof |
| lp3-mail-data | Dovecot/mailbox adapter | Mailbox files, folders, UID state, and quota-facing data |
| lp3-postfix-spool | Postfix | Queue files that must survive a Postfix restart |
| lp3-queue-data | Gulo Gulo queue adapter | Persistent delivery metadata and retry continuity |
| lp3-postfix-state | Postfix | Service state separate from the mailbox volume |
| lp3-dovecot-state | Dovecot | Service/index state separate from the mailbox volume |
| lp3-rspamd-data | Rspamd adapter | Local maps and scanner state used by the rehearsal |
| lp3-clamav-data | ClamAV adapter | Local database/cache state used by the rehearsal |

The Compose variable GULOGULO_LP3_VOLUMES_EXTERNAL follows the same pattern
as the earlier local-proof volumes. CI leaves it false, so its disposable
project can clean up safely. An operator can pre-create named production
volumes and set it to true; the container lifecycle then does not own the
data lifecycle.

The smoke runner checks the actual container mounts, restarts Postfix and
Dovecot, waits for health again, and runs the protocol proof a second time.
That catches the classic "it worked during first boot, then lost its socket or
configuration" failure.

## Mail safety rules

These are policy rules, not UI hints:

1. An unauthenticated SMTP client cannot relay to an external recipient.
2. A submission client must authenticate before it can submit mail.
3. Internal recipients must be active users or explicit aliases in the tenant.
4. There is no catch-all recipient fallback.
5. An alias may expand only to explicit active users in the same tenant and may
   not shadow a real mailbox.
6. Sieve redirect and automatic forwarding are rejected at the policy
   boundary. The browser is not trusted to enforce this by itself.
7. Rspamd or ClamAV being unavailable is not an implicit clean verdict. The
   message is deferred/quarantined according to the typed contract, and the
   configured mode is fail_closed.
8. Quota is reserved before LMTP delivery is acknowledged.
9. Temporary LMTP failures go to the retry queue. Exponential retry ends in a
   bounce after the configured maximum attempts.
10. Queue and audit views contain envelope metadata only. They never expose a
    message body, attachment, password, scanner payload, or opaque messageRef.
11. Trash is progressively purged 28 days after the user's deletion action;
    this is a contract owned by the lifecycle boundary, not by a mailbox UI
    timer.

## Running the checks

From git/, install the locked dependencies and run the normal package gates:

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck:server
npm run test:lp3
node scripts/lp3-compose-audit.mjs
~~~

When Docker is available, the complete disposable proof is:

~~~powershell
$env:GULOGULO_LP3_VOLUMES_EXTERNAL = 'false'
node scripts/lp3-compose-smoke.mjs
~~~

The runner creates a unique Compose project from GITHUB_RUN_ID when CI is
available, or from the current timestamp locally. It builds the LP3 images,
starts only the lp3 profile, waits for the TLS service and all four mail
services to be healthy, runs the Python protocol proof and the compiled
TypeScript contract proof, checks the network and mounts, restarts Postfix and
Dovecot, runs both proofs again, and removes the disposable project and
volumes on exit. If a service fails, its last 160 log lines are printed before
cleanup.

On GitHub Actions, the functional Compose proof is deliberately run on the
amd64 runner before the emulated arm64 image pass. The image gate then builds
one OCI tar per LP3 image for `linux/amd64`, followed by one OCI tar per image
for `linux/arm64`. This is intentionally two single-platform artifacts rather
than one multi-platform index: both architecture builds remain mandatory, and
all produced artifacts are attested and verified after the arm64 pass.

The proof client can also be run manually after an operator has started the
services:

~~~powershell
docker compose --project-name gulogulo-lp3-manual --profile lp3 --profile lp3-check --file compose.yaml --env-file .env.example run --rm --no-deps gulogulo-lp3-proof-check
docker compose --project-name gulogulo-lp3-manual --profile lp3 --profile lp3-check --file compose.yaml --env-file .env.example run --rm --no-deps gulogulo-lp3-proof-node
docker compose --project-name gulogulo-lp3-manual --profile lp3 --profile lp3-check --file compose.yaml --env-file .env.example down --volumes --remove-orphans
~~~

The lp3-proof-smoke.mjs defaults are the service names and ports in the
manifest. For a deliberately different local fixture, set
LP3_POSTFIX_HOST, LP3_DOVECOT_HOST, LP3_RSPAMD_HOST, LP3_CLAMAV_HOST, or the
corresponding LP3_*_PORT variable. Do not point these variables at a real
provider from the local-proof workflow.

## How the protocol probe stays safe

The SMTP probe stops at the recipient decision. It does not submit a real
message body and it uses reserved synthetic addresses. It verifies that an
explicit alias is accepted, an unknown internal address is rejected, and an
unauthenticated external relay is not accepted on either inbound or
submission ports.

The IMAPS probe negotiates TLS with the disposable local proof certificate,
asks for CAPABILITY, checks that IDLE is advertised, enters IDLE, leaves it,
logs out, and repeats the sequence on a fresh connection. It checks protocol
continuity, not a fake browser event. The actual typed IMAP IDLE broker test
also checks monotonic event IDs and tenant/user scope.

The Rspamd and ClamAV probes only establish that the local scanner endpoints
are alive (/stat and zPING). The important acceptance decision is in the
typed contracts: missing or malformed scanner responses become explicit
unavailable verdicts and cannot be treated as a clean message.

The proof client imports the compiled server mail modules from
dist/server/src/mail. That is intentional. LP3's source is TypeScript, and
the runtime test must exercise the JavaScript emitted by the server compiler,
not a second hand-written JavaScript implementation. The static audit checks
the source/test boundary and the server tsconfig before the container proof
is allowed to run.

## CI gates

The quality workflow keeps all earlier M0-LP2 gates and adds four LP3 checks:

1. the LP3 static Compose/manifest/TypeScript audit;
2. the strict server typecheck and typed LP3 contract test;
3. multi-architecture Buildx output for every LP3 Ubuntu 26.04 image;
4. the disposable LP3 Compose proof, including restart continuity.

The image builds use linux/amd64 and linux/arm64, --pull, and OCI output.
They are build evidence, not a registry publication. The runtime proof remains
offline and synthetic. A green workflow therefore means "the local mail
boundary is reproducible and its negative decisions are exercised", not "send
mail to the Internet now".

## Troubleshooting notes

If the static audit complains about a missing typed module, first check that
the mail module was moved to src/mail/*.ts, its SPDX header is present, and
tsconfig.server.json includes src/mail/**/*.ts. Generated JavaScript under
dist/ is output and does not replace the source requirement.

If the proof client cannot resolve an lp3-* name, inspect the Compose network
and make sure the proof client uses lp3-runtime; do not fix it by enabling
host networking. If a service has only an IPv4 address, fix the network/IPAM
configuration rather than weakening the dual-stack assertion.

If the relay test returns a 2xx for an external recipient, stop. That is an
open-relay regression, not a flaky test. Check Postfix restrictions and the
submission authentication boundary. If an unknown internal address returns a
2xx, check alias lookup and catch-all configuration.

If a scanner is down, a safe result is a deferred/quarantined message and a
visible health signal. Changing the failure mode to accept is not an LP3 fix;
it violates the product policy.

If a restart loses mailbox or queue state, check the actual named-volume mount
and the external-volume setting. Never put durable mailbox state in the
container writable layer just to make the smoke test pass.

## What remains after LP3

LP3 closes the local mail-stack boundary. It still does not provide the
browser-facing webmail UI, the login artwork layout, full DAV interoperability,
real LDAP-backed login in a browser, production vendor-image sign-off, public
DNS/ACME, Internet mail reputation, provider deployment, or the later
backup/DR and blue/green rehearsals. Those belong to LP4-LP9 and the explicitly
deferred external phase.
