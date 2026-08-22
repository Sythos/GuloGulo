-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
-- Author: Sythos (https://www.sythos.net)

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id text PRIMARY KEY,
  domain text NOT NULL UNIQUE,
  gross_quota_bytes bigint NOT NULL CHECK (gross_quota_bytes > 0),
  master_log_access boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_policies (
  tenant_id text PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  max_users integer NOT NULL DEFAULT 1000 CHECK (max_users > 0),
  max_aliases integer NOT NULL DEFAULT 5000 CHECK (max_aliases >= 0),
  max_message_bytes bigint NOT NULL DEFAULT 52428800 CHECK (max_message_bytes > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_references (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  external_id text NOT NULL,
  mail_address text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, external_id),
  UNIQUE (tenant_id, mail_address)
);

CREATE TABLE IF NOT EXISTS quota_allocations (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  allocated_quota_bytes bigint NOT NULL CHECK (allocated_quota_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_references(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS roles (
  role_id text PRIMARY KEY,
  role_name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS role_bindings (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role_id text NOT NULL REFERENCES roles(role_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_references(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS aliases (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  alias_address text NOT NULL,
  target_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias_address),
  FOREIGN KEY (tenant_id, target_user_id) REFERENCES user_references(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS delegations (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  delegate_user_id text NOT NULL,
  target_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delegate_user_id, target_user_id),
  FOREIGN KEY (tenant_id, delegate_user_id) REFERENCES user_references(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, target_user_id) REFERENCES user_references(tenant_id, user_id) ON DELETE CASCADE,
  CHECK (delegate_user_id <> target_user_id)
);

CREATE TABLE IF NOT EXISTS audit_event_references (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_id text,
  subject_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  PRIMARY KEY (tenant_id, event_id)
);

INSERT INTO roles (role_id, role_name) VALUES
  ('user', 'user'),
  ('tenant_master', 'tenant_master'),
  ('monitor', 'monitor')
ON CONFLICT (role_id) DO NOTHING;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE user_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_references FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE aliases FORCE ROW LEVEL SECURITY;
ALTER TABLE delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_event_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event_references FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_tenant_isolation ON tenants;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS tenant_policies_tenant_isolation ON tenant_policies;
CREATE POLICY tenant_policies_tenant_isolation ON tenant_policies
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS user_references_tenant_isolation ON user_references;
CREATE POLICY user_references_tenant_isolation ON user_references
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS quota_allocations_tenant_isolation ON quota_allocations;
CREATE POLICY quota_allocations_tenant_isolation ON quota_allocations
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS role_bindings_tenant_isolation ON role_bindings;
CREATE POLICY role_bindings_tenant_isolation ON role_bindings
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS aliases_tenant_isolation ON aliases;
CREATE POLICY aliases_tenant_isolation ON aliases
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS delegations_tenant_isolation ON delegations;
CREATE POLICY delegations_tenant_isolation ON delegations
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS audit_event_references_tenant_isolation ON audit_event_references;
CREATE POLICY audit_event_references_tenant_isolation ON audit_event_references
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
