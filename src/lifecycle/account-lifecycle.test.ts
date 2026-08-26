// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNT_STATES, createAccountLifecycleStore } from './account-lifecycle.ts';

const scope = { tenantId: 'acme', userId: 'alice' };

test('account deletion has a recoverable 28-day window and purge requires every planned resource', () => {
  let clock = new Date('2026-08-01T00:00:00Z');
  const store = createAccountLifecycleStore({ now: () => clock });
  store.registerAccount({ ...scope, cleanupPlan: ['aliases', 'mailbox'] });
  store.requestDeletion({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-001' });
  store.softDeleteAccount({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-001' });
  const restored = store.restoreAccount({ ...scope, operationId: 'restore-001' });
  assert.equal(restored.account.state, ACCOUNT_STATES.ACTIVE);
  store.requestDeletion({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-002' });
  store.softDeleteAccount({ ...scope, confirmation: 'DELETE:alice', requestId: 'request-002' });
  clock = new Date('2026-08-29T00:00:00Z');
  store.queuePurge({ ...scope, operationId: 'queue-001' });
  assert.throws(() => store.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'purge-incomplete', resourceResults: { aliases: 'purged' } }), (error: unknown) => (error as { code?: string }).code === 'PURGE_INCOMPLETE');
  assert.equal(store.completePurge({ ...scope, confirmation: 'PURGE:alice', operationId: 'purge-001', resourceResults: { aliases: 'purged', mailbox: 'purged' } }).account.state, ACCOUNT_STATES.PURGED);
});

test('account holds, tenant scope and audit do not expose content', () => {
  const store = createAccountLifecycleStore();
  store.registerAccount(scope);
  store.addAccountHold({ ...scope, holdId: 'hold-001', reasonCode: 'legal_hold' });
  assert.throws(() => store.requestDeletion({ ...scope, confirmation: 'DELETE:alice', requestId: 'held-request' }), (error: unknown) => (error as { code?: string }).code === 'ACCOUNT_ON_HOLD');
  assert.equal(store.getAuditEvents({ tenantId: 'other-tenant' }).length, 0);
  for (const event of store.getAuditEvents(scope)) assert.equal(Object.hasOwn(event, 'content'), false);
});
