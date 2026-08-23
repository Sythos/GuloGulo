# LP1 isolated local topology

<!--
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
-->

LP1 turns the LP0 boundary into a disposable Docker Compose topology. It is a
small, private harness for the first local proof, not the production service
stack. The topology is intentionally limited to the application runtime, a
short-lived local certificate authority, and a reserved-name DNS responder.
LDAP, PostgreSQL, Postfix, Dovecot, Rspamd, ClamAV, CalDAV, and CardDAV remain
later LP milestones.

The machine-readable contract is
[`release/local-proof-topology.json`](../release/local-proof-topology.json).
The static audit is `npm run test:lp1`; the live Docker rehearsal is
`npm run test:lp1:docker`.

## Services and network

The `proof` profile creates three long-running services on the named
`gulogulo-local-proof` network:

| Service | Purpose | Runtime boundary |
|---|---|---|
| `gulogulo-proof` | The existing non-root Gulo Gulo runtime | Published only on `127.0.0.1:18080`; read-only root filesystem; LP1 external-capable named volumes |
| `local-ca` | Disposable seven-day CA and leaf certificate generator | Writes only to `lp1-ca-data`; no host port; synthetic keys are destroyed with the project by default |
| `local-dns` | `dnsmasq` responder on port 5353 | Answers the four reserved names only with `127.0.0.1`; has no upstream resolver and no Internet egress |

The network is declared `internal: true`. The application also receives Docker
network aliases for `gulogulo.test`, `webmail.localhost`,
`calendar.localhost`, and `contacts.localhost`; the proof client queries the
dedicated `local-dns` responder as an independent check.

The `proof-check` profile is on-demand. Its Node.js client installs the CA via
`NODE_EXTRA_CA_CERTS`, verifies the CA/leaf chain and SAN, resolves the reserved
name through the local DNS service, checks `/health/ready`, and persists a
small restart marker. The smoke harness runs that client before and after an
application restart, proving that the marker volume survives replacement.

## Volumes and lifecycle

LP1 uses separate named volumes:

- `lp1-ca-data` — disposable CA and leaf material;
- `lp1-runtime-state` — application runtime and patch state;
- `lp1-mail-data` — reserved mailbox path for later milestones;
- `lp1-dav-data` — reserved DAV path for later milestones;
- `lp1-backup-data` — reserved backup path for later milestones;
- `lp1-proof-state` — the synthetic restart marker used by the proof client.

By default these volumes are project-scoped and removed by the LP1 smoke
harness. Set `GULOGULO_LP1_VOLUMES_EXTERNAL=true` only after an operator has
created and backed up the named volumes independently. The same Compose file
then keeps them across container replacement and future blue/green rehearsal.
The application never receives the Docker socket, host namespaces, or a host
path mount.

## Run the static contract

The static path does not need Docker and is safe to run on Windows, Linux, or
macOS:

```powershell
npm run test:lp1
```

It validates the topology manifest and checks that `compose.yaml` contains the
internal network, proof services, loopback-only binding, labels, named volumes,
and no Docker-socket, host-network, or privileged marker.

## Run the live local proof

Docker Desktop or a Docker Engine with Compose v2 is required:

```powershell
Copy-Item .env.example .env
npm run test:lp1:docker
```

The harness creates a unique project, volume prefix, and network name. It then:

1. validates Compose configuration;
2. builds the application and network utility images with `--pull`;
3. starts the private proof services;
4. waits for application, CA, and DNS health checks;
5. runs the proof client;
6. restarts only the application and runs the proof client again;
7. inspects the network, host binding, labels, mounts, and privilege flags;
8. removes only that project, its networks, and its disposable volumes.

If a step fails, the harness prints the recent application, CA, and DNS logs
before cleanup. The command never targets a broad Docker project name and never
uses `docker system prune`.

## Local certificates and trust

`local-ca` creates:

- `ca.crt`, a disposable CA certificate;
- `gulogulo.test.crt`, a seven-day leaf with SANs for all four reserved names;
- `gulogulo.test.key`, the matching synthetic private key.

The proof client does not publish the key or send it anywhere. It validates the
signature, CA flags, SAN, and a Node TLS context using the CA certificate. LP4
will use the same trust boundary when an HTTPS web/DAV endpoint is added. The
LP1 HTTP health endpoint remains plain HTTP inside the internal network because
there is no reverse proxy in this milestone.

The CA service runs with UID 0 but Gulo Gulo's runtime GID `10001`. Its signing
key remains mode `0600` and is not readable by the proof client. The CA
certificate, leaf certificate, and synthetic leaf key are mode `0640` on the
shared volume and the proof client mounts that volume read-only as the
non-root `gulogulo` user. This keeps the check executable without granting the
application or checker access to the CA signing key.

## Security and non-goals

- Runtime containers have no Internet egress through the internal network.
- No public DNS or ACME challenge is attempted.
- No real email address, credential, mailbox, contact, or calendar object is
  accepted by the topology.
- No external LDAP/PostgreSQL or vendor protocol service is started yet.
- No Docker socket, host network, privileged flag, or arbitrary shell control
  is exposed.
- A green LP1 rehearsal proves topology isolation, health, trust material,
  reserved-name resolution, and volume continuity only. It is not production
  readiness or evidence of a complete mail provider.
