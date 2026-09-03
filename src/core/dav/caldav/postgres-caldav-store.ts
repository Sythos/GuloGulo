// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createPostgresStore } from '../../../integrations/postgres-store.ts';
import { assertTenantContext } from '../../../integrations/tenant-context.ts';
import type {
  IntegrationLogger,
  PostgresClientLike,
  PostgresPoolConstructor,
  PostgresStore,
  PostgresStoreEnabled,
  SecretResolver,
} from '../../../integrations/types.ts';
import {
  CalDavError,
  calDavContract,
  calculateEtag,
  canonicalCalendarKey,
  canonicalUserId,
  canonicalCalendarSlug,
  collectionEtag,
  decodeToken,
  makeToken,
  normalizeActor,
  splitCalendarId,
  validateICalendar,
} from './caldav-contract.ts';

type DavValue = any;
type DavRecord = Record<string, DavValue>;

interface PostgresCalDavStoreOptions {
  readonly config?: unknown;
  readonly resolveSecret?: SecretResolver;
  readonly logger?: IntegrationLogger;
  /** Injectable for tests: overrides the `pg` Pool constructor used by the underlying PostgreSQL store. */
  readonly PoolClass?: PostgresPoolConstructor;
  /** Injectable for tests: overrides how the underlying PostgreSQL store is built. */
  readonly createStore?: (options: DavRecord) => PostgresStore;
}

interface DisabledPostgresCalDavStore {
  readonly enabled: false;
  readonly healthCheck: () => Promise<{ status: 'disabled' }>;
  readonly close: () => Promise<void>;
}

interface EnabledPostgresCalDavStore {
  readonly enabled: true;
  readonly healthCheck: () => Promise<{ status: 'ok' }>;
  readonly close: () => Promise<void>;
  readonly createCalendarCollection: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly listCalendarCollections: (actor: DavValue) => Promise<readonly Readonly<DavRecord>[]>;
  readonly getCalendarCollection: (actor: DavValue, calendarId: DavValue) => Promise<Readonly<DavRecord>>;
  readonly setCalendarAcl: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly revokeCalendarAcl: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly getCalendarEtag: (actor: DavValue, calendarId: DavValue) => Promise<Readonly<DavRecord>>;
  readonly createCalendarObject: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly getCalendarObject: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly updateCalendarObject: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly deleteCalendarObject: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly listCalendarObjects: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
  readonly deleteCalendarCollection: (actor: DavValue, options?: DavRecord) => Promise<Readonly<DavRecord>>;
}

export type PostgresCalDavStore = DisabledPostgresCalDavStore | EnabledPostgresCalDavStore;

function toIso(value: DavValue): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function permissionsForRow(row: DavRecord, actorUserId: string): string[] {
  if (actorUserId === row.owner_user_id) return ['read', 'write'];
  if (row.acl_delegate_user_id === actorUserId) return [...(row.acl_permissions ?? [])];
  return [];
}

function aclForRow(row: DavRecord, actorUserId: string): DavRecord[] {
  if (actorUserId === row.owner_user_id) {
    return row.acl_delegate_user_id ? [{ delegateUserId: row.acl_delegate_user_id, permissions: [...row.acl_permissions] }] : [];
  }
  if (row.acl_delegate_user_id === actorUserId) return [{ delegateUserId: row.owner_user_id, permissions: [...row.acl_permissions] }];
  return [];
}

function publicCollectionRow(row: DavRecord, actor: DavRecord): Readonly<DavRecord> {
  return Object.freeze({
    calendarId: canonicalCalendarKey(row.owner_user_id, row.collection_id),
    collectionId: row.collection_id,
    href: row.href,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    description: row.description,
    timezone: row.timezone,
    color: row.color,
    permissions: Object.freeze(permissionsForRow(row, actor.userId)),
    acl: Object.freeze(aclForRow(row, actor.userId)),
    syncToken: makeToken(row.tenant_id, row.owner_user_id, row.collection_id, Number(row.revision)),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function publicObjectRow(collectionHref: string, objectRow: DavRecord, metadata: DavRecord): Readonly<DavRecord> {
  return Object.freeze({
    href: `${collectionHref}${encodeURIComponent(objectRow.object_id)}`,
    calendarId: canonicalCalendarKey(objectRow.owner_user_id, objectRow.collection_id),
    objectId: objectRow.object_id,
    tenantId: objectRow.tenant_id,
    ownerUserId: objectRow.owner_user_id,
    uid: objectRow.uid,
    etag: objectRow.etag,
    metadata,
    createdAt: toIso(objectRow.created_at),
    updatedAt: toIso(objectRow.updated_at),
    ical: objectRow.ical_data,
  });
}

/**
 * PostgreSQL-backed CalDAV storage adapter.
 *
 * `src/core/dav/caldav/caldav-contract.ts` stays the pure, synchronous,
 * in-memory contract double its own tests exercise — every public method
 * there returns a plain value, never a `Promise`, so it cannot be rewired to
 * a genuinely asynchronous (network I/O) backend without breaking that
 * synchronous public shape and the tests that assert against it directly.
 * This adapter is therefore a separate, async, tenant-scoped implementation
 * of the same operations, backed by the tables in
 * `src/core/db/migrations/0003_dav_storage.sql` instead of a `Map`.
 *
 * To keep the two implementations from silently drifting on anything a real
 * DAV client observes on the wire, this module imports the contract's own
 * exported ETag (`calculateEtag`/`collectionEtag`), sync-token
 * (`makeToken`/`decodeToken`), and scope/id validation
 * (`normalizeActor`/`canonicalUserId`/`canonicalCalendarSlug`/
 * `canonicalCalendarKey`/`splitCalendarId`) functions rather than
 * reimplementing them — an ETag or sync token computed here is
 * byte-for-byte identical to what the in-memory contract would compute for
 * the same tenant/collection/object/content.
 *
 * Reuses `createPostgresStore()` (`src/integrations/postgres-store.ts`) for
 * the connection pool, retry, SSL, and RLS transaction plumbing, the same
 * way `src/platform/standalone/db-identity-client.ts` does:
 * `withTenantTransaction()` sets the `gulogulo.tenant_id` RLS context per
 * request.
 *
 * Sync-token revisions are a per-collection counter
 * (`dav_calendar_collections.revision`), bumped with
 * `UPDATE ... RETURNING` on the collection row so the bump and the resulting
 * change/tombstone row commit under that row's lock — see the migration's
 * header comment for why a per-collection counter is safe here even though
 * the in-memory contract uses one global-per-tenant-store counter.
 */
export function createPostgresCalDavStore({
  config,
  resolveSecret,
  logger = console,
  PoolClass,
  createStore = createPostgresStore,
}: PostgresCalDavStoreOptions = {}): PostgresCalDavStore {
  const store = createStore({
    config,
    resolveSecret,
    logger,
    ...(PoolClass === undefined ? {} : { PoolClass }),
  });

  if (!store.enabled) {
    return Object.freeze({
      enabled: false as const,
      healthCheck: async () => ({ status: 'disabled' as const }),
      close: async () => {},
    });
  }
  const enabledStore: PostgresStoreEnabled = store;

  function normalizeCalDavActor(actorInput: DavValue): DavRecord {
    const tenantId = actorInput !== null && typeof actorInput === 'object' ? actorInput.tenantId : undefined;
    const normalized = normalizeActor(actorInput, tenantId);
    const domain = typeof actorInput?.domain === 'string' ? actorInput.domain : undefined;
    return { ...normalized, domain };
  }

  function buildTenantContext(actor: DavRecord): DavValue {
    try {
      return assertTenantContext({ tenantId: actor.tenantId, domain: actor.domain, actorId: actor.userId, role: actor.role });
    } catch {
      throw new CalDavError('a valid domain is required for the PostgreSQL-backed CalDAV store', 'INVALID_DOMAIN', 422);
    }
  }

  async function resolveCollectionRow(client: PostgresClientLike, actor: DavRecord, requestedCalendarId: DavValue, { forUpdate = false, requirePermission = 'read' }: DavRecord = {}): Promise<DavRecord> {
    const { ownerUserId, collectionId } = splitCalendarId(requestedCalendarId);
    let row: DavRecord | undefined;
    if (ownerUserId !== null) {
      const result = await client.query<DavRecord>(
        `SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3${forUpdate ? ' FOR UPDATE' : ''}`,
        [actor.tenantId, ownerUserId, collectionId],
      );
      row = result.rows[0];
    } else {
      const result = await client.query<DavRecord>(
        'SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND collection_id = $2 AND (owner_user_id = $3 OR acl_delegate_user_id = $3)',
        [actor.tenantId, collectionId, actor.userId],
      );
      if (result.rows.length > 1) throw new CalDavError('calendarId is ambiguous; use ownerUserId/calendarId', 'AMBIGUOUS_CALENDAR_ID', 409);
      row = result.rows[0];
      if (row && forUpdate) {
        const locked = await client.query<DavRecord>(
          'SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 FOR UPDATE',
          [actor.tenantId, row.owner_user_id, row.collection_id],
        );
        row = locked.rows[0];
      }
    }
    if (!row) throw new CalDavError('calendar collection was not found', 'CALENDAR_NOT_FOUND', 404);
    const permissions = new Set(permissionsForRow(row, actor.userId));
    if (!permissions.has(requirePermission)) throw new CalDavError(`actor is not allowed to ${requirePermission} this calendar`, 'ACL_DENIED', 403);
    return row;
  }

  async function bumpRevision(client: PostgresClientLike, tenantId: string, ownerUserId: string, collectionId: string, { objectId, uid = null, etag = null, deleted }: DavRecord): Promise<number> {
    const updated = await client.query<DavRecord>(
      'UPDATE dav_calendar_collections SET revision = revision + 1, updated_at = now() WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 RETURNING revision',
      [tenantId, ownerUserId, collectionId],
    );
    const revision = Number(updated.rows[0].revision);
    await client.query(
      'INSERT INTO dav_calendar_changes (tenant_id, owner_user_id, collection_id, revision, object_id, uid, etag, deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [tenantId, ownerUserId, collectionId, revision, objectId, uid, etag, deleted],
    );
    return revision;
  }

  async function createCalendarCollection(actorInput: DavValue, {
    collectionId = 'default',
    ownerUserId = actorInput?.userId ?? actorInput?.actorId,
    displayName = collectionId,
    description = '',
    timezone = 'UTC',
    color = null,
  }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const owner = canonicalUserId(ownerUserId, 'ownerUserId');
    if (owner !== actor.userId) throw new CalDavError('an actor can create only its own calendar collection', 'ACL_DENIED', 403);
    const slug = canonicalCalendarSlug(collectionId, 'collectionId');
    if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 255) throw new CalDavError('displayName is invalid', 'INVALID_COLLECTION', 422);
    if (typeof description !== 'string' || description.length > 2_000) throw new CalDavError('description is invalid', 'INVALID_COLLECTION', 422);
    if (typeof timezone !== 'string' || !calDavContract.tzidPattern.test(timezone)) throw new CalDavError('timezone is invalid', 'INVALID_TIMEZONE', 422);
    if (color !== null && (typeof color !== 'string' || !calDavContract.colorPattern.test(color))) throw new CalDavError('color is invalid', 'INVALID_COLLECTION', 422);
    const href = `/dav/calendars/${encodeURIComponent(actor.tenantId)}/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/`;
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const existing = await client.query('SELECT 1 FROM dav_calendar_collections WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3', [actor.tenantId, owner, slug]);
      if ((existing.rowCount ?? 0) > 0) throw new CalDavError('calendar collection already exists', 'CALENDAR_EXISTS', 409);
      const inserted = await client.query<DavRecord>(
        `INSERT INTO dav_calendar_collections (tenant_id, owner_user_id, collection_id, display_name, description, timezone, color, href)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [actor.tenantId, owner, slug, displayName.trim(), description, timezone, color === null ? null : String(color).toUpperCase(), href],
      );
      return publicCollectionRow(inserted.rows[0], actor);
    });
  }

  async function listCalendarCollections(actorInput: DavValue): Promise<readonly Readonly<DavRecord>[]> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const result = await client.query<DavRecord>(
        'SELECT * FROM dav_calendar_collections WHERE tenant_id = $1 AND (owner_user_id = $2 OR acl_delegate_user_id = $2) ORDER BY owner_user_id, collection_id',
        [actor.tenantId, actor.userId],
      );
      return Object.freeze(result.rows.map((row) => publicCollectionRow(row, actor)));
    });
  }

  async function getCalendarCollection(actorInput: DavValue, requestedCalendarId: DavValue): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, requestedCalendarId);
      return publicCollectionRow(row, actor);
    });
  }

  async function setCalendarAcl(actorInput: DavValue, { calendarId, delegateUserId, permissions = ['read'] }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId, { forUpdate: true });
      if (actor.userId !== row.owner_user_id) throw new CalDavError('only the calendar owner may change its ACL', 'ACL_OWNER_REQUIRED', 403);
      const delegate = canonicalUserId(delegateUserId, 'delegateUserId');
      if (delegate === row.owner_user_id) throw new CalDavError('a calendar cannot delegate to itself', 'INVALID_ACL', 422);
      if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some((permission: DavValue) => !calDavContract.aclPermissions.includes(permission))) {
        throw new CalDavError('permissions must contain read and/or write', 'INVALID_ACL', 422);
      }
      const unique = [...new Set(permissions)] as string[];
      if (unique.includes('write') && !unique.includes('read')) unique.unshift('read');
      const updated = await client.query<DavRecord>(
        'UPDATE dav_calendar_collections SET acl_delegate_user_id = $1, acl_permissions = $2, updated_at = now() WHERE tenant_id = $3 AND owner_user_id = $4 AND collection_id = $5 RETURNING *',
        [delegate, unique, actor.tenantId, row.owner_user_id, row.collection_id],
      );
      return publicCollectionRow(updated.rows[0], actor);
    });
  }

  async function revokeCalendarAcl(actorInput: DavValue, { calendarId }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId, { forUpdate: true });
      if (actor.userId !== row.owner_user_id) throw new CalDavError('only the calendar owner may change its ACL', 'ACL_OWNER_REQUIRED', 403);
      const updated = await client.query<DavRecord>(
        'UPDATE dav_calendar_collections SET acl_delegate_user_id = NULL, acl_permissions = NULL, updated_at = now() WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 RETURNING *',
        [actor.tenantId, row.owner_user_id, row.collection_id],
      );
      return publicCollectionRow(updated.rows[0], actor);
    });
  }

  async function getCalendarEtag(actorInput: DavValue, requestedCalendarId: DavValue): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, requestedCalendarId);
      return Object.freeze({
        calendarId: canonicalCalendarKey(row.owner_user_id, row.collection_id),
        etag: collectionEtag({ displayName: row.display_name, description: row.description, updatedAt: toIso(row.updated_at) }),
        actor: actor.userId,
      });
    });
  }

  async function createCalendarObject(actorInput: DavValue, { calendarId, objectId, ical, ifNoneMatch }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId, { forUpdate: true, requirePermission: 'write' });
      const id = canonicalCalendarSlug(objectId, 'objectId');
      const existing = await client.query(
        'SELECT 1 FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4',
        [actor.tenantId, row.owner_user_id, row.collection_id, id],
      );
      if ((existing.rowCount ?? 0) > 0) {
        if (ifNoneMatch === '*') throw new CalDavError('calendar object already exists', 'PRECONDITION_FAILED', 412);
        throw new CalDavError('calendar object already exists', 'OBJECT_EXISTS', 409);
      }
      if (ifNoneMatch !== undefined && ifNoneMatch !== '*') throw new CalDavError('If-None-Match must be * for a conditional create', 'INVALID_PRECONDITION', 400);
      const metadata = validateICalendar(ical);
      const calendarKey = canonicalCalendarKey(row.owner_user_id, row.collection_id);
      const etag = calculateEtag({ tenantId: actor.tenantId, calendarKey, objectId: id, canonicalText: metadata.canonicalText });
      const inserted = await client.query<DavRecord>(
        'INSERT INTO dav_calendar_objects (tenant_id, owner_user_id, collection_id, object_id, uid, etag, ical_data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [actor.tenantId, row.owner_user_id, row.collection_id, id, metadata.uid, etag, metadata.canonicalText],
      );
      await bumpRevision(client, actor.tenantId, row.owner_user_id, row.collection_id, { objectId: id, uid: metadata.uid, etag, deleted: false });
      return publicObjectRow(row.href, inserted.rows[0], metadata);
    });
  }

  async function getCalendarObject(actorInput: DavValue, { calendarId, objectId }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId);
      const id = canonicalCalendarSlug(objectId, 'objectId');
      const result = await client.query<DavRecord>(
        'SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4',
        [actor.tenantId, row.owner_user_id, row.collection_id, id],
      );
      const objectRow = result.rows[0];
      if (!objectRow) throw new CalDavError('calendar object was not found', 'OBJECT_NOT_FOUND', 404);
      return publicObjectRow(row.href, objectRow, validateICalendar(objectRow.ical_data));
    });
  }

  async function updateCalendarObject(actorInput: DavValue, { calendarId, objectId, ical, ifMatch }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId, { forUpdate: true, requirePermission: 'write' });
      const id = canonicalCalendarSlug(objectId, 'objectId');
      const existingResult = await client.query<DavRecord>(
        'SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4 FOR UPDATE',
        [actor.tenantId, row.owner_user_id, row.collection_id, id],
      );
      const existing = existingResult.rows[0];
      if (!existing) throw new CalDavError('calendar object was not found', 'OBJECT_NOT_FOUND', 404);
      if (ifMatch === undefined) throw new CalDavError('If-Match is required for update', 'PRECONDITION_REQUIRED', 428);
      if (ifMatch !== '*' && ifMatch !== existing.etag) throw new CalDavError('If-Match does not match the current ETag', 'PRECONDITION_FAILED', 412);
      const metadata = validateICalendar(ical);
      if (metadata.uid !== existing.uid) throw new CalDavError('UID cannot change during an update', 'UID_IMMUTABLE', 409);
      const calendarKey = canonicalCalendarKey(row.owner_user_id, row.collection_id);
      const etag = calculateEtag({ tenantId: actor.tenantId, calendarKey, objectId: id, canonicalText: metadata.canonicalText });
      const updated = await client.query<DavRecord>(
        'UPDATE dav_calendar_objects SET etag = $1, ical_data = $2, updated_at = now() WHERE tenant_id = $3 AND owner_user_id = $4 AND collection_id = $5 AND object_id = $6 RETURNING *',
        [etag, metadata.canonicalText, actor.tenantId, row.owner_user_id, row.collection_id, id],
      );
      await bumpRevision(client, actor.tenantId, row.owner_user_id, row.collection_id, { objectId: id, uid: metadata.uid, etag, deleted: false });
      return publicObjectRow(row.href, updated.rows[0], metadata);
    });
  }

  async function deleteCalendarObject(actorInput: DavValue, { calendarId, objectId, ifMatch }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId, { forUpdate: true, requirePermission: 'write' });
      const id = canonicalCalendarSlug(objectId, 'objectId');
      const existingResult = await client.query<DavRecord>(
        'SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4 FOR UPDATE',
        [actor.tenantId, row.owner_user_id, row.collection_id, id],
      );
      const existing = existingResult.rows[0];
      if (!existing) throw new CalDavError('calendar object was not found', 'OBJECT_NOT_FOUND', 404);
      if (ifMatch === undefined) throw new CalDavError('If-Match is required for delete', 'PRECONDITION_REQUIRED', 428);
      if (ifMatch !== '*' && ifMatch !== existing.etag) throw new CalDavError('If-Match does not match the current ETag', 'PRECONDITION_FAILED', 412);
      await client.query(
        'DELETE FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4',
        [actor.tenantId, row.owner_user_id, row.collection_id, id],
      );
      const revision = await bumpRevision(client, actor.tenantId, row.owner_user_id, row.collection_id, { objectId: id, uid: existing.uid, etag: null, deleted: true });
      return Object.freeze({
        deleted: true,
        calendarId: canonicalCalendarKey(row.owner_user_id, row.collection_id),
        objectId: id,
        previousEtag: existing.etag,
        syncToken: makeToken(actor.tenantId, row.owner_user_id, row.collection_id, revision),
      });
    });
  }

  async function listCalendarObjects(actorInput: DavValue, { calendarId, syncToken }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId);
      const currentRevision = Number(row.revision);
      const since = decodeToken(syncToken, { tenantId: actor.tenantId, ownerUserId: row.owner_user_id, collectionId: row.collection_id });
      if (since > currentRevision) throw new CalDavError('syncToken is from the future', 'INVALID_SYNC_TOKEN', 400);
      const objects: DavRecord[] = [];
      const deletedObjectIds: string[] = [];
      if (syncToken === undefined || syncToken === null) {
        const result = await client.query<DavRecord>(
          'SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 ORDER BY object_id',
          [actor.tenantId, row.owner_user_id, row.collection_id],
        );
        for (const objectRow of result.rows) objects.push(publicObjectRow(row.href, objectRow, validateICalendar(objectRow.ical_data)));
      } else {
        const changes = await client.query<DavRecord>(
          'SELECT * FROM dav_calendar_changes WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND revision > $4 ORDER BY revision',
          [actor.tenantId, row.owner_user_id, row.collection_id, since],
        );
        const latestByObject = new Map<string, DavRecord>();
        for (const change of changes.rows) latestByObject.set(change.object_id, change);
        for (const [objectId, change] of latestByObject) {
          if (change.deleted) {
            deletedObjectIds.push(objectId);
            continue;
          }
          const current = await client.query<DavRecord>(
            'SELECT * FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3 AND object_id = $4',
            [actor.tenantId, row.owner_user_id, row.collection_id, objectId],
          );
          const objectRow = current.rows[0];
          if (objectRow) objects.push(publicObjectRow(row.href, objectRow, validateICalendar(objectRow.ical_data)));
          else deletedObjectIds.push(objectId);
        }
      }
      return Object.freeze({
        calendarId: canonicalCalendarKey(row.owner_user_id, row.collection_id),
        objects: Object.freeze(objects),
        deletedObjectIds: Object.freeze(deletedObjectIds),
        syncToken: makeToken(actor.tenantId, row.owner_user_id, row.collection_id, currentRevision),
      });
    });
  }

  async function deleteCalendarCollection(actorInput: DavValue, { calendarId, ifMatch }: DavRecord = {}): Promise<Readonly<DavRecord>> {
    const actor = normalizeCalDavActor(actorInput);
    const context = buildTenantContext(actor);
    return enabledStore.withTenantTransaction(context, async (client) => {
      const row = await resolveCollectionRow(client, actor, calendarId, { forUpdate: true });
      if (actor.userId !== row.owner_user_id) throw new CalDavError('only the calendar owner may delete a collection', 'ACL_OWNER_REQUIRED', 403);
      const countResult = await client.query<DavRecord>(
        'SELECT COUNT(*)::int AS count FROM dav_calendar_objects WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3',
        [actor.tenantId, row.owner_user_id, row.collection_id],
      );
      if ((countResult.rows[0]?.count ?? 0) > 0) throw new CalDavError('calendar collection is not empty', 'CALENDAR_NOT_EMPTY', 409);
      const currentEtag = collectionEtag({ displayName: row.display_name, description: row.description, updatedAt: toIso(row.updated_at) });
      if (ifMatch !== undefined && ifMatch !== '*' && ifMatch !== currentEtag) throw new CalDavError('If-Match does not match the collection ETag', 'PRECONDITION_FAILED', 412);
      await client.query(
        'DELETE FROM dav_calendar_collections WHERE tenant_id = $1 AND owner_user_id = $2 AND collection_id = $3',
        [actor.tenantId, row.owner_user_id, row.collection_id],
      );
      return Object.freeze({ deleted: true, calendarId: canonicalCalendarKey(row.owner_user_id, row.collection_id) });
    });
  }

  const enabledClient: EnabledPostgresCalDavStore = {
    enabled: true,
    healthCheck: async () => enabledStore.healthCheck(),
    close: () => enabledStore.close(),
    createCalendarCollection,
    listCalendarCollections,
    getCalendarCollection,
    setCalendarAcl,
    revokeCalendarAcl,
    getCalendarEtag,
    createCalendarObject,
    getCalendarObject,
    updateCalendarObject,
    deleteCalendarObject,
    listCalendarObjects,
    deleteCalendarCollection,
  };
  return Object.freeze(enabledClient);
}
