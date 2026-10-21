/**
 * Where the staff console lives.
 *
 * The public site is the booking site: a visitor books, gets a pass, and never
 * sees a door into the console. The console — sign-in, run sheet, records,
 * team — is published on its own origin, so staff arrive there deliberately
 * and the two audiences stop sharing a front door.
 *
 * `VITE_CONSOLE_URL` is that origin. Unset means "same origin, under /app",
 * which is what local development and a single-domain preview need.
 */
const configured = (import.meta.env.VITE_CONSOLE_URL as string | undefined)?.trim();

/** The console origin, or "" when the console shares this origin. */
export const CONSOLE_ORIGIN = configured ? configured.replace(/\/+$/, "") : "";

/** An absolute console URL when a separate origin is configured. */
export function consoleHref(path = "/app"): string {
  return CONSOLE_ORIGIN ? `${CONSOLE_ORIGIN}${path}` : path;
}

/** True on the console's own origin (and everywhere, when it is not split). */
export function onConsoleOrigin(): boolean {
  return !CONSOLE_ORIGIN || window.location.origin === CONSOLE_ORIGIN;
}

/**
 * Where a console request on the *public* origin should go instead.
 *
 * Only `/app/*` is redirected. `/login` stays on both origins on purpose: it
 * is the client's sign-in too (a client books, registers and returns to their
 * bookings on the public site), and a session lives in that origin's storage —
 * forwarding a client to the console's origin would strand the account they
 * just used. Staff sign in on the console's own origin, which is the only door
 * they are given.
 */
export function consoleRedirectTarget(): string | null {
  if (onConsoleOrigin()) return null;
  const { pathname, search, hash } = window.location;
  const isConsoleRoute = pathname === "/app" || pathname.startsWith("/app/");
  return isConsoleRoute ? `${CONSOLE_ORIGIN}${pathname}${search}${hash}` : null;
}
