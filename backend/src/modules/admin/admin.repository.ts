import { requireServiceRole } from "../../db/supabase";
import { toRange } from "../../lib/pagination";
import type { Database } from "../../types/database";
import type { ListAuditLogsQuery, ListClientsQuery, UpdateClientInput } from "./admin.schemas";

export interface ClientHistoryRow {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  total_bookings: number;
  completed_bookings: number;
  no_show_bookings: number;
  lifetime_value_cents: number;
  first_visit_at: string | null;
  last_visit_at: string | null;
}

const CLIENT_SELECT =
  "id, full_name, phone, email, is_active, total_bookings, completed_bookings, no_show_bookings, lifetime_value_cents, first_visit_at, last_visit_at" as const;

type ClientUpdate = Database["public"]["Tables"]["clients"]["Update"];

export const adminRepository = {
  async dashboard(from: string, to: string) {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("get_dashboard_summary", { p_from: from, p_to: to });
    if (error) throw error;
    return data;
  },

  async listClients(query: ListClientsQuery): Promise<{ rows: ClientHistoryRow[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(query);

    let q = db.from("v_client_history").select(CLIENT_SELECT, { count: "exact" });
    if (!query.includeInactive) q = q.eq("is_active", true);
    if (query.q) {
      const safe = query.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      q = q.or(`full_name.ilike.%${safe}%,phone.ilike.%${safe}%,email.ilike.%${safe}%`);
    }

    const { data, error, count } = await q
      .order(query.sort, { ascending: query.order === "asc", nullsFirst: false })
      .range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as ClientHistoryRow[], total: count ?? 0 };
  },

  async getClient(id: string): Promise<ClientHistoryRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db.from("v_client_history").select(CLIENT_SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as ClientHistoryRow) ?? null;
  },

  async updateClient(id: string, patch: UpdateClientInput) {
    const db = requireServiceRole();
    const row: ClientUpdate = {};
    if (patch.fullName !== undefined) row.full_name = patch.fullName;
    if (patch.phone !== undefined) row.phone = patch.phone;
    if (patch.email !== undefined) row.email = patch.email;
    if (patch.notes !== undefined) row.notes = patch.notes;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;

    const { data, error } = await db
      .from("clients")
      .update(row)
      .eq("id", id)
      .select("id, full_name, phone, email, notes, is_active, created_at, updated_at")
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  /**
   * Soft delete. A hard delete would cascade to the client's bookings via
   * `on delete set null` - orphaning them into anonymous guest rows and
   * silently rewriting history.
   */
  async deactivateClient(id: string) {
    return this.updateClient(id, { isActive: false });
  },

  async clientBookings(clientId: string, limit: number) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("v_booking_detail")
      .select(
        "id, reference, status, start_time, end_time, employee_name, total_cents, discount_cents"
      )
      .eq("client_id", clientId)
      .order("start_time", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data ?? [];
  },

  /** Every client, streamed in pages, for the CSV export. */
  async allClientsForExport(): Promise<ClientHistoryRow[]> {
    const db = requireServiceRole();
    const pageSize = 1000;
    const out: ClientHistoryRow[] = [];

    for (let page = 0; page < 100; page++) {
      const start = page * pageSize;
      const { data, error } = await db
        .from("v_client_history")
        .select(CLIENT_SELECT)
        .order("id")
        .range(start, start + pageSize - 1);
      if (error) throw error;
      const rows = (data ?? []) as ClientHistoryRow[];
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  },

  async listAuditLogs(query: ListAuditLogsQuery): Promise<{ rows: unknown[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(query);

    let q = db
      .from("audit_logs")
      .select("id, actor_id, actor_role, action, entity, entity_id, metadata, created_at", { count: "exact" });

    if (query.action) q = q.eq("action", query.action);
    if (query.entity) q = q.eq("entity", query.entity);
    if (query.entityId) q = q.eq("entity_id", query.entityId);
    if (query.actorId) q = q.eq("actor_id", query.actorId);
    if (query.from) q = q.gte("created_at", query.from);
    if (query.to) q = q.lte("created_at", query.to);

    const { data, error, count } = await q.order("created_at", { ascending: false }).range(from, to);
    if (error) throw error;
    return { rows: data ?? [], total: count ?? 0 };
  },
};
