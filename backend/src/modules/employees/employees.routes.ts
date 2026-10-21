import { Router } from "express";
import { employeesController } from "./employees.controller";
import {
  availabilityQuerySchema,
  createEmployeeSchema,
  idParamSchema,
  listEmployeesSchema,
  performanceQuerySchema,
  quotaQuerySchema,
  setEmployeeServicesSchema,
  setWorkingHoursSchema,
  timeOffSchema,
  updateEmployeeSchema,
} from "./employees.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { OPERATIONS, DESK, OWNER } from "../../lib/roleGroups";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

export const employeesRouter = Router();
export const availabilityRouter = Router();

// --- public ----------------------------------------------------------------
employeesRouter.get("/", validate({ query: listEmployeesSchema }), asyncHandler(employeesController.list));

// --- the quota board -------------------------------------------------------
// Declared BEFORE `/:id`. Express matches in declaration order, so a literal
// path has to come first or `/employees/quotas` is read as the id "quotas" and
// rejected by the uuid check with a 400. The same ordering is used for
// `/admin/clients/export.csv`, and `tests/unit/apiIndex.test.ts` walks this
// path for exactly that reason.
//
// DESK, not OPERATIONS: this is the whole floor's progress, which is what the
// front desk needs to know who is free. A stylist reads their own row through
// `/employees/:id/quota` instead.
employeesRouter.get(
  "/quotas",
  authenticate,
  requireRole(...DESK),
  validate({ query: quotaQuerySchema }),
  asyncHandler(employeesController.quotas)
);

employeesRouter.get("/:id", validate({ params: idParamSchema }), asyncHandler(employeesController.getById));

// --- admin -----------------------------------------------------------------
// Employee records, qualifications, rotas and leave: the owner's. A concierge
// works the desk, they do not hire or re-roster.
const admin = [authenticate, requireRole(...OWNER)] as const;

employeesRouter.post("/", ...admin, validate({ body: createEmployeeSchema }), asyncHandler(employeesController.create));
employeesRouter.patch(
  "/:id",
  ...admin,
  validate({ params: idParamSchema, body: updateEmployeeSchema }),
  asyncHandler(employeesController.update)
);
employeesRouter.delete("/:id", ...admin, validate({ params: idParamSchema }), asyncHandler(employeesController.remove));

employeesRouter.put(
  "/:id/services",
  ...admin,
  validate({ params: idParamSchema, body: setEmployeeServicesSchema }),
  asyncHandler(employeesController.setServices)
);

employeesRouter.put(
  "/:id/working-hours",
  ...admin,
  validate({ params: idParamSchema, body: setWorkingHoursSchema }),
  asyncHandler(employeesController.setWorkingHours)
);

// Reading time off is useful to anyone who works here - a stylist wants to
// see their own leave, the desk wants to know who is out. Writing it stays
// admin-only.
employeesRouter.get(
  "/:id/time-off",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema }),
  asyncHandler(employeesController.listTimeOff)
);

employeesRouter.post(
  "/:id/time-off",
  ...admin,
  validate({ params: idParamSchema, body: timeOffSchema }),
  asyncHandler(employeesController.addTimeOff)
);

/**
 * One stylist's progress against the daily completion quota.
 *
 * OPERATIONS: a stylist reads their own, the desk reads anyone's, and the
 * owner reads all. There is nothing private in it - a count of completed
 * clients is on the whiteboard anyway - and scoping it to "self only" would
 * mean the desk could not answer "has Bea finished her ten yet".
 */
employeesRouter.get(
  "/:id/quota",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema, query: quotaQuerySchema }),
  asyncHandler(employeesController.quota)
);

employeesRouter.get(
  "/:id/performance",
  authenticate,
  requireRole(...OWNER),
  validate({ params: idParamSchema, query: performanceQuerySchema }),
  asyncHandler(employeesController.performance)
);

// --- availability (public) -------------------------------------------------
availabilityRouter.get(
  "/",
  validate({ query: availabilityQuerySchema }),
  asyncHandler(employeesController.availability)
);
