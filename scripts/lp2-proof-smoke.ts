// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client as LdapClient } from 'ldapts';
import pg from 'pg';

const { Client: PostgresClient } = pg;
const tlsDir = process.env.LP2_TLS_DIR || '/run/gulogulo-lp2-tls';
const ca = await readFile(`${tlsDir}/ca.crt`, 'utf8');
const ldapUrl = process.env.LP2_LDAP_URL || 'ldaps://lp2-ldap:636';
const ldapRootDn = process.env.LP2_LDAP_ROOT_DN || 'cn=admin,dc=gulogulo,dc=test';
const ldapRootPassword = process.env.LP2_LDAP_ROOT_PASSWORD || 'lp2-synthetic-root';
const ldapUserBaseDn = process.env.LP2_LDAP_USER_BASE_DN || 'ou=users,dc=gulogulo,dc=test';
const postgresHost = process.env.LP2_POSTGRES_HOST || 'lp2-postgres';
const postgresPort = Number(process.env.LP2_POSTGRES_PORT || 5432);
const postgresDatabase = process.env.LP2_POSTGRES_DB || 'gulogulo';
const postgresUser = process.env.LP2_POSTGRES_USER || 'gulogulo';
const postgresPassword = process.env.LP2_POSTGRES_PASSWORD || 'lp2-synthetic-postgres';

const ldapClient = new LdapClient({
  url: ldapUrl,
  timeout: 5_000,
  connectTimeout: 5_000,
  tlsOptions: {
    ca: [ca],
    rejectUnauthorized: true,
    servername: new URL(ldapUrl).hostname,
  },
});

let ldapEntry;
try {
  await ldapClient.bind(ldapRootDn, ldapRootPassword);
  const result = await ldapClient.search(ldapUserBaseDn, {
    scope: 'sub',
    filter: '(uid=alice)',
    attributes: ['uid', 'mail', 'description'],
  });
  ldapEntry = result.searchEntries.find((entry) => entry.uid === 'alice');
  if (!ldapEntry || ldapEntry.mail !== 'alice@gulogulo.test') {
    throw new Error('LP2 LDAP deterministic fixture is missing or unexpected.');
  }
} finally {
  await ldapClient.unbind().catch(() => undefined);
}

const postgresClient = new PostgresClient({
  host: postgresHost,
  port: postgresPort,
  database: postgresDatabase,
  user: postgresUser,
  password: postgresPassword,
  connectionTimeoutMillis: 5_000,
  ssl: {
    ca,
    rejectUnauthorized: true,
    servername: postgresHost,
  },
});

let postgresResult;
let postgresTls;
try {
  await postgresClient.connect();
  postgresResult = await postgresClient.query(
    "SELECT probe_value FROM lp2_probe WHERE probe_key = 'deterministic'",
  );
  postgresTls = await postgresClient.query(
    'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
  );
  if (postgresResult.rows[0]?.probe_value !== 'lp2-postgres-ready') {
    throw new Error('LP2 PostgreSQL deterministic fixture is missing or unexpected.');
  }
  if (postgresTls.rows[0]?.ssl !== true) {
    throw new Error('LP2 PostgreSQL connection did not negotiate TLS.');
  }
} finally {
  await postgresClient.end().catch(() => undefined);
}

const proofStatePath = process.env.LP2_PROOF_STATE_PATH || '/var/lib/gulogulo/lp2/proof.json';
await mkdir(dirname(proofStatePath), { recursive: true });
await writeFile(proofStatePath, `${JSON.stringify({
  schemaVersion: 1,
  milestone: 'LP2',
  proofType: 'local_synthetic',
  ldap: {
    tlsVerified: true,
    deterministicUser: ldapEntry.uid,
    deterministicMail: ldapEntry.mail,
  },
  postgres: {
    tlsVerified: true,
    deterministicProbe: postgresResult.rows[0].probe_value,
  },
  networkPolicy: 'offline_dependencies',
}, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  milestone: 'LP2',
  proofType: 'local_synthetic',
  networkPolicy: 'offline_dependencies',
  ldap: {
    endpoint: new URL(ldapUrl).hostname,
    tlsVerified: true,
    deterministicFixture: true,
  },
  postgres: {
    endpoint: postgresHost,
    tlsVerified: true,
    deterministicFixture: true,
  },
  hostPortsPublished: false,
  publicDnsRequired: false,
  syntheticDataOnly: true,
  status: 'pass',
}, null, 2));
