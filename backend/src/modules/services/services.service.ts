import { iso } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import { servicesRepository, type ServiceRow } from "./services.repository";
import type {
  CreateServiceInput,
  ListServicesQuery,
  UpdateServiceInput,
} from "./services.schemas";

/** Row -> wire shape. Snake case stays in the database. */
export function toServiceDto(row: ServiceRow) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    priceCents: row.price_cents,
    durationMinutes: row.duration_minutes,
    // Surfaced so the booking page can say "uses a treatment room" without a
    // second call, and so the admin table can show what is still unassigned.
    requiredRoomType: row.required_room_type,
    subcategoryId: row.subcategory_id,
    /** The group the catalogue renders this under. NULL = the salon floor. */
    subcategory: row.subcategory
      ? {
          id: row.subcategory.id,
          slug: row.subcategory.slug,
          name: row.subcategory.name,
          category: row.subcategory.category,
        }
      : null,
    /**
     * The formulation, and whether it is confirmed.
     *
     * Both are sent, and the pair is the point: `ingredients: null` with
     * `ingredientsVerified: false` means "we do not know yet, do not guess",
     * which is a different statement from a service that genuinely has none.
     * The catalogue is what turns that into a sentence — the API does not
     * invent a placeholder string, because a placeholder in the payload is one
     * careless render away from being shown as fact.
     */
    ingredients: row.ingredients,
    ingredientsVerified: row.ingredients_verified,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export const servicesService = {
  async list(query: ListServicesQuery) {
    const { rows, total } = await servicesRepository.list({
      pagination: { page: query.page, limit: query.limit, sort: query.sort, order: query.order },
      category: query.category,
      includeInactive: query.includeInactive,
    });
    return paginated(rows.map(toServiceDto), total, query.page, query.limit);
  },

  async search(term: string, limit: number) {
    const rows = await servicesRepository.search(term, limit);
    return rows.map(toServiceDto);
  },

  async getById(id: string, publicView = false) {
    const row = await servicesRepository.getById(id, publicView);
    if (!row) throw AppError.notFound(CODES.SERVICE_NOT_FOUND, "No such service");
    return toServiceDto(row);
  },

  async create(input: CreateServiceInput) {
    const row = await servicesRepository.create(input);
    return toServiceDto(row);
  },

  async update(id: string, patch: UpdateServiceInput) {
    // Confirm it exists first, so a patch to a bogus id is a 404 rather than a
    // silent no-op that the client reads as success.
    await this.getById(id);
    const row = await servicesRepository.update(id, patch);
    if (!row) throw AppError.notFound(CODES.SERVICE_NOT_FOUND, "No such service");
    return toServiceDto(row);
  },

  async deactivate(id: string) {
    await this.getById(id);
    const row = await servicesRepository.deactivate(id);
    if (!row) throw AppError.notFound(CODES.SERVICE_NOT_FOUND, "No such service");
    return toServiceDto(row);
  },
};
