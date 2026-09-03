-- SPDX-License-Identifier: MIT
-- SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
-- Author: Sythos (https://www.sythos.net)

-- Persistent storage for the CalDAV and CardDAV object contracts
-- (src/core/dav/caldav/caldav-contract.ts, src/core/dav/carddav/carddav-store.ts).
-- The in-memory contracts stay the deterministic pure implementations used by
-- their own tests; this schema backs the separate PostgreSQL adapters
-- (src/core/dav/caldav/postgres-caldav-store.ts,
-- src/core/dav/carddav/postgres-carddav-store.ts) that reuse the contracts'
-- exported ETag/sync-token/validation functions so wire-observable formats
-- never drift between the two implementations. Follows the same tenant-scoped
-- RLS pattern as 0001_m2_foundation.sql/0002_standalone_local_identity.sql.
--
-- The owner/user column is intentionally FK'd to tenants(tenant_id) only, not
-- to user_references: DAV owners resolve through LDAP, a control-panel API,
-- or local_users, none of which guarantee a matching user_references row
-- (0002 makes the same choice for local_users).
--
-- Sync-token revisions are a per-collection counter (dav_calendar_collections
-- .revision / dav_address_books.revision), bumped by an UPDATE ... RETURNING
-- on the collection row so the bump and the change/tombstone row it produces
-- commit atomically under that row's lock. Neither contract ever compares
-- revisions across collections, so a per-collection counter is sufficient.

CREATE TABLE IF NOT EXISTS dav_calendar_collections (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  collection_id text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'UTC',
  color text,
  href text NOT NULL,
  acl_delegate_user_id text,
  acl_permissions text[],
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_user_id, collection_id),
  CHECK (acl_delegate_user_id IS NULL OR acl_delegate_user_id <> owner_user_id),
  CHECK ((acl_delegate_user_id IS NULL) = (acl_permissions IS NULL))
);

-- No UID uniqueness constraint here on purpose: createCalendarObject() in the
-- pure contract never checks UID uniqueness within a calendar collection
-- (unlike CardDAV's dav_contacts below), so this table must not add one.
CREATE TABLE IF NOT EXISTS dav_calendar_objects (
  tenant_id text NOT NULL,
  owner_user_id text NOT NULL,
  collection_id text NOT NULL,
  object_id text NOT NULL,
  uid text NOT NULL,
  etag text NOT NULL,
  ical_data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_user_id, collection_id, object_id),
  FOREIGN KEY (tenant_id, owner_user_id, collection_id)
    REFERENCES dav_calendar_collections(tenant_id, owner_user_id, collection_id) ON DELETE CASCADE
);

-- Changelog/tombstone table backing listCalendarObjects()'s sync-token
-- report: every create/update/delete appends one row here (deleted = true for
-- a tombstone) instead of soft-deleting dav_calendar_objects, matching the
-- in-memory contract's separate `changes` array.
CREATE TABLE IF NOT EXISTS dav_calendar_changes (
  tenant_id text NOT NULL,
  owner_user_id text NOT NULL,
  collection_id text NOT NULL,
  revision bigint NOT NULL,
  object_id text NOT NULL,
  uid text,
  etag text,
  deleted boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_user_id, collection_id, revision),
  FOREIGN KEY (tenant_id, owner_user_id, collection_id)
    REFERENCES dav_calendar_collections(tenant_id, owner_user_id, collection_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dav_address_books (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  address_book_id text NOT NULL,
  href text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  color text,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, address_book_id)
);

-- UID uniqueness IS enforced here, matching CardDavStore#findUid() /
-- VCARD_UID_EXISTS (409): a given address book cannot hold two contacts with
-- the same vCard UID even under different hrefs.
CREATE TABLE IF NOT EXISTS dav_contacts (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  address_book_id text NOT NULL,
  href text NOT NULL,
  uid text NOT NULL,
  full_name text NOT NULL,
  vcard_data text NOT NULL,
  etag text NOT NULL,
  media_type text NOT NULL,
  size_bytes integer NOT NULL,
  -- The address book revision (dav_address_books.revision) at the time this
  -- row was last written, matching the in-memory contract's per-contact
  -- `revision` field used as syncCollection()'s `version` for a full listing.
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, address_book_id, href),
  UNIQUE (tenant_id, user_id, address_book_id, uid),
  FOREIGN KEY (tenant_id, user_id, address_book_id)
    REFERENCES dav_address_books(tenant_id, user_id, address_book_id) ON DELETE CASCADE
);

-- Changelog/tombstone table backing syncCollection(), matching CardDavStore's
-- in-memory `state.changes` array.
CREATE TABLE IF NOT EXISTS dav_contact_changes (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  address_book_id text NOT NULL,
  revision bigint NOT NULL,
  href text NOT NULL,
  uid text,
  etag text,
  operation text NOT NULL CHECK (operation IN ('created', 'updated', 'deleted')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, address_book_id, revision),
  FOREIGN KEY (tenant_id, user_id, address_book_id)
    REFERENCES dav_address_books(tenant_id, user_id, address_book_id) ON DELETE CASCADE
);

ALTER TABLE dav_calendar_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE dav_calendar_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE dav_calendar_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE dav_calendar_objects FORCE ROW LEVEL SECURITY;
ALTER TABLE dav_calendar_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dav_calendar_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE dav_address_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE dav_address_books FORCE ROW LEVEL SECURITY;
ALTER TABLE dav_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dav_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE dav_contact_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE dav_contact_changes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dav_calendar_collections_tenant_isolation ON dav_calendar_collections;
CREATE POLICY dav_calendar_collections_tenant_isolation ON dav_calendar_collections
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS dav_calendar_objects_tenant_isolation ON dav_calendar_objects;
CREATE POLICY dav_calendar_objects_tenant_isolation ON dav_calendar_objects
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS dav_calendar_changes_tenant_isolation ON dav_calendar_changes;
CREATE POLICY dav_calendar_changes_tenant_isolation ON dav_calendar_changes
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS dav_address_books_tenant_isolation ON dav_address_books;
CREATE POLICY dav_address_books_tenant_isolation ON dav_address_books
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS dav_contacts_tenant_isolation ON dav_contacts;
CREATE POLICY dav_contacts_tenant_isolation ON dav_contacts
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
DROP POLICY IF EXISTS dav_contact_changes_tenant_isolation ON dav_contact_changes;
CREATE POLICY dav_contact_changes_tenant_isolation ON dav_contact_changes
  USING (tenant_id = current_setting('gulogulo.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('gulogulo.tenant_id', true));
