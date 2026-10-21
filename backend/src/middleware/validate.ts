import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";
import { AppError, CODES } from "../lib/errors";

type Source = "body" | "query" | "params";

/**
 * Validates and *replaces* the request payload with the parsed result, so
 * downstream code works with typed, coerced values rather than raw strings.
 *
 * Query values arrive as strings - `?limit=20` is "20", not 20 - and zod's
 * `coerce` handles that here, once, instead of in every controller.
 */
export function validate(schemas: Partial<Record<Source, ZodTypeAny>>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const source of Object.keys(schemas) as Source[]) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) {
        return next(
          AppError.badRequest(CODES.VALIDATION_FAILED, "Request validation failed", {
            source,
            issues: result.error.issues.map((i) => ({
              path: i.path.join(".") || "(root)",
              message: i.message,
            })),
          })
        );
      }

      if (source === "body") {
        req.body = result.data;
      } else {
        // Express 4 exposes these as plain, writable properties.
        (req as unknown as Record<string, unknown>)[source] = result.data;
      }
    }
    next();
  };
}
