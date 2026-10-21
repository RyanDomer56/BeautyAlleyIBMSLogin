import { Router } from "express";
import { loyaltyController } from "./loyalty.controller";
import {
  clientIdParamSchema,
  listLoyaltyQuerySchema,
  promoteClientSchema,
} from "./loyalty.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { DESK } from "../../lib/roleGroups";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

/**
 * Mounted at /loyalty rather than under /admin/clients.
 *
 * The promotion is a front-desk action - the concierge is who notices a client
 * has been in three times - while everything else under /admin/clients is
 * ADMIN-only. Mounting here keeps that difference visible in the route table
 * instead of hiding it behind a path that implies admin.
 *
 * Note this is DESK, not OPERATIONS: a therapist does not grant a discount.
 */
export const loyaltyRouter = Router();

const staff = [authenticate, requireRole(...DESK)] as const;

loyaltyRouter.get(
  "/clients",
  ...staff,
  validate({ query: listLoyaltyQuerySchema }),
  asyncHandler(loyaltyController.list)
);

loyaltyRouter.get(
  "/clients/:id",
  ...staff,
  validate({ params: clientIdParamSchema }),
  asyncHandler(loyaltyController.getById)
);

loyaltyRouter.post(
  "/clients/:id/promote",
  ...staff,
  validate({ params: clientIdParamSchema, body: promoteClientSchema }),
  asyncHandler(loyaltyController.promote)
);

// The undo. Same role as the promotion: whoever can grant it should be able to
// take it back without hunting for an admin.
loyaltyRouter.delete(
  "/clients/:id/membership",
  ...staff,
  validate({ params: clientIdParamSchema }),
  asyncHandler(loyaltyController.revoke)
);
