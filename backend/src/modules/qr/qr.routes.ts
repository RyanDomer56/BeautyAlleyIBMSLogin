import { Router } from "express";
import type { Request, Response } from "express";
import { checkInSchema, doorEntrySchema, qrService } from "./qr.service";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { OPERATIONS, OWNER } from "../../lib/roleGroups";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";
import { toDoorEntryUrl } from "../../lib/qr";
import { env } from "../../config/env";
import type { Actor } from "../../types/actor";

export const qrRouter = Router();

// --- public ----------------------------------------------------------------
/**
 * The walk-in door QR.
 *
 * GET, because the QR encodes a URL and a phone camera opens it directly -
 * requiring a POST would mean the page could not work before its JavaScript
 * boots. This is the endpoint that was missing: before it, the only routes
 * under /qr were staff-only, so a guest scanning the door sticker had
 * nowhere to land.
 *
 * No personal data leaves here unless the caller supplies a phone, and then
 * only a first name (see qrService.enter).
 */
qrRouter.get(
  "/enter",
  validate({ query: doorEntrySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await qrService.enter(req.query as never);
    res.status(200).json({ data: result });
  })
);

// --- the scanner -----------------------------------------------------------
// Any staff device: the descriptor authorises nothing (`authorises: false`),
// so there is no reason to keep it from a therapist's phone.
qrRouter.get("/branch", authenticate, requireRole(...OPERATIONS), (_req: Request, res: Response) => {
  res.status(200).json({ data: qrService.branch() });
});

/**
 * The door sticker itself, for the page that prints it. Signed with the same
 * secret as the booking passes, so a sticker can be regenerated at any time
 * and the URL it encodes cannot be guessed.
 *
 * ADMIN-only: this emits the branch's permanent entry URL. It still grants
 * nothing beyond the public menu, but the artifact outlives every account at
 * the branch and cannot be revoked, so printing it is a branch-setup act
 * rather than a shift-time one.
 */
qrRouter.get(
  "/door",
  authenticate,
  requireRole(...OWNER),
  (_req: Request, res: Response) => {
    res.status(200).json({
      data: {
        label: "Beauty Alley - walk-in entry",
        branchId: env.branchId,
        url: toDoorEntryUrl(),
        // Unlike the desk QR this one DOES carry a signature, but it still
        // authorises nothing beyond the public menu.
        authorises: false,
        purpose: "Opens the walk-in registration screen.",
      },
    });
  }
);

/**
 * Redeem a pass at the door.
 *
 * OPERATIONS rather than DESK: the pass, the time window and the booking's
 * status are what authorise a check-in - the caller's role only decides
 * whether they may touch the desk system at all. A therapist admitting their
 * own 9am client while reception is on a call is normal, and the checkins row
 * records who actually scanned it.
 */
qrRouter.post(
  "/check-in",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ body: checkInSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await qrService.checkIn(req.body, req.actor as Actor);
    res.status(200).json({ data: result });
  })
);
