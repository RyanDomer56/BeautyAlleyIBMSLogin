import { z } from "zod";
import { env } from "../../config/env";
import { verifyDoorEntry } from "../../lib/qr";
import { bookingsService } from "../bookings/bookings.service";
import { loyaltyRepository } from "../loyalty/loyalty.repository";
import { subcategoriesService } from "../subcategories/subcategories.service";
import { qrRepository } from "./qr.repository";
import type { Actor } from "../../types/actor";

export const checkInSchema = z.object({
  /**
   * Either the full signed pass ("BA1.<body>.<sig>") or the URL the QR encodes.
   * Accepting both means a scanner that hands back the decoded URL works
   * without the client having to parse it first.
   */
  pass: z.string().trim().min(10, "A check-in pass is required").max(2048),
});

/**
 * The door QR carries `b` (branch) and `k` (its signature). Both are optional
 * in the schema so a caller who opened the plain welcome URL - a bookmark, a
 * shared link - gets a useful menu rather than a 400. What they do NOT get is
 * a verified door badge: `doorVerified` reports which case they are in, and
 * nothing privileged depends on it.
 */
export const doorEntrySchema = z.object({
  b: z.string().trim().min(1).max(64).optional(),
  k: z.string().trim().min(10).max(2048).optional(),
  /** Optional. Turns the welcome screen into "welcome back, Maria". */
  phone: z.string().trim().min(6).max(32).optional(),
});

const BRANCH_NAME = "Beauty Alley";

/**
 * Today's day-of-week in the branch's timezone.
 *
 * `new Date().getDay()` would answer in the *server's* zone, which is UTC on
 * this host - so between 16:00 and midnight Manila the walk-in menu would show
 * the wrong day's hours. Working hours are branch-local wall clock, so the
 * question has to be asked in that zone.
 */
function currentWeekday(timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" });
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const idx = names.indexOf(fmt.format(new Date()));
  if (idx >= 0) return idx;

  // A runtime without full ICU would produce something unexpected. Falling
  // back to the server's day is wrong but survivable; throwing here would take
  // the whole walk-in flow down over an opening-hours nicety.
  return new Date().getDay();
}

export const qrService = {
  /**
   * The desk's own QR code.
   *
   * This is the *static* one printed and mounted at the front desk - it points
   * at the check-in page. The per-booking passes are dynamic and live on
   * /bookings/:id/qr. Keeping the two apart matters: a static image cannot be
   * revoked, so it must never itself authorise anything.
   */
  branch() {
    return {
      label: "Beauty Alley - front desk",
      url: env.qrCheckInUrl,
      checkInWindowMinutes: env.qrCheckinWindowMinutes,
      // Stated explicitly so nobody later mistakes this for an access token.
      authorises: false,
    };
  },

  async checkIn(input: { pass: string }, actor: Actor) {
    // Tolerate a full URL: pull the `pass` query parameter back out if the
    // scanner decoded the QR into a link rather than a raw token.
    let pass = input.pass.trim();
    if (/^https?:\/\//i.test(pass)) {
      try {
        const url = new URL(pass);
        pass = url.searchParams.get("pass") ?? pass;
      } catch {
        /* not a URL after all - fall through and let the verifier reject it */
      }
    }
    return bookingsService.checkIn(pass, actor);
  },

  /**
   * The walk-in entry point - what happens when somebody taps the QR at the
   * door.
   *
   * This is the only public route that both a scanner and a plain link can
   * reach, so it returns everything the registration screen needs in one round
   * trip: who the branch is, whether it is open, the full menu, and the
   * membership rules the client is about to be offered. Sending the client to
   * four more endpoints to assemble a first screen is a bad first impression
   * on salon wifi.
   *
   * It deliberately returns no personal data unless a phone is supplied, and
   * even then only a first name - see `returning` below.
   */
  async enter(input: z.infer<typeof doorEntrySchema>) {
    const branchId = input.b ?? env.branchId;
    const doorVerified = !!input.k && verifyDoorEntry(input.k, branchId);

    // A token that does not verify is not a 401. The visitor has done nothing
    // wrong - they may have opened a stale link - and the menu is public
    // anyway. Reporting `doorVerified: false` lets the app say "open this from
    // the sticker at the door to skip a step" instead of blocking them.
    const weekday = currentWeekday(env.branchTimezone);

    const [hours, menu, services, threshold, returning] = await Promise.all([
      qrRepository.todayHours(weekday, env.branchTimezone),
      subcategoriesService.menu(),
      qrRepository.catalogue(),
      loyaltyRepository.threshold(),
      input.phone ? loyaltyRepository.byPhone(input.phone) : Promise.resolve(null),
    ]);

    return {
      branch: { id: branchId, name: BRANCH_NAME, timezone: env.branchTimezone, today: hours },
      doorVerified,
      flow: "WALK_IN" as const,
      // Named so the client app can render a progress indicator without
      // hardcoding the steps a second time.
      steps: ["identify", "register", "choose-services", "confirm", "room-assigned"] as const,
      menu,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        priceCents: s.price_cents,
        durationMinutes: s.duration_minutes,
        needsRoom: s.required_room_type !== null,
        subcategoryId: s.subcategory_id,
      })),
      membership: {
        visitThreshold: threshold,
        discountPercent: 3,
        // Stated so the UI does not have to infer it from the pricing rules.
        appliesTo: "every booking, on top of any promo code",
      },
      returning: returning
        ? {
            known: true as const,
            // FIRST NAME ONLY. A phone number is guessable, so returning the
            // full name here would turn this endpoint into a way to confirm
            // "is this person a customer of this salon" for any number. A
            // first name is enough for the client to recognise themselves and
            // says nothing useful to anyone else.
            firstName: returning.full_name.split(/\s+/)[0],
            completedVisits: Number(returning.completed_visits),
            isMember: returning.member_since !== null,
            discountPercent: returning.discount_percent,
            eligibleForMembership: returning.eligible_for_membership,
            visitsUntilEligible: Math.max(0, threshold - Number(returning.completed_visits)),
          }
        : null,
    };
  },
};
