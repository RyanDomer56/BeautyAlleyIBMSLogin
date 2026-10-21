import { Router } from "express";
import { z } from "zod";
import { tasksController } from "./tasks.controller";
import {
  createTaskSchema,
  idParamSchema,
  listTasksSchema,
  setTaskStatusSchema,
  updateTaskSchema,
} from "./tasks.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { DESK, OPERATIONS } from "../../lib/roleGroups";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";

export const tasksRouter = Router();

/*
 * Literal paths before `/:id`, as everywhere else in this API: Express matches
 * in declaration order, so `/tasks/mine` after `/tasks/:id` would be read as
 * the id "mine" and rejected by the uuid check with a 400.
 */

// --- the employee's own list ---------------------------------------------
// OPERATIONS, and scoped to the caller's own employee row in the service, so
// an employee cannot read a colleague's work by dropping the filter.
tasksRouter.get(
  "/mine",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ query: listTasksSchema }),
  asyncHandler(tasksController.mine),
);

// --- tile counts ----------------------------------------------------------
tasksRouter.get(
  "/counts",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ query: z.object({ employeeId: z.string().uuid().optional() }) }),
  asyncHandler(tasksController.counts),
);

// --- the board ------------------------------------------------------------
// One endpoint, correctly scoped: the desk sees every task, an employee sees
// only their own. A separate "all tasks" route would be a second way to ask
// the same question and a second place to get the scope wrong.
tasksRouter.get(
  "/",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ query: listTasksSchema }),
  asyncHandler(tasksController.list),
);

// --- assignment -----------------------------------------------------------
// DESK: the concierge dashboard writes the work. An employee assigning tasks
// to a colleague is not a thing this system is for.
tasksRouter.post(
  "/",
  authenticate,
  requireRole(...DESK),
  validate({ body: createTaskSchema }),
  asyncHandler(tasksController.create),
);

tasksRouter.get(
  "/:id",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema }),
  asyncHandler(tasksController.getById),
);

// --- the employee's own progress -----------------------------------------
// OPERATIONS, and narrowed in the service to a status change plus completion
// notes on a task the caller owns. A stylist cannot rename their own task or
// move it to someone else.
tasksRouter.patch(
  "/:id/status",
  authenticate,
  requireRole(...OPERATIONS),
  validate({ params: idParamSchema, body: setTaskStatusSchema }),
  asyncHandler(tasksController.setStatus),
);

// --- editing --------------------------------------------------------------
tasksRouter.patch(
  "/:id",
  authenticate,
  requireRole(...DESK),
  validate({ params: idParamSchema, body: updateTaskSchema }),
  asyncHandler(tasksController.update),
);

// --- cancelling -----------------------------------------------------------
// Its own route rather than a PATCH, so the destructive action is explicit at
// the call site and in the access log.
tasksRouter.post(
  "/:id/cancel",
  authenticate,
  requireRole(...DESK),
  validate({ params: idParamSchema }),
  asyncHandler(tasksController.cancel),
);
