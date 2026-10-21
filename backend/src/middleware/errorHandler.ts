import type { NextFunction, Request, Response } from "express";
import { CODES, toAppError } from "../lib/errors";
import { logger } from "../lib/logger";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: CODES.NOT_FOUND,
      message: `No route matches ${req.method} ${req.path}`,
    },
  });
}

/**
 * The single exit point for every error.
 *
 * Response shape is `{ error: { code, message, details? } }` everywhere, so a
 * client only ever needs to parse one thing. Two rules are enforced here:
 *
 *   - A 5xx never carries a raw upstream message. Postgres errors name tables,
 *     columns and constraints, and can echo row values; those go to the log,
 *     not the wire.
 *   - The internal `cause` is always logged, so a 500 is diagnosable without
 *     reproducing it.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const appErr = toAppError(err);

  const logMeta = {
    method: req.method,
    path: req.path,
    status: appErr.status,
    code: appErr.code,
    actorId: req.actor?.id,
    cause: appErr.cause,
  };

  if (appErr.status >= 500) {
    logger.error(appErr.message, { ...logMeta, err: err instanceof Error ? err : String(err) });
  } else if (appErr.status >= 400 && appErr.status !== 404) {
    logger.warn(appErr.message, logMeta);
  } else {
    logger.debug(appErr.message, logMeta);
  }

  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: appErr.code, message: appErr.message },
  };
  if (appErr.details !== undefined) body.error.details = appErr.details;

  // `headersSent` guards against a second write if a stream already started.
  if (res.headersSent) return;
  res.status(appErr.status).json(body);
}
