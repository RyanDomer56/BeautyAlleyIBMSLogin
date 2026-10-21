import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const PROMO_SORT_COLUMNS = ["code", "created_at", "starts_at", "ends_at"] as const;

export const validatePromoSchema = z.object({
  code: z.string().trim().min(1, "Enter a promo code").max(64),
  serviceIds: z.array(z.string().uuid()).default([]),
  /** Computed by the caller when previewing against a known cart. */
  subtotalCents: z.coerce.number().int().min(0).default(0),
  guestPhone: z.string().trim().max(32).optional(),
});

export const createPromoSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3, "A code needs at least 3 characters")
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "Codes may contain letters, digits, hyphen and underscore"),
    type: z.enum(["PERCENT", "FIXED"]),
    /** PERCENT: 1-100. FIXED: minor units. */
    value: z.coerce.number().int().positive("Value must be greater than zero"),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    maxRedemptions: z.coerce.number().int().positive().optional(),
    perClientLimit: z.coerce.number().int().positive().optional(),
    minSpendCents: z.coerce.number().int().min(0).default(0),
    applicableServiceIds: z.array(z.string().uuid()).optional(),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.type !== "PERCENT" || (v.value >= 1 && v.value <= 100), {
    message: "A percentage discount must be between 1 and 100",
    path: ["value"],
  })
  .refine((v) => !v.startsAt || !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export const updatePromoSchema = z.object({
  type: z.enum(["PERCENT", "FIXED"]).optional(),
  value: z.coerce.number().int().positive().optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  maxRedemptions: z.coerce.number().int().positive().nullable().optional(),
  perClientLimit: z.coerce.number().int().positive().nullable().optional(),
  minSpendCents: z.coerce.number().int().min(0).optional(),
  applicableServiceIds: z.array(z.string().uuid()).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const listPromosQuerySchema = paginationSchema.extend({
  sort: z.enum(PROMO_SORT_COLUMNS).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  activeOnly: z.coerce.boolean().default(false),
  q: z.string().trim().max(64).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid promo id") });

export type CreatePromoInput = z.infer<typeof createPromoSchema>;
export type UpdatePromoInput = z.infer<typeof updatePromoSchema>;
export type ValidatePromoInput = z.infer<typeof validatePromoSchema>;
export type ListPromosQuery = z.infer<typeof listPromosQuerySchema>;
