import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError, CODES } from "../lib/errors";
import type { Role } from "../types/actor";

/**
 * Role gate. Always runs *after* `authenticate`, so a missing actor means the
 * middleware was mounted in the wrong order - which is a programming error, not
 * a client error, but it still must not fall through to the handler.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(AppError.unauthorized());

    if (!roles.includes(req.actor.role)) {
      return next(
        AppError.forbidden(
          CODES.INSUFFICIENT_ROLE,
          `This endpoint requires one of: ${roles.join(", ")}`
        )
      );
    }
    next();
  };
}

/**
 * Allows the request through when the caller is an owner of the resource, or
 * holds one of the listed staff roles.
 *
 * Used for "a client may cancel their own booking, and staff may cancel any".
 * Returning 404 rather than 403 when the caller has no relationship to the
 * resource avoids confirming that an id exists - the same reason GitHub returns
 * 404 for private repositories.
 */
export function requireOwnerOrRole(
  ownerId: () => string | null | undefined,
  ...roles: Role[]
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const actor = req.actor;
    if (!actor) return next(AppError.unauthorized());

    if (roles.includes(actor.role)) return next();

    const owner = ownerId();
    if (owner && actor.clientId && owner === actor.clientId) return next();

    return next(AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking"));
  };
}
