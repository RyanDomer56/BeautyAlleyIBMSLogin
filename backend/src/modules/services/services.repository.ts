import { requireServiceRole, supabasePublic } from "../../db/supabase";
import { toRange, type Pagination } from "../../lib/pagination";
import type { Database } from "../../types/database";
import type { CreateServiceInput, UpdateServiceInput } from "./services.schemas";

/**
 * The second catalogue level, embedded rather than fetched separately.
 *
 * A service belongs to at most one subcategory, and the catalogue page needs
 * the *name* to group by — so it is joined here instead of making the client
 * fetch the subcategory list and stitch the two together. One request, one
 * source of truth for what "IV Drips" is called.
 */
export interface ServiceSubcategoryRef {
  id: string;
  slug: string;
  name: string;
  category: "SPA" | "SALON" | "WELLNESS";
}

export interface ServiceRow {
  id: string;
  name: string;
  category: "SPA" | "SALON" | "WELLNESS";
  description: string | null;
  price_cents: number;
  duration_minutes: number;
  /** Migration 17. NULL = the service needs no room. */
  required_room_type: string | null;
  /** Migration 17. Second catalogue level. */
  subcategory_id: string | null;
  /** Migration 22. NULL when the salon has not confirmed the formulation. */
  ingredients: string | null;
  /**
   * Migration 23. When false, `ingredients` is NULL and the catalogue must say
   * the formulation is being confirmed rather than guess one.
   */
  ingredients_verified: boolean;
  /** Embedded by the select below; NULL for the salon floor services. */
  subcategory: ServiceSubcategoryRef | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Declared `as const` deliberately. supabase-js parses the select string at
 * the *type* level to infer the result shape; a plain concatenated string
 * widens to `string`, the parse fails, and every row comes back as
 * `GenericStringError` - which then needs a cast at every call site. The
 * literal type is what makes the inference work.
 */
const SELECT =
  "id, name, category, description, price_cents, duration_minutes, required_room_type, subcategory_id, ingredients, ingredients_verified, is_active, created_at, updated_at, subcategory:service_subcategories(id, slug, name, category)" as const;

type ServiceUpdate = Database["public"]["Tables"]["services"]["Update"];

export const servicesRepository = {
  async list(opts: {
    pagination: Pagination & { sort: string; order: "asc" | "desc" };
    category?: ServiceRow["category"];
    includeInactive: boolean;
  }): Promise<{ rows: ServiceRow[]; total: number }> {
    // A public catalogue read goes through the publishable key, so the RLS
    // policy `services_public_read` is what enforces "active only" - not a
    // WHERE clause this code could forget to add. Only a request that
    // explicitly asks for inactive rows needs the service role.
    const db = opts.includeInactive ? requireServiceRole() : supabasePublic;
    const { from, to } = toRange(opts.pagination);

    let query = db.from("services").select(SELECT, { count: "exact" });

    if (!opts.includeInactive) query = query.eq("is_active", true);
    if (opts.category) query = query.eq("category", opts.category);

    const { data, error, count } = await query
      // The sort column is whitelisted by the zod enum upstream, so this
      // cannot be used to inject an expression.
      .order(opts.pagination.sort, { ascending: opts.pagination.order === "asc" })
      .range(from, to);

    if (error) throw error;
    return { rows: (data ?? []) as ServiceRow[], total: count ?? 0 };
  },

  async search(term: string, limit: number): Promise<ServiceRow[]> {
    const db = supabasePublic;
    // `ilike` with the term escaped for the LIKE wildcards, so a user typing
    // "%" searches for a literal percent sign instead of matching everything.
    const safe = term.replace(/[%_\\]/g, (m) => `\\${m}`);
    const { data, error } = await db
      .from("services")
      .select(SELECT)
      .eq("is_active", true)
      .or(`name.ilike.%${safe}%,description.ilike.%${safe}%`)
      .order("name")
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as ServiceRow[];
  },

  /**
   * `publicView` reads through the publishable key so an inactive service is
   * invisible (the RLS policy filters it, and the query returns null) rather
   * than being returned and then hidden by application code.
   */
  async getById(id: string, publicView = false): Promise<ServiceRow | null> {
    const db = publicView ? supabasePublic : requireServiceRole();
    const { data, error } = await db.from("services").select(SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as ServiceRow) ?? null;
  },

  async create(input: CreateServiceInput): Promise<ServiceRow> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("services")
      .insert({
        name: input.name,
        category: input.category,
        description: input.description ?? null,
        price_cents: input.priceCents,
        duration_minutes: input.durationMinutes,
        required_room_type: input.requiredRoomType ?? null,
        subcategory_id: input.subcategoryId ?? null,
        is_active: input.isActive,
      })
      .select(SELECT)
      .single();
    if (error) throw error;
    return data as ServiceRow;
  },

  async update(id: string, patch: UpdateServiceInput): Promise<ServiceRow | null> {
    const db = requireServiceRole();
    // Typed as the table's own Update shape, so a typo in a column name is a
    // compile error rather than a silent no-op against a non-existent column.
    const row: ServiceUpdate = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.category !== undefined) row.category = patch.category;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.priceCents !== undefined) row.price_cents = patch.priceCents;
    if (patch.durationMinutes !== undefined) row.duration_minutes = patch.durationMinutes;
    if (patch.requiredRoomType !== undefined) row.required_room_type = patch.requiredRoomType;
    if (patch.subcategoryId !== undefined) row.subcategory_id = patch.subcategoryId;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;

    const { data, error } = await db.from("services").update(row).eq("id", id).select(SELECT).maybeSingle();
    if (error) throw error;
    return (data as ServiceRow) ?? null;
  },

  /**
   * Soft delete. A hard delete would cascade to employee_services and null out
   * the service_id on every historical booking_items row - destroying the link
   * between past revenue and what was actually sold.
   */
  async deactivate(id: string): Promise<ServiceRow | null> {
    return this.update(id, { isActive: false });
  },

  async countActive(): Promise<number> {
    const db = requireServiceRole();
    const { count, error } = await db
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);
    if (error) throw error;
    return count ?? 0;
  },
};
