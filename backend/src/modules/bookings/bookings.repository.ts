import { requireServiceRole } from "../../db/supabase";
import { toRange, type Pagination } from "../../lib/pagination";
import type { ListBookingsQuery, MyBookingsQuery } from "./bookings.schemas";

/**
 * Booking data access.
 *
 * Writes never go through here. Creating, cancelling and rescheduling are
 * PL/pgSQL functions called via `rpc()` in bookings.service.ts, because each
 * touches several tables and must be atomic - something supabase-js cannot
 * express as a transaction.
 */

export interface BookingDetailRow {
  id: string;
  reference: string;
  status: string;
  start_time: string;
  end_time: string;
  employee_id: string;
  employee_name: string | null;
  client_id: string | null;
  client_name: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  promo_code_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Migration 19. */
  room_id: string | null;
  room_name: string | null;
  room_type: string | null;
  member_discount_percent: number | null;
  /** Migration 32. Empty array when the booking has no service rows. */
  service_ids: string[];
}

export interface BookingItemRow {
  id: string;
  service_id: string | null;
  employee_id: string | null;
  name_snapshot: string;
  price_cents_snapshot: number;
  duration_minutes_snapshot: number;
}

export interface BookingNoteRow {
  id: string;
  booking_id: string;
  author_id: string | null;
  body: string;
  visible_to_client: boolean;
  created_at: string;
}

const NOTE_SELECT = "id, booking_id, author_id, body, visible_to_client, created_at" as const;

const DETAIL_SELECT =
  "id, reference, status, start_time, end_time, employee_id, employee_name, client_id, client_name, guest_name, guest_phone, subtotal_cents, discount_cents, total_cents, promo_code_id, notes, created_at, updated_at, room_id, room_name, room_type, member_discount_percent, service_ids" as const;

export const bookingsRepository = {
  async getById(id: string): Promise<BookingDetailRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db.from("v_booking_detail").select(DETAIL_SELECT).eq("id", id).maybeSingle();
    if (error) throw error;
    return (data as BookingDetailRow) ?? null;
  },

  async itemsFor(bookingId: string): Promise<BookingItemRow[]> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("booking_items")
      .select("id, service_id, employee_id, name_snapshot, price_cents_snapshot, duration_minutes_snapshot")
      .eq("booking_id", bookingId)
      .order("name_snapshot");
    if (error) throw error;
    return (data ?? []) as BookingItemRow[];
  },

  /**
   * The same rows for a whole page of bookings, in one query.
   *
   * The list endpoints used to omit items entirely, so `items` was `[]` on
   * every row they returned. Every consumer then rendered "—" where the
   * treatment goes and summed the durations to 0 — the run sheet said "0 min"
   * for every booking on it. Loading them per row would have been an N+1; this
   * is one `IN (...)` for the page.
   */
  async itemsForMany(bookingIds: string[]): Promise<Map<string, BookingItemRow[]>> {
    const grouped = new Map<string, BookingItemRow[]>();
    if (bookingIds.length === 0) return grouped;

    const db = requireServiceRole();
    const { data, error } = await db
      .from("booking_items")
      .select(
        "id, booking_id, service_id, employee_id, name_snapshot, price_cents_snapshot, duration_minutes_snapshot"
      )
      .in("booking_id", bookingIds)
      .order("name_snapshot");
    if (error) throw error;

    for (const row of (data ?? []) as (BookingItemRow & { booking_id: string })[]) {
      const list = grouped.get(row.booking_id);
      if (list) list.push(row);
      else grouped.set(row.booking_id, [row]);
    }
    return grouped;
  },

  async list(
    query: ListBookingsQuery
  ): Promise<{ rows: BookingDetailRow[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(query);

    let q = db.from("v_booking_detail").select(DETAIL_SELECT, { count: "exact" });
    if (query.status) q = q.eq("status", query.status);
    if (query.employeeId) q = q.eq("employee_id", query.employeeId);
    if (query.clientId) q = q.eq("client_id", query.clientId);
    // Migration 32 added `service_ids` to the view for exactly this. The filter
    // used to be validated and then dropped on the floor, so a caller asking
    // for one treatment silently got every booking.
    if (query.serviceId) q = q.contains("service_ids", [query.serviceId]);
    if (query.from) q = q.gte("start_time", `${query.from}T00:00:00Z`);
    if (query.to) q = q.lte("start_time", `${query.to}T23:59:59Z`);
    if (query.q) {
      const safe = query.q.replace(/[%_\\]/g, (m) => `\\${m}`);
      q = q.or(`reference.ilike.%${safe}%,client_name.ilike.%${safe}%,guest_name.ilike.%${safe}%`);
    }

    const { data, error, count } = await q
      .order(query.sort, { ascending: query.order === "asc" })
      .range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as BookingDetailRow[], total: count ?? 0 };
  },

  async listForClient(
    clientId: string,
    query: MyBookingsQuery
  ): Promise<{ rows: BookingDetailRow[]; total: number }> {
    const db = requireServiceRole();
    const { from, to } = toRange(query);

    let q = db
      .from("v_booking_detail")
      .select(DETAIL_SELECT, { count: "exact" })
      .eq("client_id", clientId);

    if (query.status) q = q.eq("status", query.status);
    if (query.upcoming) {
      q = q
        .gte("end_time", new Date().toISOString())
        .in("status", ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_SERVICE"]);
    }

    const { data, error, count } = await q.order("start_time", { ascending: !query.upcoming }).range(from, to);
    if (error) throw error;
    return { rows: (data ?? []) as BookingDetailRow[], total: count ?? 0 };
  },

  /**
   * Service ids for a booking, used to re-validate a promo when previewing a
   * discount against an existing booking.
   */
  async serviceIdsFor(bookingId: string): Promise<string[]> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("booking_items")
      .select("service_id")
      .eq("booking_id", bookingId)
      .not("service_id", "is", null);
    if (error) throw error;
    return (data ?? []).map((r: { service_id: string }) => r.service_id);
  },

  /** Active QR pass for a booking, if one has not been revoked. */
  async activeQrToken(bookingId: string) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("qr_tokens")
      .select("id, jti, expires_at, used_at, revoked_at")
      .eq("booking_id", bookingId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; jti: string; expires_at: string; used_at: string | null; revoked_at: string | null } | null;
  },

  async qrTokenByJti(jti: string) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("qr_tokens")
      .select("id, booking_id, jti, expires_at, used_at, revoked_at")
      .eq("jti", jti)
      .maybeSingle();
    if (error) throw error;
    return data as {
      id: string;
      booking_id: string;
      jti: string;
      expires_at: string;
      used_at: string | null;
      revoked_at: string | null;
    } | null;
  },

  async checkinFor(bookingId: string) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("checkins")
      .select("id, booking_id, staff_id, checked_in_at")
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  /**
   * There is deliberately no `setStatus` here.
   *
   * A direct `update({ status })` cannot express cancellation (the table
   * requires `cancelled_at` to be set in the same statement) and writes no
   * audit row. Both live in SQL now: `cancel_booking()` and
   * `set_booking_status()`. Reintroducing a direct writer would reintroduce
   * the bug.
   */

  async countAll(): Promise<number> {
    const db = requireServiceRole();
    const { count, error } = await db.from("bookings").select("id", { count: "exact", head: true });
    if (error) throw error;
    return count ?? 0;
  },

  /** Resolve or create a client row for a signed-in profile. */
  async clientForProfile(profileId: string) {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("clients")
      .select("id, full_name, phone, email")
      .eq("profile_id", profileId)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; full_name: string; phone: string | null; email: string | null } | null;
  },

  // --- migration 17: aftercare notes ---------------------------------------

  /**
   * Notes on a booking, newest first.
   *
   * `includeHidden` is the staff flag. A client calling this gets only the
   * notes the therapist marked shareable - enforced here *and* by the RLS
   * policy on booking_notes, so a bug in this line does not become a leak.
   */
  async notesFor(bookingId: string, includeHidden: boolean): Promise<BookingNoteRow[]> {
    const db = requireServiceRole();
    let q = db
      .from("booking_notes")
      .select(NOTE_SELECT)
      .eq("booking_id", bookingId);
    if (!includeHidden) q = q.eq("visible_to_client", true);

    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as BookingNoteRow[];
  },

  async addNote(input: {
    bookingId: string;
    authorId: string | null;
    body: string;
    visibleToClient: boolean;
  }): Promise<BookingNoteRow> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("booking_notes")
      .insert({
        booking_id: input.bookingId,
        author_id: input.authorId,
        body: input.body,
        visible_to_client: input.visibleToClient,
      })
      .select(NOTE_SELECT)
      .single();
    if (error) throw error;
    return data as BookingNoteRow;
  },

  async getNote(noteId: string): Promise<BookingNoteRow | null> {
    const db = requireServiceRole();
    const { data, error } = await db
      .from("booking_notes")
      .select(NOTE_SELECT)
      .eq("id", noteId)
      .maybeSingle();
    if (error) throw error;
    return (data as BookingNoteRow) ?? null;
  },

  /**
   * Notes are HARD deleted, unlike promos and rooms.
   *
   * The reasoning that makes a soft delete right elsewhere does not apply: an
   * aftercare note is not referenced by anything, carries no revenue and has
   * no downstream rows to cascade. A therapist who wrote a note on the wrong
   * client should be able to remove it outright rather than leave it sitting
   * in the table waiting to be read by mistake.
   */
  async deleteNote(noteId: string): Promise<void> {
    const db = requireServiceRole();
    const { error } = await db.from("booking_notes").delete().eq("id", noteId);
    if (error) throw error;
  },

  // --- migration 18: the desk moving a booking's room ----------------------

  /** Delegates to set_booking_room() so the type check and audit are applied. */
  async setRoom(bookingId: string, roomId: string | null, actorId: string | null) {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("set_booking_room", {
      p_booking_id: bookingId,
      p_room_id: roomId,
      p_actor: actorId,
    });
    if (error) throw error;
    return data as { bookingId: string; roomId: string | null; roomType: string | null };
  },

  // --- migration 39: the desk choosing the stylist -------------------------

  /** Delegates to reassign_booking_employee() so every rule and the audit apply. */
  async setEmployee(bookingId: string, employeeId: string, actorId: string | null) {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("reassign_booking_employee", {
      p_booking_id: bookingId,
      p_employee_id: employeeId,
      p_actor: actorId,
    });
    if (error) throw error;
    return data as { bookingId: string; employeeId: string };
  },
};

export type { Pagination };
