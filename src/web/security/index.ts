// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createCsrfManager, type CsrfManagerOptions } from './csrf.ts';
import { createSessionManager, type SessionIdentity, type SessionManagerOptions } from './session-manager.ts';

export type WebSecurityOptions = SessionManagerOptions & CsrfManagerOptions;

export function createWebSecurity(options: WebSecurityOptions = {}) {
  const sessions = createSessionManager(options);
  const csrf = createCsrfManager({ ...options, isSessionActive: (sessionId) => sessions.getActiveSession(sessionId) !== null });

  return Object.freeze({
    sessions,
    csrf,
    createAuthenticatedSession(identity: SessionIdentity) {
      const session = sessions.createSession(identity);
      return Object.freeze({ session, setCookie: sessions.serializeSessionCookie(session) });
    },
    authenticate(cookieHeader: unknown) { return sessions.authenticateCookie(cookieHeader); },
    logout(cookieHeader: unknown) {
      const result = sessions.logout(cookieHeader);
      if (result.sessionId !== null) csrf.revokeSession(result.sessionId);
      return Object.freeze({ invalidated: result.invalidated, clearCookie: result.clearCookie });
    },
  });
}

export type WebSecurity = ReturnType<typeof createWebSecurity>;
export { createCsrfManager, CSRF_HEADER_NAME, csrfSecurityConstants } from './csrf.ts';
export { createSessionManager, DEFAULT_SESSION_COOKIE_NAME, sessionSecurityConstants, WebSecurityError } from './session-manager.ts';
export type { CsrfManager, CsrfManagerOptions } from './csrf.ts';
export type { SessionIdentity, SessionManager, SessionManagerOptions, SessionStore, WebSession } from './session-manager.ts';
