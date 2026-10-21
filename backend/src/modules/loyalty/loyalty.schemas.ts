import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const promoteClientSchema = z.object({
  /**
   * Defaults to 3, the agreed member rate. Kept settable so a goodwill
   * upgrade (a long-standing client, a complaint resolved) does not need a
   * code change - but bounded, because a 90% rate typed by accident is a
   * pricing bug that would silently apply to every future booking.
   */
  discountPercent: z.coerce.number().int().min(1).max(50).default(3),
});

/** Sortable columns of `v_client_loyalty`. Anything else is rejected upstream. */
export const LOYALTY_SORT_COLUMNS = [
  "full_name",
  "phone",
  "completed_visits",
  "member_since",
] as const;

/**
 * Paginated like every other collection, rather than the ad-hoc shape it had.
 *
 * The eligibility filter used to be applied in Node because of a comment
 * claiming PostgREST could not filter a computed view column. That is false:
 * `.eq("eligible_for_membership", true)` returns exactly the eligible rows.
 * What does fail is a *HEAD* count with a filter on a view, which is why the
 * old code never noticed - it had no pagination to test against.
 */
export const listLoyaltyQuerySchema = paginationSchema.extend({
  sort: z.enum(LOYALTY_SORT_COLUMNS).default("full_name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  /** Only clients who have earned the promotion and not yet received it. */
  eligibleOnly: z.coerce.boolean().default(false),
  memberOnly: z.coerce.boolean().default(false),
  q: z.string().trim().max(80).optional(),
});

export const clientIdParamSchema = z.object({ id: z.string().uuid("Not a valid client id") });

export type PromoteClientInput = z.infer<typeof promoteClientSchema>;
export type ListLoyaltyQuery = z.infer<typeof listLoyaltyQuerySchema>;
