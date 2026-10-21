import { Router } from "express";
import { z } from "zod";
import { subcategoriesController } from "./subcategories.controller";
import {
  createSubcategorySchema,
  idParamSchema,
  listSubcategoriesQuerySchema,
  updateSubcategorySchema,
} from "./subcategories.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

export const subcategoriesRouter = Router();

const menuQuerySchema = z.object({ category: z.enum(["SPA", "SALON", "WELLNESS"]).optional() });

// --- public ----------------------------------------------------------------
// The booking page renders the menu straight from these two.
subcategoriesRouter.get(
  "/menu",
  validate({ query: menuQuerySchema }),
  asyncHandler(subcategoriesController.menu)
);
subcategoriesRouter.get(
  "/",
  validate({ query: listSubcategoriesQuerySchema }),
  asyncHandler(subcategoriesController.list)
);
subcategoriesRouter.get("/:id", validate({ params: idParamSchema }), asyncHandler(subcategoriesController.getById));

// --- admin -----------------------------------------------------------------
// The catalogue is ADMIN-only, matching /services: a new massage classification
// changes what the salon sells.
const admin = [authenticate, requireRole("ADMIN")] as const;

subcategoriesRouter.post("/", ...admin, validate({ body: createSubcategorySchema }), asyncHandler(subcategoriesController.create));
subcategoriesRouter.patch(
  "/:id",
  ...admin,
  validate({ params: idParamSchema, body: updateSubcategorySchema }),
  asyncHandler(subcategoriesController.update)
);
subcategoriesRouter.delete("/:id", ...admin, validate({ params: idParamSchema }), asyncHandler(subcategoriesController.remove));
