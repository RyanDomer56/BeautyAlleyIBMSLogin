/**
 * Local development entry. Starts a real listener.
 *
 * Kept out of `index.ts` so the Vercel entry is nothing but a default export:
 * the platform manages its own server, and a stray `listen` in that module
 * only invites the preset to guess at what it should do.
 */
import app from "./index";
import { env, envError, hasServiceRoleKey } from "./config/env";
import { logger } from "./lib/logger";

// The Vercel entry catches a bad configuration and answers every request with a
// JSON 500. A real listener has no such luxury, and must not pretend to be up:
// `index.ts` has already logged which variable is wrong, so just refuse to
// start.
if (envError) process.exit(1);

const listener = app.listen(env.port, () => {
  logger.info("server.started", { port: env.port, env: env.nodeEnv });

  // Said out loud at boot rather than discovered on the first 503. Half the
  // API is unusable without this key, and the failure would otherwise surface
  // as an opaque error much later. Kept here rather than in `index.ts` because
  // it is a local-runner concern: on Vercel the variable comes from the
  // platform, and a missing one is reported by the init catch instead.
  if (!hasServiceRoleKey) {
    logger.warn(
      "SUPABASE_SERVICE_ROLE_KEY is not set - authenticated and write endpoints will return 503. " +
        "Add it to backend/.env and restart."
    );
  }
});

function shutdown(signal: string) {
  logger.info("server.shutdown", { signal });
  listener.close(() => process.exit(0));
  // Do not hang forever on a stuck keep-alive connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
