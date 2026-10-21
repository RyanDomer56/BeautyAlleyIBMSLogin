import { isoOrNull } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import { loyaltyRepository } from "./loyalty.repository";
import type { ListLoyaltyQuery, PromoteClientInput } from "./loyalty.schemas";
import type { Database } from "../../types/database";

type LoyaltyRow = Database["public"]["Views"]["v_client_loyalty"]["Row"];

/**
 * Row -> wire shape.
 *
 * `visitsUntilEligible` is computed here rather than returned by the view.
 * The view cannot know the threshold at row level without a correlated
 * subquery per row, and the front desk only ever asks the question for one
 * client at a time - so it is cheaper, and clearer, to derive it once.
 */
export function toLoyaltyDto(row: LoyaltyRow, threshold: number) {
  const visits = Number(row.completed_visits);
  return {
    clientId: row.client_id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    memberSince: isoOrNull(row.member_since),
    discountPercent: row.discount_percent,
    completedVisits: visits,
    isMember: row.member_since !== null,
    eligibleForMembership: row.eligible_for_membership,
    threshold,
    visitsUntilEligible: Math.max(0, threshold - visits),
  };
}

export const loyaltyService = {
  async forClient(clientId: string) {
    const [row, threshold] = await Promise.all([
      loyaltyRepository.byClientId(clientId),
      loyaltyRepository.threshold(),
    ]);
    if (!row) throw AppError.notFound(CODES.CLIENT_NOT_FOUND, "No such client");
    return toLoyaltyDto(row, threshold);
  },

  async forPhone(phone: string) {
    const [row, threshold] = await Promise.all([
      loyaltyRepository.byPhone(phone),
      loyaltyRepository.threshold(),
    ]);
    return row ? toLoyaltyDto(row, threshold) : null;
  },

  async list(query: ListLoyaltyQuery) {
    const [result, threshold] = await Promise.all([
      loyaltyRepository.list({
        eligibleOnly: query.eligibleOnly,
        memberOnly: query.memberOnly,
        q: query.q,
        pagination: query,
      }),
      loyaltyRepository.threshold(),
    ]);
    // `threshold` travels with the page because the desk needs it to render
    // "2 more visits to earn 3%" on every row, and a second round trip per
    // page load to learn a value that changes once a year is not worth it.
    const page = paginated(
      result.rows.map((r) => toLoyaltyDto(r, threshold)),
      result.total,
      query.page,
      query.limit
    );
    return { ...page, meta: { ...page.meta, threshold } };
  },

  async promote(clientId: string, input: PromoteClientInput, actorId: string | null) {
    const result = await loyaltyRepository.promote(clientId, input.discountPercent, actorId);
    // Re-read rather than echoing the RPC: the row is the truth, and this also
    // confirms the update actually landed.
    return this.forClient(result.clientId);
  },

  async revoke(clientId: string, actorId: string | null) {
    await loyaltyRepository.revoke(clientId, actorId);
    return this.forClient(clientId);
  },
};
