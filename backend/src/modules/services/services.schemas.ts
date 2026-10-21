import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const serviceCategory = z.enum(["SPA", "SALON", "WELLNESS"]);

/**
 * Migration 17. NULL means the service needs no room at all - a chair at a
 * station is enough - which is why it is optional rather than defaulted.
 */
export const roomType = z.enum([
  "MASSAGE",
  "FACIAL",
  "NAIL",
  "WAXING",
  "SAUNA",
  "VIP",
  "OTHER",
]);

/** Columns a client may sort by. Anything else is rejected before it reaches SQL. */
export const SERVICE_SORT_COLUMNS = [
  "name",
  "category",
  "price_cents",
  "duration_minutes",
  "created_at",
] as const;

export const listServicesSchema = paginationSchema.extend({
  sort: z.enum(SERVICE_SORT_COLUMNS).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  category: serviceCategory.optional(),
  // Defaults to true so the public catalogue never advertises retired
  // services; admin passes includeInactive=true to see everything.
  includeInactive: z.coerce.boolean().default(false),
});

export const searchServicesSchema = z.object({
  q: z.string().trim().min(1, "Provide a search term").max(100),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const createServiceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: serviceCategory,
  description: z.string().trim().max(2000).optional(),
  priceCents: z.coerce.number().int().min(0, "Price cannot be negative"),
  durationMinutes: z.coerce.number().int().min(5, "A service must last at least 5 minutes").max(720),
  /** Which kind of room this treatment occupies. Omit for no room. */
  requiredRoomType: roomType.nullable().optional(),
  /** The second catalogue level, e.g. "Deep Tissue" under SPA. */
  subcategoryId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().default(true),
});

export const updateServiceSchema = createServiceSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  "Provide at least one field to update"
);

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid id") });

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type ListServicesQuery = z.infer<typeof listServicesSchema>;
