import { Router } from "express";
import { servicesController } from "./services.controller";
import {
  createServiceSchema,
  idParamSchema,
  listServicesSchema,
  searchServicesSchema,
  updateServiceSchema,
} from "./services.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

export const servicesRouter = Router();

// --- public ----------------------------------------------------------------
servicesRouter.get("/", validate({ query: listServicesSchema }), asyncHandler(servicesController.list));
servicesRouter.get("/search", validate({ query: searchServicesSchema }), asyncHandler(servicesController.search));
servicesRouter.get("/:id", validate({ params: idParamSchema }), asyncHandler(servicesController.getById));

// --- admin -----------------------------------------------------------------
const admin = [authenticate, requireRole("ADMIN")] as const;

servicesRouter.post("/", ...admin, validate({ body: createServiceSchema }), asyncHandler(servicesController.create));
servicesRouter.patch(
  "/:id",
  ...admin,
  validate({ params: idParamSchema, body: updateServiceSchema }),
  asyncHandler(servicesController.update)
);
servicesRouter.delete("/:id", ...admin, validate({ params: idParamSchema }), asyncHandler(servicesController.remove));
