import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const bookingStatus = z.enum([
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "IN_SERVICE",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);

export const BOOKING_SORT_COLUMNS = ["start_time", "created_at", "status", "reference"] as const;

const isoInstant = z
  .string()
  .datetime({ offset: true, message: "startTime must be an ISO-8601 timestamp with an offset" });

const guestSchema = z.object({
  name: z.string().trim().min(1, "Guest name is required").max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()\-]{7,20}$/, "Enter a valid phone number"),
});

export const createBookingSchema = z
  .object({
    serviceIds: z
      .array(z.string().uuid())
      .min(1, "Choose at least one service")
      .max(10, "A single booking may contain at most 10 services"),
    employeeId: z.string().uuid().optional(),
    startTime: isoInstant,
    /** Staff only - a client booking for themselves must not be able to set this. */
    clientId: z.string().uuid().optional(),
    guest: guestSchema.optional(),
    promoCode: z.string().trim().max(64).optional(),
    notes: z.string().trim().max(1000).optional(),
    /**
     * Desk override of the room. Omitted means "assign one for me" - the
     * database picks the first free room of the type the services need, and
     * refuses with NO_ROOM_AVAILABLE if there is none. Clients never set this;
     * the service layer drops it for a non-staff caller.
     */
    roomId: z.string().uuid().optional(),
  })
  .refine((v) => !v.clientId || !v.guest, {
    message: "Provide either clientId or guest details, not both",
    path: ["guest"],
  });

export const cancelBookingSchema = z.object({
  reason: z.string().trim().max(300).optional(),
  /** Staff override of the cancellation window. Ignored for clients. */
  force: z.boolean().default(false),
});

export const rescheduleBookingSchema = z.object({
  startTime: isoInstant,
});

export const updateStatusSchema = z.object({
  status: bookingStatus,
});

export const listBookingsQuerySchema = paginationSchema.extend({
  sort: z.enum(BOOKING_SORT_COLUMNS).default("start_time"),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: bookingStatus.optional(),
  employeeId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(100).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid("Not a valid booking id") });

export const noteParamSchema = z.object({
  id: z.string().uuid("Not a valid booking id"),
  noteId: z.string().uuid("Not a valid note id"),
});

/**
 * The therapist's aftercare note. Written at the desk after a treatment, shown
 * to the client on their dashboard when `visibleToClient`.
 */
export const createNoteSchema = z.object({
  body: z
    .string()
    .trim()
    .min(2, "A note needs some content")
    .max(2000, "Keep aftercare notes under 2000 characters"),
  /**
   * Defaults to true: the note exists to be read by the client. An internal
   * note ("client was rude", "flag for the manager") is the exception, so it
   * is the one that has to be asked for explicitly.
   */
  visibleToClient: z.boolean().default(true),
});

/** Desk override of a booking's room. */
export const setRoomSchema = z.object({
  /** Null clears the room - for a service that turns out not to need one. */
  roomId: z.string().uuid().nullable(),
});

/**
 * Desk override of the stylist.
 *
 * Clients do not choose one when they book - the server assigns a qualified,
 * rostered, free stylist at random - so this is the only way a named stylist
 * is ever attached to a self-service booking.
 */
export const assignEmployeeSchema = z.object({
  employeeId: z.string().uuid("Choose a stylist"),
});

export const myBookingsQuerySchema = paginationSchema.extend({
  status: bookingStatus.optional(),
  upcoming: z.coerce.boolean().default(false),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
export type MyBookingsQuery = z.infer<typeof myBookingsQuerySchema>;
