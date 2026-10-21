import { Router } from "express";
import type { Request, Response } from "express";
import { bookingsController } from "./bookings.controller";
import {
  assignEmployeeSchema,
  cancelBookingSchema,
  createBookingSchema,
  createNoteSchema,
  idParamSchema,
  listBookingsQuerySchema,
  myBookingsQuerySchema,
  noteParamSchema,
  rescheduleBookingSchema,
  setRoomSchema,
  updateStatusSchema,
} from "./bookings.schemas";
import { authenticate, optionalAuthenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { DESK, OPERATIONS } from "../../lib/roleGroups";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";
import { AppError, CODES } from "../../lib/errors";
import { loyaltyService } from "../loyalty/loyalty.service";
import type { Actor } from "../../types/actor";

export const bookingsRouter = Router();
export const meRouter = Router();

// --- client's own bookings -------------------------------------------------
meRouter.get(
  "/bookings",
  authenticate,
  validate({ query: myBookingsQuerySchema }),
  asyncHandler(bookingsController.mine)
);

/**
 * The client's own membership standing.
 *
 * Scoped to `actor.clientId`, so it can only ever describe the caller - there
 * is no id in the path to tamper with. A signed-in account with no client row
 * gets a not-found rather than a fabricated zero, because "you have 0 visits"
 * and "we do not know you" are different answers and only one of them is true.
 */
meRouter.get(
  "/loyalty",
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const actor = req.actor as Actor;
    if (!actor.clientId) {
      throw AppError.notFound(CODES.CLIENT_NOT_FOUND, "This account has no client record");
    }
    res.status(200).json({ data: await loyaltyService.forClient(actor.clientId) });
  })
);

// --- create ----------------------------------------------------------------
// Optional auth: a signed-in client books against their own account, an
// anonymous visitor books as a guest. Both are legitimate.
bookingsRouter.post(
  "/",
  optionalAuthenticate,
  validate({ body: createBookingSchema }),
  asyncHandler(bookingsController.create)
);

// --- the run sheet ---------------------------------------------------------
// Everyone who works the floor reads it: the desk to answer the phone, the
// therapist to know what is next. Scoping an employee to only their own rows
// is a presentation decision the dashboards make, not a gate here.
bookingsRouter.get(
  "/",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ query: listBookingsQuerySchema }),
  asyncHandler(bookingsController.list)
);

// --- single booking --------------------------------------------------------
// Optional auth so an owner and staff both get a real answer, while a stranger
// gets the same 404 either way.
bookingsRouter.get(
  "/:id",
  optionalAuthenticate,
  validate({ params: idParamSchema }),
  asyncHandler(bookingsController.getById)
);

bookingsRouter.post(
  "/:id/cancel",
  optionalAuthenticate,
  validate({ params: idParamSchema, body: cancelBookingSchema }),
  asyncHandler(bookingsController.cancel)
);

bookingsRouter.post(
  "/:id/reschedule",
  optionalAuthenticate,
  validate({ params: idParamSchema, body: rescheduleBookingSchema }),
  asyncHandler(bookingsController.reschedule)
);

bookingsRouter.get(
  "/:id/qr",
  optionalAuthenticate,
  validate({ params: idParamSchema }),
  asyncHandler(bookingsController.qr)
);

// --- status machine --------------------------------------------------------
// The desk checks a client in; the therapist starts and finishes the service.
// Both halves of the same walk-in, so both roles.
bookingsRouter.patch(
  "/:id/status",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema, body: updateStatusSchema }),
  asyncHandler(bookingsController.updateStatus)
);

// --- aftercare notes -------------------------------------------------------
// Optional auth on the read: the guest holding the booking uuid is exactly who
// the note was written for. Staff see the internal ones as well.
bookingsRouter.get(
  "/:id/notes",
  optionalAuthenticate,
  validate({ params: idParamSchema }),
  asyncHandler(bookingsController.notes)
);

// Only the therapist and the desk write notes.
bookingsRouter.post(
  "/:id/notes",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema, body: createNoteSchema }),
  asyncHandler(bookingsController.addNote)
);

// Deleting a note is the author's correction, not a records decision - so the
// same roles as writing one, rather than the ADMIN-only treatment that the
// softer financial deletes get.
bookingsRouter.delete(
  "/:id/notes/:noteId",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: noteParamSchema }),
  asyncHandler(bookingsController.deleteNote)
);

// --- room override ---------------------------------------------------------
// The DESK, not any staff member and not ADMIN-only: moving a treatment to
// another room is a front-desk decision made while the client is standing
// there. A therapist reports that a room needs cleaning; they do not reassign
// it, and an owner is not expected to be at the desk.
bookingsRouter.patch(
  "/:id/room",
  authenticate,
  requireRole(...DESK),
  validate({ params: idParamSchema, body: setRoomSchema }),
  asyncHandler(bookingsController.setRoom)
);

// --- stylist assignment ----------------------------------------------------
// Clients do not choose a stylist when they book; the server assigns one. The
// desk overrides it, so this is DESK for the same reason the room override is:
// it is a front-desk decision made with the client in front of you.
bookingsRouter.patch(
  "/:id/employee",
  authenticate,
  requireRole(...DESK),
  validate({ params: idParamSchema, body: assignEmployeeSchema }),
  asyncHandler(bookingsController.setEmployee)
);
