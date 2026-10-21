import { env } from "../../config/env";
import { requireServiceRole } from "../../db/supabase";
import { iso } from "../../lib/dates";
import { AppError, CODES } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { paginated } from "../../lib/pagination";
import { signQrPass, toCheckInUrl, verifyQrPass } from "../../lib/qr";
import { OPERATIONS } from "../../lib/roleGroups";
import type { Actor } from "../../types/actor";
import type { BookingStatus } from "../../types/database";
import {
  bookingsRepository,
  type BookingDetailRow,
  type BookingItemRow,
  type BookingNoteRow,
} from "./bookings.repository";
import type { CreateBookingInput, ListBookingsQuery, MyBookingsQuery } from "./bookings.schemas";

interface CreateBookingRpcResult {
  bookingId: string;
  reference: string;
  employeeId: string;
  roomId: string | null;
  roomType: string | null;
  startTime: string;
  endTime: string;
  status: string;
  subtotalCents: number;
  discountCents: number;
  memberDiscountCents: number;
  promoDiscountCents: number;
  totalCents: number;
  jti: string;
}

/**
 * PostgREST renders `timestamptz` as `2026-10-26T04:00:00+00:00` while the
 * PL/pgSQL functions return theirs as JSON, which supabase-js re-serialises as
 * `...Z`. The same instant therefore came back in two different spellings
 * depending on which code path produced it - so a client comparing a start time
 * it sent to the one it read back could not do a string comparison, and neither
 * could a test.
 *
 * `iso()` from lib/dates.ts normalises to `Z` here and in every other DTO, so
 * the API has one wire format.
 */
function toBookingDto(row: BookingDetailRow, items: BookingItemRow[] = []) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    startTime: iso(row.start_time),
    endTime: iso(row.end_time),
    employee: { id: row.employee_id, fullName: row.employee_name },
    client: row.client_id ? { id: row.client_id, fullName: row.client_name } : null,
    guest: row.guest_name || row.guest_phone ? { name: row.guest_name, phone: row.guest_phone } : null,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    // Which room the treatment is in. Null for a service that needs none, and
    // for every booking made before migration 17.
    room: row.room_id ? { id: row.room_id, name: row.room_name, type: row.room_type } : null,
    // The rate this client's booking was priced at, so the dashboard can show
    // "member rate 3%" beside the discount rather than an unexplained amount.
    memberDiscountPercent: row.member_discount_percent ?? 0,
    // Which treatments this booking covers, so the list can link to the
    // catalogue without a second request per row. Also what `?serviceId=`
    // filters on.
    serviceIds: row.service_ids ?? [],
    notes: row.notes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    items: items.map((i) => ({
      id: i.id,
      serviceId: i.service_id,
      name: i.name_snapshot,
      priceCents: i.price_cents_snapshot,
      durationMinutes: i.duration_minutes_snapshot,
    })),
  };
}

/**
 * Does this caller work at the branch?
 *
 * An allow-list rather than "not a client", so a role added later fails closed
 * - it has to be named here before it can read a booking it does not own.
 * CONCIERGE belongs: the desk needs to see the note it is handing to the
 * therapist. GUEST is deliberately absent even though it is not a client.
 */
const isStaff = (actor?: Actor) =>
  actor !== undefined && (OPERATIONS as readonly string[]).includes(actor.role);

/** Row -> wire shape for an aftercare note. */
function toNoteDto(row: BookingNoteRow) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    authorId: row.author_id,
    body: row.body,
    visibleToClient: row.visible_to_client,
    createdAt: iso(row.created_at),
  };
}

/**
 * May this caller act on this booking?
 *
 * Three ways to qualify:
 *
 *   1. staff or admin - they run the desk.
 *   2. the registered client the booking belongs to.
 *   3. anybody holding the booking's uuid, *if* the booking is a guest booking.
 *
 * Rule 3 is the one that needs justifying. A guest has no account, so there is
 * nothing to authenticate them against - yet they must be able to read, cancel
 * and re-show the pass for the booking they just made. The booking id is a
 * v4 uuid: 122 bits of CSPRNG output, generated server-side, returned only to
 * the creator. Treating it as a bearer capability is the same trust model as a
 * password-reset link, and it is the only option that does not force a guest to
 * create an account.
 *
 * The gate is `row.client_id === null`, not "the caller is anonymous". If the
 * booking belongs to an account, the uuid alone must never be enough -
 * otherwise one leaked link would expose a registered customer's name and phone
 * number. Sending a token therefore never *reduces* your rights.
 */
function canAccessBooking(
  row: { client_id: string | null },
  actor?: Actor
): boolean {
  if (isStaff(actor)) return true;
  if (row.client_id === null) return true; // guest booking - the uuid is the capability
  return !!actor?.clientId && row.client_id === actor.clientId;
}

export const bookingsService = {
  /**
   * Create a booking.
   *
   * Identity resolution is the interesting part, because the same endpoint
   * serves three callers with different rights:
   *
   *   guest          - must supply guest details; may not claim a client id
   *   signed-in client - books for themselves; `clientId` in the body is ignored
   *   staff/admin    - may book on behalf of anyone, by client id or as a guest
   *
   * The rule that matters: a client can never set `clientId` themselves. If
   * that were allowed, anyone could attach bookings to another customer's
   * account.
   */
  async create(input: CreateBookingInput, actor?: Actor) {
    let clientId: string | null = null;
    let guest = input.guest ?? null;

    if (actor && actor.role === "CLIENT") {
      clientId = actor.clientId ?? (await this.ensureClientRow(actor));
      guest = null; // ignore any guest payload from a signed-in client
    } else if (isStaff(actor)) {
      clientId = input.clientId ?? null;
      guest = input.guest ?? null;
    } else {
      // Anonymous. A client id in the body is not trusted, so it is dropped
      // rather than honoured - the alternative is that anyone can book into
      // someone else's account by guessing a uuid.
      clientId = null;
      guest = input.guest ?? null;
    }

    if (!clientId && !guest?.phone) {
      throw AppError.badRequest(
        CODES.CLIENT_REQUIRED,
        "Provide guest details, or sign in to book against your account"
      );
    }

    const db = requireServiceRole();
    const { data, error } = await db.rpc("create_booking", {
      p_service_ids: input.serviceIds,
      p_employee_id: input.employeeId ?? null,
      p_start_time: input.startTime,
      p_client_id: clientId,
      p_guest: guest,
      p_promo_code: input.promoCode ?? null,
      p_actor: actor?.id ?? null,
      p_notes: input.notes ?? null,
      // Only staff may pin a room. A client picking their own treatment room
      // is not a thing the salon offers, and honouring it would let anyone
      // occupy a room the desk had reserved for someone else.
      p_room_id: isStaff(actor) ? input.roomId ?? null : null,
    });
    if (error) throw error;

    const result = data as CreateBookingRpcResult;
    logger.info("booking.created", {
      bookingId: result.bookingId,
      reference: result.reference,
      employeeId: result.employeeId,
      roomId: result.roomId,
      totalCents: result.totalCents,
      memberDiscountCents: result.memberDiscountCents,
      by: actor?.id ?? "guest",
    });

    return {
      ...(await this.detail(result.bookingId)),
      // The pass is signed here rather than stored, so the secret never
      // touches the database and a dump of qr_tokens yields nothing forgeable.
      qr: this.passFor(result.bookingId, result.jti, result.endTime),
    };
  },

  /**
   * Lazily create the clients row for a signed-in profile.
   *
   * `clients.profile_id` is unique, so a plain insert made the very first
   * booking a race with itself: a client double-tapping "Book" got a 23505 on
   * the second request and a 500 instead of their booking. `ensure_client_for
   * _profile()` (migration 34) does the get-or-create as one statement, so the
   * second request finds the row the first one created.
   */
  async ensureClientRow(actor: Actor): Promise<string> {
    const db = requireServiceRole();
    const { data, error } = await db.rpc("ensure_client_for_profile", {
      p_profile_id: actor.id,
      p_email: actor.email ?? null,
    });
    if (error) throw error;
    return data as string;
  },

  passFor(bookingId: string, jti: string, endTime: string) {
    // The database sets expires_at to end_time + 1 day. Mirroring that here
    // keeps the signed `exp` and the row in step.
    const exp = Math.floor(new Date(endTime).getTime() / 1000) + 86_400;
    const pass = signQrPass({ jti, bid: bookingId, exp });
    return { pass, url: toCheckInUrl(pass), expiresAt: new Date(exp * 1000).toISOString() };
  },

  async detail(id: string) {
    const row = await bookingsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    const items = await bookingsRepository.itemsFor(id);
    return toBookingDto(row, items);
  },

  /**
   * Authorise a single-booking read.
   *
   * Returns 404 rather than 403 when the caller has no relationship to the
   * booking. A 403 would confirm the id exists, which is enough to enumerate
   * the salon's booking volume one uuid at a time.
   */
  async detailFor(id: string, actor?: Actor) {
    const row = await bookingsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    if (!canAccessBooking(row, actor)) {
      throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    }

    const items = await bookingsRepository.itemsFor(id);
    return toBookingDto(row, items);
  },

  async list(query: ListBookingsQuery) {
    const { rows, total } = await bookingsRepository.list(query);
    const items = await bookingsRepository.itemsForMany(rows.map((r) => r.id));
    return paginated(
      rows.map((r) => toBookingDto(r, items.get(r.id) ?? [])),
      total,
      query.page,
      query.limit
    );
  },

  // --- aftercare notes (migration 17) --------------------------------------

  /**
   * Notes on a booking.
   *
   * Authorisation is the same rule as reading the booking itself, so a guest
   * holding the uuid can read the aftercare note the therapist left for them -
   * which is the point of the note. Staff additionally see the notes flagged
   * not-client-visible.
   */
  async notes(id: string, actor?: Actor) {
    await this.detailFor(id, actor); // throws 404 if the caller may not read it
    const rows = await bookingsRepository.notesFor(id, isStaff(actor));
    return rows.map(toNoteDto);
  },

  async addNote(
    id: string,
    input: { body: string; visibleToClient: boolean },
    actor: Actor
  ) {
    await this.detailFor(id, actor);
    // The author is the staff member's employees row, not their profile: the
    // note is attributed to the therapist, and `author_id` references
    // employees. A staff login with no employee record writes an unattributed
    // note rather than failing - the note matters more than the byline.
    const authorId = actor.employeeId ?? null;
    const row = await bookingsRepository.addNote({
      bookingId: id,
      authorId,
      body: input.body,
      visibleToClient: input.visibleToClient,
    });
    return toNoteDto(row);
  },

  async deleteNote(id: string, noteId: string, actor: Actor) {
    await this.detailFor(id, actor);
    const note = await bookingsRepository.getNote(noteId);
    // A note id from another booking is a 404, not a silent success - the
    // caller asked to delete something that is not where they said it was.
    if (!note || note.booking_id !== id) {
      throw AppError.notFound(CODES.NOT_FOUND, "No such note on this booking");
    }
    await bookingsRepository.deleteNote(noteId);
  },

  /** The desk moving a booking to another room (migration 18). */
  async setRoom(id: string, roomId: string | null, actor: Actor) {
    await this.detailFor(id, actor);
    const result = await bookingsRepository.setRoom(id, roomId, actor.id);
    logger.info("booking.room_changed", { bookingId: id, roomId, by: actor.id });
    return this.detail(result.bookingId);
  },

  /**
   * The desk choosing the stylist (migration 39).
   *
   * Clients no longer pick one, so `create_booking` assigns at random from the
   * qualified, rostered, free candidates. This is how the desk disagrees. The
   * database owns the rules - qualification, shift, leave, overlap - and
   * raises a code for each, which the error mapper turns into the sentence the
   * concierge sees.
   */
  async setEmployee(id: string, employeeId: string, actor: Actor) {
    await this.detailFor(id, actor);
    const result = await bookingsRepository.setEmployee(id, employeeId, actor.id);
    logger.info("booking.employee_assigned", {
      bookingId: id,
      employeeId,
      by: actor.id,
    });
    return this.detail(result.bookingId);
  },

  async mine(actor: Actor, query: MyBookingsQuery) {
    if (!actor.clientId) {
      // A signed-in account with no client row simply has no bookings. Not an
      // error - the correct empty answer.
      return paginated([], 0, query.page, query.limit);
    }
    const { rows, total } = await bookingsRepository.listForClient(actor.clientId, query);
    const items = await bookingsRepository.itemsForMany(rows.map((r) => r.id));
    return paginated(
      rows.map((r) => toBookingDto(r, items.get(r.id) ?? [])),
      total,
      query.page,
      query.limit
    );
  },

  async cancel(
    id: string,
    input: { reason?: string; force?: boolean },
    actor?: Actor
  ) {
    const row = await bookingsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");

    const staff = isStaff(actor);
    if (!canAccessBooking(row, actor)) {
      throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    }

    // A client can never force past the cancellation window; only staff can.
    const force = staff && input.force === true;

    const db = requireServiceRole();
    const { data, error } = await db.rpc("cancel_booking", {
      p_booking_id: id,
      p_actor: actor?.id ?? null,
      p_reason: input.reason ?? null,
      p_force: force,
      p_window_hours: env.cancellationWindowHours,
    });
    if (error) throw error;

    logger.info("booking.cancelled", { bookingId: id, forced: force, by: actor?.id ?? "guest" });
    return { ...(data as object), booking: await this.detail(id) };
  },

  async reschedule(id: string, startTime: string, actor?: Actor) {
    const row = await bookingsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    if (!canAccessBooking(row, actor)) {
      throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    }

    const db = requireServiceRole();
    const { data, error } = await db.rpc("reschedule_booking", {
      p_booking_id: id,
      p_new_start: startTime,
      p_actor: actor?.id ?? null,
    });
    if (error) throw error;

    const result = data as { bookingId: string; startTime: string; endTime: string; jti: string };
    logger.info("booking.rescheduled", { bookingId: id, startTime, by: actor?.id ?? "guest" });

    return {
      ...(await this.detail(id)),
      qr: this.passFor(id, result.jti, result.endTime),
    };
  },

  /**
   * Staff status change. The database trigger owns the legality of the
   * transition - this only checks that the caller is allowed to attempt it.
   */
  async updateStatus(id: string, status: BookingStatus, actor: Actor) {
    const row = await bookingsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");

    // Cancelling is not a status write. It has to stamp `cancelled_at`, revoke
    // the pass, release the promo and write its own audit row - all of which
    // cancel_booking() does in one transaction. A bare `status = 'CANCELLED'`
    // update fails the table's CHECK constraint outright, which is why this
    // endpoint used to reject every cancellation.
    if (status === "CANCELLED") {
      const { booking } = await this.cancel(id, { force: true }, actor);
      return booking;
    }

    // Everything else goes through a function so the status write and its
    // audit row are one transaction. Writing the column directly left
    // COMPLETED and NO_SHOW with no trail at all.
    const db = requireServiceRole();
    const { error } = await db.rpc("set_booking_status", {
      p_booking_id: id,
      p_status: status,
      p_actor: actor.id,
    });
    if (error) throw error;

    logger.info("booking.status_changed", {
      bookingId: id,
      from: row.status,
      to: status,
      by: actor.id,
    });
    return this.detail(id);
  },

  /** Return a fresh signed pass for a booking, if one is still live. */
  async qr(id: string, actor?: Actor) {
    const row = await bookingsRepository.getById(id);
    if (!row) throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    if (!canAccessBooking(row, actor)) {
      throw AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    }

    if (["CANCELLED", "NO_SHOW"].includes(row.status)) {
      throw AppError.badRequest(CODES.QR_INVALID, "This booking has no active pass");
    }

    const token = await bookingsRepository.activeQrToken(id);
    if (!token) throw AppError.badRequest(CODES.QR_INVALID, "This booking has no active pass");

    if (token.used_at) {
      return { used: true, checkedInAt: iso(token.used_at), pass: null, url: null };
    }

    return { used: false, ...this.passFor(id, token.jti, row.end_time) };
  },

  /**
   * Redeem a scanned pass.
   *
   * The signature is checked first because it is cheap and stateless, then the
   * database decides. Both steps are required: the signature proves we issued
   * the pass, the row proves it has not been revoked or already used.
   */
  async checkIn(pass: string, actor: Actor) {
    const verified = verifyQrPass(pass);
    if (!verified.ok) {
      const map = {
        MALFORMED: CODES.QR_INVALID,
        BAD_SIGNATURE: CODES.QR_INVALID,
        EXPIRED: CODES.QR_EXPIRED,
      } as const;
      throw AppError.badRequest(map[verified.reason], "That check-in code is not valid");
    }

    // A pass may only be redeemed by staff. A client scanning their own pass
    // to mark themselves arrived would defeat the point of a desk check-in.
    const staffId = actor.employeeId ?? null;

    const db = requireServiceRole();
    const { data, error } = await db.rpc("check_in_booking", {
      p_jti: verified.payload.jti,
      p_staff_id: staffId,
      p_actor: actor.id,
      p_window_minutes: env.qrCheckinWindowMinutes,
    });
    if (error) throw error;

    logger.info("booking.checked_in", { jti: verified.payload.jti, by: actor.id });

    // `checkedInAt` comes back as a `timestamptz` inside the function's `jsonb`,
    // which Postgres renders as `+00:00` - normalised here for the same reason
    // the booking DTO is.
    const result = data as {
      bookingId: string;
      reference: string;
      status: string;
      checkedInAt: string;
      checkinId: string;
    };
    return { ...result, checkedInAt: iso(result.checkedInAt) };
  },
};
