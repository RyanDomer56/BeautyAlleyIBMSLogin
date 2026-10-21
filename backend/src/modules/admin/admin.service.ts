import { iso, isoOrNull } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { paginated } from "../../lib/pagination";
import { adminRepository, type ClientHistoryRow } from "./admin.repository";
import type { ListAuditLogsQuery, ListClientsQuery, UpdateClientInput } from "./admin.schemas";

export function toClientDto(row: ClientHistoryRow) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    isActive: row.is_active,
    totalBookings: Number(row.total_bookings),
    completedBookings: Number(row.completed_bookings),
    noShowBookings: Number(row.no_show_bookings),
    lifetimeValueCents: Number(row.lifetime_value_cents),
    // Null for a client who has never had a completed booking, which is a
    // meaningful state and must not become the epoch.
    firstVisitAt: isoOrNull(row.first_visit_at),
    lastVisitAt: isoOrNull(row.last_visit_at),
  };
}

/**
 * Row -> wire shape for the audit trail.
 *
 * This endpoint used to return the raw table row, which made it the only place
 * in the API emitting snake_case keys - and `created_at` in PostgREST's
 * `+00:00` spelling while everything else said `Z`. DESIGN.md does not pin the
 * shape, so it is mapped like every other DTO.
 *
 * `metadata` is the one field deliberately *not* normalised, and it must stay
 * that way. It is an untyped `jsonb` snapshot the database wrote itself - our
 * PL/pgSQL functions build it with `jsonb_build_object(...)`, and `to_jsonb()`
 * of a `timestamptz` renders with a numeric offset, so a `booking.rescheduled`
 * entry carries `"startTime": "...T05:00:00+00:00"`. Passing it through
 * verbatim is a decision, not an oversight, for two reasons:
 *
 *   1. An audit record the application layer rewrites is no longer evidence.
 *      The API's view of the trail should be diffable against the table.
 *   2. Recursively rewriting every string in an untyped blob that *looks* like
 *      an ISO timestamp is a heuristic, and it would corrupt any legitimate
 *      string value that happens to match - a `reason`, a note, a reference.
 *
 * The `Z` invariant therefore governs typed DTO fields only; `scripts/smoke.js`
 * section 6b asserts both halves of that distinction.
 */
export function toAuditLogDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    actorId: row.actor_id ?? null,
    actorRole: row.actor_role ?? null,
    action: row.action,
    entity: row.entity ?? null,
    entityId: row.entity_id ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at as string),
  };
}

/**
 * Escape a value for CSV.
 *
 * Two separate problems, both real:
 *
 *  1. Structural. A name containing a comma, a quote or a newline breaks the
 *     row layout. RFC 4180 says: wrap in double quotes, and double any quote
 *     inside.
 *
 *  2. Formula injection. Excel and Sheets execute a cell that starts with
 *     `=`, `+`, `-` or `@`. A client who registers as `=cmd|'/c calc'!A0`
 *     gets that formula run on the machine of whoever opens the export. A
 *     leading apostrophe neutralises it while still displaying the text.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);

  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // CRLF per RFC 4180, plus a trailing newline so the file ends cleanly.
  return lines.join("\r\n") + "\r\n";
}

export const adminService = {
  async dashboard(from: string, to: string) {
    if (new Date(to) < new Date(from)) {
      throw AppError.badRequest(CODES.VALIDATION_FAILED, "`to` must not be before `from`");
    }
    return adminRepository.dashboard(from, to);
  },

  async listClients(query: ListClientsQuery) {
    const { rows, total } = await adminRepository.listClients(query);
    return paginated(rows.map(toClientDto), total, query.page, query.limit);
  },

  async getClient(id: string) {
    const row = await adminRepository.getClient(id);
    if (!row) throw AppError.notFound(CODES.CLIENT_NOT_FOUND, "No such client");
    const bookings = await adminRepository.clientBookings(id, 50);
    return {
      ...toClientDto(row),
      recentBookings: bookings.map((b) => {
        const r = b as Record<string, unknown>;
        return {
          id: r.id,
          reference: r.reference,
          status: r.status,
          startTime: iso(r.start_time as string),
          endTime: iso(r.end_time as string),
          employeeName: r.employee_name,
          totalCents: r.total_cents,
          discountCents: r.discount_cents,
        };
      }),
    };
  },

  async updateClient(id: string, patch: UpdateClientInput) {
    await this.getClient(id);
    const row = await adminRepository.updateClient(id, patch);
    if (!row) throw AppError.notFound(CODES.CLIENT_NOT_FOUND, "No such client");
    return this.getClient(id);
  },

  async deactivateClient(id: string) {
    await this.getClient(id);
    await adminRepository.deactivateClient(id);
    return this.getClient(id);
  },

  async exportClientsCsv() {
    const rows = await adminRepository.allClientsForExport();
    const headers = [
      "id",
      "full_name",
      "phone",
      "email",
      "is_active",
      "total_bookings",
      "completed_bookings",
      "no_show_bookings",
      "lifetime_value_cents",
      "first_visit_at",
      "last_visit_at",
    ];
    const body = rows.map((r) => [
      r.id,
      r.full_name,
      r.phone,
      r.email,
      r.is_active,
      r.total_bookings,
      r.completed_bookings,
      r.no_show_bookings,
      r.lifetime_value_cents,
      r.first_visit_at,
      r.last_visit_at,
    ]);
    return toCsv(headers, body);
  },

  async listAuditLogs(query: ListAuditLogsQuery) {
    const { rows, total } = await adminRepository.listAuditLogs(query);
    return paginated(
      rows.map((r) => toAuditLogDto(r as Record<string, unknown>)),
      total,
      query.page,
      query.limit
    );
  },
};
