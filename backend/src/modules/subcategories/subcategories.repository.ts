import { requireServiceRole, supabasePublic } from "../../db/supabase";
import type { Database } from "../../types/database";
import type {
  CreateSubcategoryInput,
  ListSubcategoriesQuery,
  UpdateSubcategoryInput,
} from "./subcategories.schemas";

type SubcategoryRow = Database["public"]["Tables"]["service_subcategories"]["Row"];
type SubcategoryUpdate = Database["public"]["Tables"]["service_subcategories"]["Update"];
type ServiceCategory = Database["public"]["Tables"]["services"]["Row"]["category"];

const SELECT = "id, category, name, slug, sort_order, is_active, created_at, updated_at" as const;

export const subcategoriesRepository = {
  async list(query: ListSubcategoriesQuery): Promise<SubcategoryRow[]> {
    const db = requireServiceRole();
    let q = db.from("service_subcategories").select(SELECT);
    if (!query.includeInactive) q = q.eq("is_active", true);
    if (query.category) q = q.eq("category", query.category);

    // Ordered by the explicit sort_order first so a salon can put "Signature
    // Massage" at the top, with the name as a stable tie-break.
    const { data, error } = await q.order("sort_order").order("name");
    if (error) throw error;
    return (data ?? []) as SubcategoryRow[];
  },

  /** Public read for the booking page. RLS already restricts anon to active. */
  async listPublic(category?: ServiceCategory): Promise<SubcategoryRow[]> {
    let q = supabasePublic.from("service_subcategories").select(SELECT).eq("is_active", true);
    if (category) q = q.eq("category", category);
    const { data, error } = await q.order("sort_order").order("name");
    if (error) throw error;
    return (data ?? []) as SubcategoryRow[];
  },

  async getById(id: string): Promise<SubcategoryRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("service_subcategories")
      .select(SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as SubcategoryRow) ?? null;
  },

  async create(input: CreateSubcategoryInput & { slug: string }): Promise<SubcategoryRow> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("service_subcategories")
      .insert({
        category: input.category,
        name: input.name,
        slug: input.slug,
        sort_order: input.sortOrder,
        is_active: input.isActive,
      })
      .select(SELECT)
      .single();
    if (error) throw error;
    return data as SubcategoryRow;
  },

  async update(id: string, patch: UpdateSubcategoryInput): Promise<SubcategoryRow | null> {
    const db = requireServiceRole();
    const row: SubcategoryUpdate = {};
    if (patch.category !== undefined) row.category = patch.category;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.slug !== undefined) row.slug = patch.slug;
    if (patch.sortOrder !== undefined) row.sort_order = patch.sortOrder;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;

    if (Object.keys(row).length === 0) return this.getById(id);

    const { data, error } = await db
      .from("service_subcategories")
      .update(row)
      .eq("id", id)
      .select(SELECT)
      .maybeSingle();
    if (error) throw error;
    return (data as SubcategoryRow) ?? null;
  },

  /** How many services are filed under this subcategory. */
  async serviceCount(id: string): Promise<number> {
    const db = requireServiceRole();
    const { count, error } = await db
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("subcategory_id", id);
    if (error) throw error;
    return count ?? 0;
  },
};
