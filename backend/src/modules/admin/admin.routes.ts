import { Router } from "express";
import { adminController } from "./admin.controller";
import {
  dashboardQuerySchema,
  idParamSchema,
  listAuditLogsQuerySchema,
  listClientsQuerySchema,
  updateClientSchema,
} from "./admin.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

// Reporting endpoints reuse the list controllers from the other modules rather
// than reimplementing them, so there is exactly one definition of "list
// bookings" in the codebase.
import { bookingsController } from "../bookings/bookings.controller";
import { employeesController } from "../employees/employees.controller";
import { promosController } from "../promos/promos.controller";
import { listBookingsQuerySchema } from "../bookings/bookings.schemas";
import { listEmployeesSchema } from "../employees/employees.schemas";
import { listPromosQuerySchema } from "../promos/promos.schemas";

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole("ADMIN"));

adminRouter.get("/dashboard", validate({ query: dashboardQuerySchema }), asyncHandler(adminController.dashboard));

// --- clients ---------------------------------------------------------------
// The literal route is declared before the parameterised one: Express matches
// in declaration order, so `/clients/export.csv` would otherwise be captured
// by `/clients/:id` and fail uuid validation.
adminRouter.get("/clients/export.csv", asyncHandler(adminController.exportClients));
adminRouter.get("/clients", validate({ query: listClientsQuerySchema }), asyncHandler(adminController.listClients));
adminRouter.get("/clients/:id", validate({ params: idParamSchema }), asyncHandler(adminController.getClient));
adminRouter.patch(
  "/clients/:id",
  validate({ params: idParamSchema, body: updateClientSchema }),
  asyncHandler(adminController.updateClient)
);
adminRouter.delete("/clients/:id", validate({ params: idParamSchema }), asyncHandler(adminController.removeClient));

// --- cross-module reporting ------------------------------------------------
adminRouter.get("/bookings", validate({ query: listBookingsQuerySchema }), asyncHandler(bookingsController.list));
adminRouter.get("/employees", validate({ query: listEmployeesSchema }), asyncHandler(employeesController.list));
adminRouter.get("/promos", validate({ query: listPromosQuerySchema }), asyncHandler(promosController.list));

// --- audit -----------------------------------------------------------------
adminRouter.get("/audit-logs", validate({ query: listAuditLogsQuerySchema }), asyncHandler(adminController.listAuditLogs));
