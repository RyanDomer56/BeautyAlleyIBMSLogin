import type { Role } from "../types/actor";

/**
 * Role groups.
 *
 * Named for *who* they are rather than what they can do, so a route reads
 * `requireRole(...DESK)` instead of repeating a list of literals that then has
 * to be kept in sync by hand in twenty files. When the role model changed from
 * `STAFF` to `EMPLOYEE` + `CONCIERGE`, every one of those literals was a place
 * the change could be half-applied - a mistake that shows up as a 403 in
 * production rather than a compile error.
 *
 * These are plain arrays rather than sets: `requireRole(...roles)` spreads
 * them, and there are never enough entries for lookup cost to matter.
 */

/** The owner. Global settings, staff accounts, and the destructive financial records. */
export const OWNER: readonly Role[] = ["ADMIN"];

/**
 * The front desk.
 *
 * Reception, customer records, taking payment and issuing receipts, redeeming
 * loyalty, and moving a treatment to another room. Deliberately *not* an
 * employee: a stylist should not be able to settle someone else's bill.
 */
export const DESK: readonly Role[] = ["CONCIERGE", "ADMIN"];

/**
 * Everyone who works at the branch - the desk plus the service floor.
 *
 * The run sheet, the status machine, aftercare notes, the room board and the
 * door scanner. Reading and progressing work, not configuring it.
 */
export const OPERATIONS: readonly Role[] = ["EMPLOYEE", "CONCIERGE", "ADMIN"];

/** Anyone signed in, whatever their role. */
export const ANYONE: readonly Role[] = ["GUEST", "CLIENT", "EMPLOYEE", "CONCIERGE", "ADMIN"];
