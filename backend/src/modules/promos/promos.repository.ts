import { requireServiceRole, supabasePublic } from "../../db/supabase";
import { toRange } from "../../lib/pagination";
import type { Database } from "../../types/database";
import type { CreatePromoInput, ListPromosQuery, UpdatePromoInput } from "./promos.schemas";

export interface PromoRow {
  id: string;
  code: string;
  type: "PERCENT" | "FIXED";
  value: number;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  per_client_limit: number | null;
  min_spend_cents: number;
  applicable_service_ids: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT =
  "id, code, type, value, starts_at, ends_at, max_redemptions, per_client_limit, min_spend_cents, applicable_service_ids, is_active, created_at, updated_at" as const;

type PromoUpdate = Database["public"]["Tables"]["promo_codes"]["Update"];

export const promosRepository = {
  /**
   * Validate a code. Delegates entirely to the database function so the
   * preview a client sees in the cart is computed by exactly the same code
   * path that will apply the discount at booking time. A re-implementation in
   * TypeScript would drift.
   */
  async validate(opts: {
    code: string;
    clientId: string | null;
    guestPhone: string | null;
    serviceIds: string[];
    subtotalCents: number;
  }) {
    // Public. `validate_promo` is the other function migration 14 re-grants to
    // anon, so a signed-out visitor can preview a code in the cart.
    const { data, error } = await supabasePublic.rpc("validate_promo", {
      p_code: opts.code,
      p_client_id: opts.clientId,
      p_guest_phone: opts.guestPhone,
      p_service_ids: opts.serviceIds,
      p_subtotal_cents: opts.subtotalCents,
    });
    if (error) throw error;
    return data;
  },

  async list(query: ListPromosQuery): Promise<{ rows: PromoRow[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(query);

    let q = db.from("promo_codes").select(SELECT, { count: "exact" });
    if (query.activeOnly) q = q.eq("is_active", true);
    if (query.q) {
      const safe = query.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      q = q.ilike("code", `%${safe}%`);
    }

    const { data, error, count } = await q
      .order(query.sort, { ascending: query.order === "asc" })
      .range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as PromoRow[], total: count ?? 0 };
  },

  async getById(id: string): Promise<PromoRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db.from("promo_codes").select(SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as PromoRow) ?? null;
  },

  async create(input: CreatePromoInput): Promise<PromoRow> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("promo_codes")
      .insert({
        // citext makes the stored value case-insensitive, but normalising on
        // write keeps the data readable.
        code: input.code.toUpperCase(),
        type: input.type,
        value: input.value,
        starts_at: input.startsAt ?? null,
        ends_at: input.endsAt ?? null,
        max_redemptions: input.maxRedemptions ?? null,
        per_client_limit: input.perClientLimit ?? null,
        min_spend_cents: input.minSpendCents,
        applicable_service_ids: input.applicableServiceIds ?? null,
        is_active: input.isActive,
      })
      .select(SELECT)
      .single();
    if (error) throw error;
    return data as PromoRow;
  },

  async update(id: string, patch: UpdatePromoInput): Promise<PromoRow | null> {
    const db = requireServiceRole();
    const row: PromoUpdate = {};
    if (patch.type !== undefined) row.type = patch.type;
    if (patch.value !== undefined) row.value = patch.value;
    if (patch.startsAt !== undefined) row.starts_at = patch.startsAt;
    if (patch.endsAt !== undefined) row.ends_at = patch.endsAt;
    if (patch.maxRedemptions !== undefined) row.max_redemptions = patch.maxRedemptions;
    if (patch.perClientLimit !== undefined) row.per_client_limit = patch.perClientLimit;
    if (patch.minSpendCents !== undefined) row.min_spend_cents = patch.minSpendCents;
    if (patch.applicableServiceIds !== undefined) row.applicable_service_ids = patch.applicableServiceIds;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;

    if (Object.keys(row).length === 0) return this.getById(id);

    const { data, error } = await db.from("promo_codes").update(row).eq("id", id).select(SELECT).maybeSingle();
    if (error) throw error;
    return (data as PromoRow) ?? null;
  },

  /**
   * Live redemption count. `released_at is null` is what makes a cancelled
   * booking give the code back - without it, a cancelled booking would burn a
   * redemption permanently.
   */
  async redemptionCount(promoId: string): Promise<number> {
    const db = requireServiceRole();
    const { count, error } = await db
      .from("promo_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("promo_code_id", promoId)
      .is("released_at", null);
    if (error) throw error;
    return count ?? 0;
  },
};
