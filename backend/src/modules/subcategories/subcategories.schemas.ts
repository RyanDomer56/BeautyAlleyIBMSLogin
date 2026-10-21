import { z } from "zod";

export const SUBCATEGORY_SORT_COLUMNS = ["name", "sort_order", "created_at"] as const;

const category = z.enum(["SPA", "SALON", "WELLNESS"]);

/**
 * The slug is derived from the name when omitted, so a new massage
 * classification is one POST rather than a POST plus a naming decision.
 */
export const createSubcategorySchema = z.object({
  category,
  name: z.string().trim().min(2, "A subcategory needs a name").max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "A slug is lower-case words separated by hyphens")
    .optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export const updateSubcategorySchema = z
  .object({
    category: category.optional(),
    name: z.string().trim().min(2).max(80).optional(),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export const listSubcategoriesQuerySchema = z.object({
  category: category.optional(),
  /** The booking page only ever wants live ones; the admin table asks for all. */
  includeInactive: z.coerce.boolean().default(false),
});

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid subcategory id") });

/** "Brazilian Spa" -> "brazilian-spa". Unicode-safe enough for a salon menu. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export type CreateSubcategoryInput = z.infer<typeof createSubcategorySchema>;
export type UpdateSubcategoryInput = z.infer<typeof updateSubcategorySchema>;
export type ListSubcategoriesQuery = z.infer<typeof listSubcategoriesQuerySchema>;
