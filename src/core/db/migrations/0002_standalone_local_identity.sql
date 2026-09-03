-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
-- Author: Sythos (https://www.sythos.net)

-- DB-backed identity for the standalone target (identity.source = 'database'
-- in src/runtime/config.ts): a per-tenant local user table, used instead of
-- LDAP by src/platform/standalone/db-identity-client.ts. Follows the same
-- tenant-scoped RLS pattern as 0001_m2_foundation.sql.

CREATE TABLE IF NOT EXISTS local_users (
  id uuid NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  username text NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'tenant_master', 'monitor')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, username)
);

ALTER TABLE local_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS local_users_tenant_isolation ON local_users;
CREATE POLICY local_users_tenant_isolation ON local_users
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
