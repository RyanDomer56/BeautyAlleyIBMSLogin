import { iso } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import {
  slugify,
  type CreateSubcategoryInput,
  type ListSubcategoriesQuery,
  type UpdateSubcategoryInput,
} from "./subcategories.schemas";
import { subcategoriesRepository } from "./subcategories.repository";
import type { Database } from "../../types/database";

type SubcategoryRow = Database["public"]["Tables"]["service_subcategories"]["Row"];
type ServiceCategory = Database["public"]["Tables"]["services"]["Row"]["category"];

export function toSubcategoryDto(row: SubcategoryRow, serviceCount?: number) {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    slug: row.slug,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(serviceCount !== undefined ? { serviceCount } : {}),
  };
}

/**
 * The catalogue, grouped for the booking page: `[{ category, subcategories }]`.
 * Grouping here rather than in the client keeps the menu order (sort_order)
 * authoritative on the server, so the same order appears everywhere.
 */
function groupByCategory(rows: SubcategoryRow[]) {
  const order: ServiceCategory[] = ["SPA", "SALON", "WELLNESS"];
  const buckets = new Map<ServiceCategory, ReturnType<typeof toSubcategoryDto>[]>();

  for (const row of rows) {
    const list = buckets.get(row.category) ?? [];
    list.push(toSubcategoryDto(row));
    buckets.set(row.category, list);
  }

  return order
    .filter((c) => buckets.has(c))
    .map((c) => ({ category: c, subcategories: buckets.get(c)! }));
}

export const subcategoriesService = {
  async list(query: ListSubcategoriesQuery) {
    const rows = await subcategoriesRepository.list(query);
    // Counts only on the admin view; the public menu does not need them and
    // they would be one query per row.
    if (!query.includeInactive) return rows.map((r) => toSubcategoryDto(r));

    const withCounts = await Promise.all(
      rows.map(async (r) => toSubcategoryDto(r, await subcategoriesRepository.serviceCount(r.id)))
    );
    return withCounts;
  },

  async menu(category?: ServiceCategory) {
    return groupByCategory(await subcategoriesRepository.listPublic(category));
  },

  async getById(id: string) {
    const row = await subcategoriesRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.NOT_FOUND, "No such subcategory");
    return toSubcategoryDto(row, await subcategoriesRepository.serviceCount(id));
  },

  async create(input: CreateSubcategoryInput) {
    const slug = input.slug ?? slugify(input.name);
    if (!slug) {
      throw AppError.badRequest(CODES.VALIDATION_FAILED, "That name does not produce a usable slug");
    }
    try {
      const row = await subcategoriesRepository.create({ ...input, slug });
      return toSubcategoryDto(row, 0);
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw AppError.conflict(CODES.CONFLICT, `The slug "${slug}" is already in use`);
      }
      throw err;
    }
  },

  async update(id: string, patch: UpdateSubcategoryInput) {
    await this.getById(id);
    try {
      const row = await subcategoriesRepository.update(id, patch);
      if (!row) throw AppError.notFound(CODES.NOT_FOUND, "No such subcategory");
      return toSubcategoryDto(row, await subcategoriesRepository.serviceCount(id));
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw AppError.conflict(CODES.CONFLICT, "That slug is already in use");
      }
      throw err;
    }
  },

  /**
   * Soft delete. Services filed here keep their `subcategory_id` and would
   * otherwise become invisible in the menu, so the count is surfaced in the
   * message - the admin needs to know how many services they are about to
   * un-file, not just that the delete succeeded.
   */
  async deactivate(id: string) {
    const existing = await this.getById(id);
    if (!existing.isActive) return existing;
    return this.update(id, { isActive: false });
  },
};
