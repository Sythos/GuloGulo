// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { createCsrfManager } from './csrf.mjs';
import { createSessionManager } from './session-manager.mjs';

/**
 * Compose the session and CSRF contracts so logout invalidates both kinds of
 * bearer material and stale tokens cannot survive a session revocation.
 */
export function createWebSecurity(options = {}) {
  const sessions = createSessionManager(options);
  const csrf = createCsrfManager({
    ...options,
    isSessionActive: (sessionId) => sessions.getActiveSession(sessionId) !== null,
  });

  return Object.freeze({
    sessions,
    csrf,
    createAuthenticatedSession(identity) {
      const session = sessions.createSession(identity);
      return Object.freeze({ session, setCookie: sessions.serializeSessionCookie(session) });
    },
    authenticate(cookieHeader) {
      return sessions.authenticateCookie(cookieHeader);
    },
    logout(cookieHeader) {
      const result = sessions.logout(cookieHeader);
      if (result.sessionId !== null) {
        csrf.revokeSession(result.sessionId);
      }
      return Object.freeze({
        invalidated: result.invalidated,
        clearCookie: result.clearCookie,
      });
    },
  });
}

export { createCsrfManager } from './csrf.mjs';
export { createSessionManager, DEFAULT_SESSION_COOKIE_NAME, sessionSecurityConstants } from './session-manager.mjs';
export { CSRF_HEADER_NAME, csrfSecurityConstants } from './csrf.mjs';
