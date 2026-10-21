import { Router } from "express";
import { authController } from "./auth.controller";
import {
  createStaffSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
} from "./auth.schemas";
import { authenticate } from "../../middleware/authenticate";
import { requireRole } from "../../middleware/requireRole";
import { validate } from "../../middleware/validate";
import { asyncHandler } from "../../lib/asyncHandler";
import { loginLimiter } from "../../middleware/rateLimit";

export const authRouter = Router();

authRouter.post("/register", validate({ body: registerSchema }), asyncHandler(authController.register));

// The limiter sits in front of validation so a flood is rejected before it
// costs a zod parse.
authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(authController.login)
);

authRouter.post("/refresh", validate({ body: refreshSchema }), asyncHandler(authController.refresh));

authRouter.post("/logout", authenticate, asyncHandler(authController.logout));
authRouter.get("/me", authenticate, asyncHandler(authController.me));

export const adminAuthRouter = Router();

adminAuthRouter.post(
  "/users/staff",
  authenticate,
  requireRole("ADMIN"),
  validate({ body: createStaffSchema }),
  asyncHandler(authController.createStaff)
);
