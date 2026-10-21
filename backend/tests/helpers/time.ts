/**
 * Slot arithmetic for the booking tests.
 *
 * The branch runs on Asia/Manila (UTC+8, no DST), and the seed gives every
 * stylist Monday-Saturday 09:00-18:00 local. So a test slot has to be a future
 * open day between 01:00 and 10:00 UTC.
 *
 * Getting this wrong is the classic flaky-test trap: a test that computes
 * "tomorrow at 10am UTC" passes Monday to Friday and fails at the weekend, or
 * passes until it happens to land on a Sunday. These helpers only ever return
 * a slot that is known to be inside a shift.
 *
 * There are two independent traps, and both have bitten this suite:
 *
 *   1. a slot landing on a closed day - handled by walking to open days;
 *   2. two different offsets landing on the *same* day, because the walk in
 *      (1) skipped forward past a Sunday. `nextWorkingSlot` therefore counts
 *      open days rather than calendar days, which makes it strictly
 *      increasing. See its own note.
 */

const MANILA_OFFSET_HOURS = 8;

/**
 * Day-offset bands, one per integration suite.
 *
 * Every suite talks to the *same* database, but Jest gives each test file its
 * own module registry, so module-level state cannot be shared between them. Two
 * suites that both compute "in 4 days at 10:00" therefore compete for the same
 * physical slot, and the second booking comes back 409 SLOT_TAKEN - a failure
 * with nothing to do with what that test was actually checking.
 *
 * Each suite calls `useSlotBand` once with its own band, and every offset it
 * asks for is shifted by that amount, so the slots are disjoint by
 * construction. Bands are 40 days apart with 20 days of headroom, which leaves
 * room for a suite to grow without spilling into its neighbour. A band only
 * ever moves slots *further* into the future, so the "is this in the past?"
 * checks are unaffected.
 */
export const SLOT_BANDS = {
  bookings: 0,
  promos: 40,
  qr: 80,
  admin: 120,
  references: 160,
} as const;

let slotBand = 0;

/**
 * Reserve a band of day-offsets for the current suite. Call once at the top of
 * a test file, before any call to `nextWorkingSlot`.
 */
export function useSlotBand(band: number): void {
  slotBand = band;
}

/** The UTC instant corresponding to a Manila wall-clock time on a given date. */
function manilaToUtc(date: Date, hours: number, minutes = 0): Date {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hours, minutes, 0, 0)
  );
  utc.setUTCHours(utc.getUTCHours() - MANILA_OFFSET_HOURS);
  return utc;
}

/**
 * A future instant that is inside working hours.
 *
 * `daysAhead` counts **open days**, not calendar days: 1 is the next day the
 * salon is open, 2 the one after that, and so on. That distinction is the whole
 * point of the function.
 *
 * The earlier version added `daysAhead` calendar days and then walked forward
 * if the result landed on a Sunday. That silently collapses two offsets onto
 * the same date: `nextWorkingSlot(5, 10)` and `nextWorkingSlot(6, 10)` both
 * returned Monday whenever day 5 was a Sunday. Two tests in the same suite that
 * book the same stylist at those offsets then collide, and the second one fails
 * with a 409 SLOT_TAKEN that says nothing about what it was checking - on
 * Tuesdays, and only on Tuesdays.
 *
 * Counting open days makes the mapping strictly increasing, so distinct offsets
 * always produce distinct dates.
 */
export function nextWorkingSlot(daysAhead = 3, manilaHour = 10): Date {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  // The band is applied in calendar days, before the open-day walk. Bands are
  // 40 apart and no suite asks for more than ~20 open days, so the walks cannot
  // reach into a neighbouring band.
  base.setUTCDate(base.getUTCDate() + slotBand);

  const cursor = new Date(base.getTime());
  let remaining = daysAhead;

  // 400 iterations is ~57 open days - far beyond any offset a suite uses, and a
  // hard stop so a mistake here fails loudly instead of spinning.
  for (let i = 0; i < 400; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // Manila weekday of this calendar date; Sunday (0) is closed.
    if (new Date(cursor.getTime() + MANILA_OFFSET_HOURS * 3_600_000).getUTCDay() === 0) continue;
    remaining -= 1;
    if (remaining === 0) return manilaToUtc(cursor, manilaHour);
  }

  throw new Error(`could not find open day ${daysAhead} in the next 400 days`);
}

/** A distinct slot on the same day, `hours` later. */
export function shiftHours(slot: Date, hours: number): Date {
  return new Date(slot.getTime() + hours * 3_600_000);
}

/** An instant safely in the past, for the "cannot book backwards" test. */
export function pastSlot(hoursAgo = 24): Date {
  return new Date(Date.now() - hoursAgo * 3_600_000);
}

/**
 * A slot only just inside the cancellation window boundary.
 *
 * `cancel_booking` refuses when `start_time - now() < window`. To test the
 * refusal, the booking must start sooner than the window; to test the
 * allowance, later.
 */
export function slotWithinMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

export const ISO = (d: Date) => d.toISOString();
