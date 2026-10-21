import { z } from "zod";

/**
 * Shared list-query contract.
 *
 * Every collection endpoint accepts the same shape, so a client that knows how
 * to page `/services` already knows how to page `/admin/bookings`.
 *
 * `limit` is capped rather than trusted. Without a ceiling, `?limit=1000000`
 * is a trivial way to make Postgres assemble the whole table in memory - an
 * accidental denial of service that costs the caller nothing.
 */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  sort: z
    .string()
    .regex(/^[a-z_]+$/, "sort must be a column name")
    .optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** PostgREST range for the current page, inclusive of both ends. */
export function toRange({ page, limit }: Pick<Pagination, "page" | "limit">) {
  const from = (page - 1) * limit;
  return { from, to: from + limit - 1 };
}

export interface Paginated<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export function paginated<T>(data: T[], total: number, page: number, limit: number): Paginated<T> {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}
