import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not forward a rejected promise to the error handler - an
 * `async` handler that throws leaves the request hanging until the client
 * times out. Every async route goes through this wrapper so a rejection
 * reaches `errorHandler` like any other error.
 *
 * Without it, the failure mode is the worst kind: a 500 in the logs and a
 * socket that never answers.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
