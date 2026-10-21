import { Router } from "express";
import type { Request, Response } from "express";
import { authRouter, adminAuthRouter } from "./modules/auth/auth.routes";
import { servicesRouter } from "./modules/services/services.routes";
import { availabilityRouter, employeesRouter } from "./modules/employees/employees.routes";
import { bookingsRouter, meRouter } from "./modules/bookings/bookings.routes";
import { qrRouter } from "./modules/qr/qr.routes";
import { promosRouter } from "./modules/promos/promos.routes";
import { roomsRouter } from "./modules/rooms/rooms.routes";
import { subcategoriesRouter } from "./modules/subcategories/subcategories.routes";
import { loyaltyRouter } from "./modules/loyalty/loyalty.routes";
import { attendanceRouter } from "./modules/attendance/attendance.routes";
import { tasksRouter } from "./modules/tasks/tasks.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { buildApiIndex } from "./lib/apiIndex";

/**
 * The API surface, in one place.
 *
 * Everything is mounted under /api/v1 except /health, which lives at the root
 * so an uptime monitor does not need to know the version.
 */
export const apiRouter = Router();

// The version root answers with the same index as `/`, so a caller who guesses
// `/api/v1` is not left at another dead end.
apiRouter.get("/", (_req: Request, res: Response) => {
  res.status(200).json({ data: buildApiIndex() });
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/services", servicesRouter);
apiRouter.use("/employees", employeesRouter);
apiRouter.use("/availability", availabilityRouter);
apiRouter.use("/bookings", bookingsRouter);
apiRouter.use("/me", meRouter);
apiRouter.use("/qr", qrRouter);
apiRouter.use("/promos", promosRouter);
apiRouter.use("/rooms", roomsRouter);
apiRouter.use("/service-subcategories", subcategoriesRouter);
apiRouter.use("/loyalty", loyaltyRouter);
apiRouter.use("/attendance", attendanceRouter);
apiRouter.use("/tasks", tasksRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/admin", adminAuthRouter);
