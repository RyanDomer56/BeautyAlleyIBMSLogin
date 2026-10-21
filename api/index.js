/**
 * The API as a Vercel function.
 *
 * The Express app is compiled to `backend/dist` by the project's build command
 * (`npm run build` there), and this file is the seam between the platform and
 * it. It is deliberately tiny and has no dependencies of its own: the platform
 * packages it before anything else can go wrong, and if the compiled app is
 * missing it says so instead of dying.
 *
 * ## Why the loader is guarded
 *
 * A function that throws while loading answers with the platform's bare
 * `FUNCTION_INVOCATION_FAILED` - no route, no log line, and not even the
 * `x-request-id` header the app sets on every response. That is unanswerable
 * from a browser, and it cost this deployment a day. The try/catch below turns
 * the same failure into a JSON body that names the module.
 *
 * ## Why `createRequire`
 *
 * The repository root is an ES module package (`"type": "module"`), so this file
 * is one too. `require` is not defined in an ES module, and the compiled app is
 * CommonJS - `createRequire` bridges the two without a second package.json.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let app;

try {
  app = require("../backend/dist/index.js");
} catch (e) {
  const message = e && e.message ? e.message : String(e);
  console.error(
    JSON.stringify({ level: "error", msg: "backend.init.failed", message })
  );

  app = (_req, res) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({ error: { code: "BACKEND_INIT_FAILED", message } })
    );
  };
}

export default app;
