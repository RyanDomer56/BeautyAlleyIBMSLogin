import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request } from "express";
import { CODES } from "../lib/errors";

/**
 * Rate limiters.
 *
 * The generic limiter is a blunt instrument against scraping and accidental
 * request storms. The stricter `loginLimiter` is deliberately *not* the
 * brute-force control - see the note in modules/auth for why the real lockout
 * is counted in the database rather than in this process's memory.
 */

const jsonError = {
  error: {
    code: CODES.RATE_LIMITED,
    message: "Too many requests. Please slow down and try again shortly.",
  },
};

export const apiLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: jsonError,
  // Health checks are polled by uptime monitors and should never be throttled.
  skip: (req: Request) => req.path === "/health",
});

export const loginLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: {
      code: CODES.RATE_LIMITED,
      message: "Too many sign-in attempts from this address. Try again in 15 minutes.",
    },
  },
});
