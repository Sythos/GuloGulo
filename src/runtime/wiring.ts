// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createLocalMailClients } from '../platform/contract/platform-adapter.ts';
import type { DavStore, MailClientFactories } from '../platform/contract/platform-adapter.ts';
import { createProductionApiResources } from './api-resources.ts';
import { createRuntimeServer } from './server.ts';

type RuntimeOptions = NonNullable<Parameters<typeof createRuntimeServer>[0]>;

export interface ProductionRuntimeOptions extends RuntimeOptions {
  /** Overrides the IMAP client factory (default: the local mail server from `createLocalMailClients`). Tests inject a fake. */
  createImapClient?: MailClientFactories['createImapClient'];
  davStore?: DavStore;
}

/**
 * The server `src/runtime/index.ts` starts in production: `createRuntimeServer`
 * with the web resource APIs wired to the real IMAP mailbox, the persistent
 * DAV stores and the tenant discovery contract instead of its defaults.
 */
export function createProductionRuntimeServer({ createImapClient, ...options }: ProductionRuntimeOptions = {}) {
  const { config, logger, davStore } = options;
  return createRuntimeServer({
    ...options,
    apiResources: {
      ...createProductionApiResources({
        davStore,
        createImapClient: createImapClient ?? createLocalMailClients(config ?? {}, { logger }).createImapClient,
        discoveryContract: options.discoveryContract ?? config?.discoveryContract,
      }),
      ...options.apiResources,
    },
  });
}
