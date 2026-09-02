// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

// @ts-nocheck

export {
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  PERMISSION_MATRIX,
  assertAdminActor,
  authorize,
  canAuthorize,
  isContentResource,
} from './rbac.ts';
export { createDelegationStore } from './delegation.ts';
export { createQuotaLedger } from './quota.ts';
export { createAdminTools, createAuditStore } from './admin-tools.ts';
