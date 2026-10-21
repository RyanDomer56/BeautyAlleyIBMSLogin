/**
 * Session persistence.
 *
 * Deliberately a tiny module rather than inline `localStorage` calls, for two
 * reasons:
 *
 *   - `localStorage` throws in a few real situations (Safari private mode,
 *     a storage quota of zero, a hardened enterprise profile). Every call is
 *     therefore wrapped, and a failure degrades to "you have to sign in again"
 *     rather than a blank screen.
 *   - The key lives in one place, so a future migration to a different store
 *     (or to httpOnly cookies) is a change here and nowhere else.
 *
 * What is stored is the access token, the refresh token and the expiry — the
 * same three things the API hands out. Nothing derived, so there is no stale
 * copy of the profile to go out of sync with the server.
 */

import type { Session } from "@/lib/api-types";

const KEY = "alley.session.v1";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed?.accessToken !== "string" || typeof parsed?.refreshToken !== "string") {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null) {
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — the session simply does not survive a reload */
  }
}

export function clearSession() {
  saveSession(null);
}
