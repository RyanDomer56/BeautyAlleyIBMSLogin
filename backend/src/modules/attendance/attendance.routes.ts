import { Router } from "express";
import { attendanceController } from "./attendance.controller";
import {
  amendAttendanceSchema,
  clockInSchema,
  clockOutSchema,
  idParamSchema,
  listAttendanceSchema,
} from "./attendance.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { DESK, OPERATIONS } from "../../lib/roleGroups";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

export const attendanceRouter = Router();

/*
 * Everything here is behind a token, and the literal paths come before `/:id`.
 *
 * Express matches in declaration order, so `/attendance/me` declared after
 * `/attendance/:id` would be read as the id "me" and rejected by the uuid check
 * with a 400. This is the same ordering trap `/employees/quotas` documents.
 */

// --- the caller's own standing -------------------------------------------
// OPERATIONS, not DESK: this is the employee's own page and it reads only their
// own row, so every role that works the floor may call it.
attendanceRouter.get(
  "/me",
  authenticate,
  requireRole(...OPERATIONS),
  asyncHandler(attendanceController.me),
);

// --- totals for a range ---------------------------------------------------
attendanceRouter.get(
  "/summary",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ query: listAttendanceSchema }),
  asyncHandler(attendanceController.summary),
);

// --- history --------------------------------------------------------------
// An employee sees their own records; the desk and the owner see everyone's.
// The scope is applied in the service, not read from the query string.
attendanceRouter.get(
  "/",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ query: listAttendanceSchema }),
  asyncHandler(attendanceController.list),
);

// --- clocking -------------------------------------------------------------
// The server writes both timestamps. `employeeId` is honoured only for the
// desk; an employee's own record is taken from their token.
attendanceRouter.post(
  "/clock-in",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ body: clockInSchema }),
  asyncHandler(attendanceController.clockIn),
);

attendanceRouter.post(
  "/clock-out",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ body: clockOutSchema }),
  asyncHandler(attendanceController.clockOut),
);

// --- one record -----------------------------------------------------------
attendanceRouter.get(
  "/:id",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema }),
  asyncHandler(attendanceController.getById),
);

// --- correction -----------------------------------------------------------
// DESK: reception fixes a forgotten time-out, or files a day of leave. An
// employee amending their own hours is not a self-service action, so this is
// deliberately narrower than the reads above.
attendanceRouter.patch(
  "/:id",
  authenticate,
  requireRole(...DESK),
  validate({ params: idParamSchema, body: amendAttendanceSchema }),
  asyncHandler(attendanceController.amend),
);
