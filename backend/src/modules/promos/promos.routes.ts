import { Router } from "express";
import { promosController } from "./promos.controller";
import {
  createPromoSchema,
  idParamSchema,
  listPromosQuerySchema,
  updatePromoSchema,
  validatePromoSchema,
} from "./promos.schemas";
import { authenticate, optionalAuthenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

export const promosRouter = Router();

// --- public ----------------------------------------------------------------
// Optional auth so a signed-in client's per-client redemption limit is counted
// correctly; a guest is identified by phone instead.
promosRouter.post(
  "/validate",
  optionalAuthenticate,
  validate({ body: validatePromoSchema }),
  asyncHandler(promosController.validate)
);

// --- admin -----------------------------------------------------------------
const admin = [authenticate, requireRole("ADMIN")] as const;

promosRouter.get("/", ...admin, validate({ query: listPromosQuerySchema }), asyncHandler(promosController.list));
promosRouter.get("/:id", ...admin, validate({ params: idParamSchema }), asyncHandler(promosController.getById));
promosRouter.post("/", ...admin, validate({ body: createPromoSchema }), asyncHandler(promosController.create));
promosRouter.patch(
  "/:id",
  ...admin,
  validate({ params: idParamSchema, body: updatePromoSchema }),
  asyncHandler(promosController.update)
);
promosRouter.delete("/:id", ...admin, validate({ params: idParamSchema }), asyncHandler(promosController.remove));
