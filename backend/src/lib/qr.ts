import crypto from "crypto";
import { env } from "../config/env";

/**
 * QR pass signing.
 *
 * The pass is a compact, signed, URL-safe string:
 *
 *     BA1.<base64url(payload)>.<base64url(hmac)>
 *
 * where payload is `{ jti, bid, exp }`.
 *
 * DESIGN NOTE - what the signature does and does not do.
 *
 * The signature stops a *forged* pass: without the signing secret nobody can
 * mint a string that verifies. It deliberately does NOT make the pass
 * self-authorising. A pass that verifies still has to survive the database
 * check in `check_in_booking()`, which is the authority on whether the `jti`
 * exists, is unrevoked, is unused and is inside its time window.
 *
 * The reason for that division: a signature is a pure function of the secret
 * and the payload, so it cannot be revoked. If a booking is cancelled, the
 * signed string is still mathematically valid. Only the row in `qr_tokens`
 * knows it is dead. So the signature answers "did we issue this?", and the
 * table answers "is it still good?" - which is why `jti` is in the payload
 * even though it is also the row's primary lookup key.
 */

const PREFIX = "BA1";

export interface QrPayload {
  /** Token id - the lookup key into public.qr_tokens. */
  jti: string;
  /** Booking id, carried so the scanner can render context before the round trip. */
  bid: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(body: string): string {
  return crypto.createHmac("sha256", env.qrSigningSecret).update(body).digest("base64url");
}

export function signQrPass(payload: QrPayload): string {
  const body = b64url(JSON.stringify(payload));
  return `${PREFIX}.${body}.${sign(body)}`;
}

export type QrVerification =
  | { ok: true; payload: QrPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

/**
 * Verify structure and signature. Expiry is checked here as a fast, cheap
 * rejection, but the authoritative expiry check is the `expires_at` column -
 * this only avoids a pointless database round trip for an obviously dead pass.
 */
export function verifyQrPass(token: string, now: Date = new Date()): QrVerification {
  if (typeof token !== "string") return { ok: false, reason: "MALFORMED" };

  const parts = token.trim().split(".");
  if (parts.length !== 3) return { ok: false, reason: "MALFORMED" };

  const [prefix, body, signature] = parts;
  if (prefix !== PREFIX || !body || !signature) return { ok: false, reason: "MALFORMED" };

  // Constant-time compare. A length check first is fine - the lengths are
  // fixed by the algorithm, so it leaks nothing - but timingSafeEqual throws
  // on a length mismatch, so it must not be called blind.
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: QrPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as QrPayload;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (
    !payload ||
    typeof payload.jti !== "string" ||
    typeof payload.bid !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, reason: "MALFORMED" };
  }

  if (payload.exp * 1000 <= now.getTime()) return { ok: false, reason: "EXPIRED" };

  return { ok: true, payload };
}

/**
 * The value the client actually encodes into the QR image.
 *
 * It is a URL rather than a bare token so that scanning with a plain phone
 * camera opens something useful instead of showing a meaningless string. The
 * token is a query parameter, so the page can post it to /qr/check-in.
 */
export function toCheckInUrl(pass: string): string {
  return `${env.qrCheckInUrl}?pass=${encodeURIComponent(pass)}`;
}

/**
 * The walk-in DOOR QR - a different sticker from the desk check-in QR.
 *
 * The desk QR redeems an existing pass (`/qr/check-in`); this one starts a
 * registration, so it carries no booking and no expiry. It exists so the
 * server can tell a genuine Beauty Alley door sticker from a URL somebody
 * typed, which is the whole point: without it, `?b=beautyalley-main` in a
 * link would be indistinguishable from the real thing.
 *
 * It is deliberately NOT a bearer credential. Verifying it grants exactly one
 * thing - permission to read the public menu and the membership rules - all of
 * which `GET /services` and `GET /service-subcategories/menu` already serve
 * without any token at all. That is why a static, unrevocable signature is
 * acceptable here and would not be for a booking pass.
 */
const ENTER_PREFIX = "BAW1";

export function signDoorEntry(branchId: string = env.branchId): string {
  const body = b64url(JSON.stringify({ b: branchId }));
  return `${ENTER_PREFIX}.${body}.${sign(body)}`;
}

/** Verify a door token against a branch id, in constant time. */
export function verifyDoorEntry(token: string, branchId: string): boolean {
  if (typeof token !== "string") return false;
  const parts = token.trim().split(".");
  if (parts.length !== 3) return false;

  const [prefix, body, signature] = parts;
  if (prefix !== ENTER_PREFIX || !body || !signature) return false;

  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  // The body must name the branch the caller claims, or a token minted for one
  // branch would open another.
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { b?: string };
    return payload?.b === branchId;
  } catch {
    return false;
  }
}

/** The URL the door QR image encodes. */
export function toDoorEntryUrl(branchId: string = env.branchId): string {
  const token = signDoorEntry(branchId);
  return `${env.qrEnterUrl}?b=${encodeURIComponent(branchId)}&k=${encodeURIComponent(token)}`;
}

/** Exported for tests. */
export const __testing = { PREFIX, ENTER_PREFIX, sign };
