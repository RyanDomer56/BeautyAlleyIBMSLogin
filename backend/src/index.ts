/**
 * Entry point for Vercel's Express preset.
 *
 * ## The one rule this file exists to keep
 *
 * Nothing here may throw. Every failure below the try/catch - a missing
 * environment variable, a bad import, a dependency that will not load - has to
 * leave the process able to answer with a body that names it. A throw during
 * module initialisation is the platform's opaque `FUNCTION_INVOCATION_FAILED`:
 * no route matched, no log line of ours, not even the `x-request-id` header this
 * app sets on every response. That is unanswerable from a browser, and it is
 * why the failure fallback below is written in plain Node and does not call
 * `express()` again.
 *
 * ## Why `export =` and not `export default`
 *
 * This package is CommonJS (`"type": "commonjs"`), and the preset finds the app
 * by module shape: there it looks for `module.exports = app`. `export default`
 * compiles to `exports.default = app`, which it does not recognise, so the
 * function deploys with nothing to invoke. `export =` is TypeScript's spelling
 * of `module.exports = app`.
 *
 * The preset also sniffs a fixed set of filenames (`app`, `index`, `server`, at
 * the root or under `src/`) and treats the first one that imports express as
 * the entry. That is why the factory lives in `createApp.ts` rather than
 * `app.ts`: a second express-importing candidate beside this file is a coin
 * flip, and the losing side has no default export to hand over.
 *
 * ## Why `express` is resolved through the namespace
 *
 * `import express from "express"` assumes the compiler applies CommonJS
 * interop. When it does not - the file compiled as an ES module - the default
 * binding is `undefined`, `createApp()` throws `express is not a function`, and
 * the old fallback called `express()` again and died there, uncaught. Reading
 * the namespace and taking `default ?? namespace` works either way.
 *
 * There is deliberately no `listen` call - Vercel owns the server, and
 * `src/local.ts` is the entry for running one locally.
 */
import * as expressModule from "express";
import type { Express, Request, Response } from "express";
import { logger } from "./lib/logger";
import { createApp } from "./createApp";

/** Works whether the compiler emitted `require("express")` or an ESM default. */
const express = ((expressModule as unknown as { default?: typeof expressModule }).default ??
  expressModule) as unknown as typeof expressModule;

let app: Express;

try {
  app = createApp();
} catch (e) {
  const error = e instanceof Error ? e : new Error(String(e));
  logger.error("backend.init.failed", { message: error.message });

  /*
   * A hand-written handler rather than an Express app. The whole point of this
   * branch is that the app could not be built, so rebuilding part of it here
   * would throw a second time - and an uncaught throw at this level is exactly
   * the answerless 500 this branch exists to replace. Node's own
   * `http.ServerResponse` is enough for one JSON body.
   */
  app = ((_req: Request, res: Response) => {
    const body = JSON.stringify({
      error: { code: "BACKEND_INIT_FAILED", message: error.message },
    });
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  }) as unknown as Express;
}

export = app;
