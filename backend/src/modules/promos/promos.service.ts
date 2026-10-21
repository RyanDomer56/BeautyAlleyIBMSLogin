import { isoOrNull, iso } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import { promosRepository, type PromoRow } from "./promos.repository";
import type { Actor } from "../../types/actor";
import type {
  CreatePromoInput,
  ListPromosQuery,
  UpdatePromoInput,
  ValidatePromoInput,
} from "./promos.schemas";

export function toPromoDto(row: PromoRow, liveRedemptions?: number) {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    value: row.value,
    // Optional in the schema: a code with no window is always valid, so null
    // must survive rather than becoming the epoch.
    startsAt: isoOrNull(row.starts_at),
    endsAt: isoOrNull(row.ends_at),
    maxRedemptions: row.max_redemptions,
    perClientLimit: row.per_client_limit,
    minSpendCents: row.min_spend_cents,
    applicableServiceIds: row.applicable_service_ids,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(liveRedemptions !== undefined ? { liveRedemptions } : {}),
  };
}

/**
 * Messages for the reasons the database can return. The API deliberately does
 * not distinguish "no such code" from "expired" in its *status* - both are
 * 200 with `valid: false` - but it does tell the user which it was, because
 * a shopper needs to know whether to retype or give up.
 */
const REASON_MESSAGES: Record<string, string> = {
  OK: "Promo code applied.",
  NOT_FOUND: "That promo code does not exist.",
  INACTIVE: "That promo code is no longer active.",
  NOT_STARTED: "That promo code is not active yet.",
  EXPIRED: "That promo code has expired.",
  MIN_SPEND_NOT_MET: "Your cart is below the minimum spend for that code.",
  NOT_APPLICABLE: "That promo code does not apply to the selected services.",
  LIMIT_REACHED: "That promo code has reached its redemption limit.",
};

export const promosService = {
  /**
   * Validate a code. Always 200 - an invalid code is a normal answer to a
   * question, not an error. Returning 4xx here would force every client to
   * treat a routine "no" as an exception.
   */
  async validate(input: ValidatePromoInput, actor?: Actor) {
    const clientId = actor?.role === "CLIENT" ? actor.clientId : null;

    const result = await promosRepository.validate({
      code: input.code,
      clientId,
      guestPhone: input.guestPhone ?? null,
      serviceIds: input.serviceIds,
      subtotalCents: input.subtotalCents,
    });

    return {
      valid: result.valid,
      reason: result.reason,
      message: REASON_MESSAGES[result.reason] ?? "That promo code cannot be applied.",
      discountCents: result.discountCents ?? 0,
      promoCodeId: result.promoCodeId ?? null,
      code: result.code ?? input.code.toUpperCase(),
      type: result.type ?? null,
      value: result.value ?? null,
    };
  },

  async list(query: ListPromosQuery) {
    const { rows, total } = await promosRepository.list(query);
    return paginated(rows.map((r) => toPromoDto(r)), total, query.page, query.limit);
  },

  async getById(id: string) {
    const row = await promosRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.NOT_FOUND, "No such promo code");
    const live = await promosRepository.redemptionCount(id);
    return toPromoDto(row, live);
  },

  async create(input: CreatePromoInput) {
    const row = await promosRepository.create(input);
    return toPromoDto(row, 0);
  },

  async update(id: string, patch: UpdatePromoInput) {
    await this.getById(id);
    const row = await promosRepository.update(id, patch);
    if (!row) throw AppError.notFound(CODES.NOT_FOUND, "No such promo code");
    const live = await promosRepository.redemptionCount(id);
    return toPromoDto(row, live);
  },

  /**
   * Soft delete. Deactivating rather than deleting keeps existing
   * promo_redemptions rows - and therefore the revenue history - intact. A
   * hard delete would cascade them away.
   */
  async deactivate(id: string) {
    return this.update(id, { isActive: false });
  },
};
