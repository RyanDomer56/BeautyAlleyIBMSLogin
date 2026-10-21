import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { env, assertEnv, hasServiceRoleKey } from "./config/env";
import { apiRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiLimiter } from "./middleware/rateLimit";
import { requireServiceRole } from "./db/supabase";
import { logger } from "./lib/logger";
import { buildApiIndex } from "./lib/apiIndex";

/**
 * The built frontend, as `vite build` leaves it at the repo root.
 *
 * Resolved from `__dirname`, which is `backend/dist` when compiled and
 * `backend/src` under ts-jest - both sit one level below `backend`, so `..`
 * twice lands on the repo root either way.
 */
// `__dirname` is absent when the entry is compiled as an ES module, and a
// ReferenceError here is a module-initialisation crash, not a request error.
// Nothing serves static files in that shape (SERVE_APP is off on Vercel), so
// falling back to the working directory is enough to keep the module loadable.
const HERE = typeof __dirname === "string" ? __dirname : process.cwd();
const FRONTEND_DIST = path.join(HERE, "..", "..", "dist");

/**
 * The version reported by `/health`.
 *
 * An incident is much easier to place when you know which release was running.
 * `APP_VERSION` wins so a CI job can stamp the commit SHA without editing
 * package.json; otherwise the package version is used. Never throws - a health
 * endpoint that crashes because a file moved is worse than one that says
 * "unknown".
 */
const VERSION: string = (() => {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * Cached GoTrue reachability.
 *
 * The auth health check is a network round trip (~900ms to a hosted project),
 * and a readiness probe may be called far more often than the auth service
 * deserves to be. Caching for a few seconds keeps `/health` cheap without
 * making it stale enough to miss an outage: a load balancer polling every 30s
 * still sees a recovery within one interval.
 *
 * Failures are cached too - a down auth service should not be hammered by the
 * very probes that are trying to detect it being down.
 */
const AUTH_CHECK_TTL_MS = 5_000;
let authCheckCache: { ok: boolean; detail: string; at: number } | null = null;

async function checkAuthService(): Promise<{ ok: boolean; detail: string }> {
  if (authCheckCache && Date.now() - authCheckCache.at < AUTH_CHECK_TTL_MS) {
    return { ok: authCheckCache.ok, detail: authCheckCache.detail };
  }

  let result: { ok: boolean; detail: string };
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/health`, {
      headers: { apikey: env.supabaseAnonKey },
      // Bounded so a hung auth service cannot hang the probe and, through it,
      // the orchestrator.
      signal: AbortSignal.timeout(3000),
    });
    result = res.ok ? { ok: true, detail: "ok" } : { ok: false, detail: `error ${res.status}` };
  } catch {
    result = { ok: false, detail: "error" };
  }

  authCheckCache = { ...result, at: Date.now() };
  return result;
}

export function createApp() {
  // Refuse to build an app on a broken configuration. This is a no-op when the
  // environment parsed, and the throw is caught by the Vercel entry (which
  // turns it into a JSON 500 naming the variable) or crashes `local.ts` on
  // purpose. See the note on `FALLBACK` in config/env.ts for why the check
  // lives here rather than at module scope.
  assertEnv();

  const app = express();

  // Behind a load balancer, `req.ip` is the proxy's address unless Express is
  // told to read X-Forwarded-For. That matters here because the login limiter
  // keys on it: with this off, every request looks like it came from the same
  // place and the limiter locks out the whole world at once.
  //
  // Set to 1 (trust exactly one hop) rather than `true`, which would trust a
  // client-supplied X-Forwarded-For and let anyone forge their own IP.
  app.set("trust proxy", 1);

  app.disable("x-powered-by");

  app.use(
    helmet({
      // A content security policy only matters where HTML is served. This
      // process is normally a JSON API, so the browser-facing defaults are
      // noise - but with SERVE_APP it also serves the built frontend, and
      // there a CSP is the main defence against an injected script reading the
      // session out of localStorage.
      //
      // The directives below are derived from what `dist/index.html` actually
      // loads: local hashed JS/CSS, Google Fonts, a local hero video, and
      // inline style attributes from Radix/React. `connect-src 'self'` assumes
      // the single-origin setup SERVE_APP implies; if you serve the app from a
      // different origin, add that API origin here.
      contentSecurityPolicy: env.serveApp
        ? {
            directives: {
              defaultSrc: ["'self'"],
              baseUri: ["'self'"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
              formAction: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
              fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
              imgSrc: ["'self'", "data:", "blob:"],
              mediaSrc: ["'self'", "blob:"],
              connectSrc: ["'self'"],
              // html5-qrcode spins up a blob worker for the camera decoder.
              workerSrc: ["'self'", "blob:"],
            },
          }
        : false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  app.use(
    cors({
      // With no ALLOWED_ORIGINS set, `true` reflects the request origin -
      // appropriate while the front end is served from a different port in
      // development. Once ALLOWED_ORIGINS is set it becomes the allow-list,
      // which is what a publicly reachable API must have.
      // A missing Origin header (curl, server-to-server) is always allowed:
      // it is not a browser, so CORS does not protect it in the first place.
      //
      // Production with neither an allow-list nor SERVE_APP does not reach
      // here: env.ts refuses to boot in that combination, because reflecting
      // any origin with credentials is how a stray page reads a session.
      origin: env.allowedOrigins.length
        ? (origin, callback) => callback(null, !origin || env.allowedOrigins.includes(origin))
        : true,
      credentials: true,
      exposedHeaders: ["Content-Disposition"],
    })
  );

  // A 100kb body cap. The largest legitimate payload is a booking with a
  // handful of service ids - anything bigger is a mistake or an attack.
  app.use(express.json({ limit: "100kb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));

  app.use(apiLimiter);

  /**
   * Correlation id.
   *
   * Without one, "the booking failed at 14:02" is unanswerable: every line in
   * the log looks the same and nothing ties a client error to the server work
   * it caused. An inbound `x-request-id` is honoured (so a proxy or the client
   * can supply its own) but validated first - it is echoed into a response
   * header and into every log line, so an unvalidated value is a log-forging
   * and header-injection vector.
   */
  app.use((req: Request, res: Response, next) => {
    const inbound = req.get("x-request-id");
    const requestId =
      inbound && /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  // Request logging. The logger redacts credentials, so this cannot leak the
  // bearer token in the Authorization header.
  //
  // Level is chosen so that production keeps a usable access log: `debug` is
  // below the production threshold, so logging every 2xx at `debug` meant a
  // deployed server recorded no successful request at all. Failures are logged
  // everywhere, because a 4xx in development is usually the bug being fixed.
  app.use((req: Request, res: Response, next) => {
    const started = Date.now();
    res.on("finish", () => {
      const meta = {
        requestId: res.locals.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      };
      if (res.statusCode >= 500) logger.error("http.request", meta);
      else if (res.statusCode >= 400) logger.warn("http.request", meta);
      else if (env.isProduction) logger.info("http.request", meta);
      else logger.debug("http.request", meta);
    });
    next();
  });

  /**
   * Liveness. Deliberately does no I/O.
   *
   * An orchestrator should restart the process when this fails, and nothing
   * else. If liveness queried the database, a slow database would cause a
   * restart loop that fixes nothing and makes the outage worse.
   */
  app.get("/health/live", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", version: VERSION });
  });

  /**
   * Readiness.
   *
   * Reports whether this instance can actually serve a request: the
   * service-role key is present, Postgres answers, and GoTrue answers. The
   * auth check matters because every authenticated route depends on it, and a
   * deployment with a healthy database and an unreachable auth service looks
   * fine until the first sign-in.
   */
  app.get("/health", async (_req: Request, res: Response) => {
    const checks: Record<string, unknown> = {
      serviceRoleKey: hasServiceRoleKey,
      timezone: env.branchTimezone,
    };

    let ok = true;

    if (hasServiceRoleKey) {
      try {
        const db = requireServiceRole();
        const { error } = await db.from("services").select("id", { head: true, count: "exact" }).limit(1);
        checks.database = error ? "error" : "ok";
        if (error) ok = false;
      } catch {
        checks.database = "error";
        ok = false;
      }
    } else {
      checks.database = "unconfigured";
    }

    // GoTrue's own health endpoint, cached briefly - see checkAuthService.
    const auth = await checkAuthService();
    checks.auth = auth.detail;
    if (!auth.ok) ok = false;

    res.status(ok ? 200 : 503).json({
      status: ok ? "ok" : "degraded",
      env: env.nodeEnv,
      version: VERSION,
      checks,
    });
  });

  /**
   * Service index.
   *
   * The root of a backend-only service is otherwise a dead end: a browser
   * pointed at the port gets a bare `NOT_FOUND`, which reads as "broken" when
   * the service is healthy and simply has no page there. This is JSON, not
   * HTML - the brief is backend-only, and a landing page would put a
   * browser-facing surface on a service that is not meant to have one.
   *
   * When `SERVE_APP` is on, the root belongs to the frontend instead, and this
   * index stays reachable at `/api/v1` (which answers with the identical body,
   * by design - see routes.ts).
   */
  if (!env.serveApp) {
    app.get("/", (_req: Request, res: Response) => {
      res.status(200).json({ data: buildApiIndex() });
    });
  }

  app.use("/api/v1", apiRouter);

  /**
   * Optionally serve the built frontend from this same process.
   *
   * Enabled by `SERVE_APP=true`, which is what the self-hosted container sets.
   * One origin then carries both the app and the API - the same arrangement the
   * Vercel deployment gets from `vercel.json`, where a rewrite puts `/api/*`
   * and `/health` in front of the static app. That matters because a
   * single-origin deployment has no CORS to configure and no `VITE_API_URL`
   * baked into the bundle that can go stale.
   */
  if (env.serveApp) {
    const indexHtml = path.join(FRONTEND_DIST, "index.html");

    if (fs.existsSync(indexHtml)) {
      app.use(
        express.static(FRONTEND_DIST, {
          // `/` is handled below, so that a request for the root is answered by
          // the same code path as any other client-side route.
          index: false,
          setHeaders: (res, filePath) => {
            const rel = path.relative(FRONTEND_DIST, filePath).split(path.sep).join("/");
            if (rel === "index.html") {
              // The entry point must never be cached: it names the hashed
              // bundles, so a stale copy pins the browser to an old build.
              res.setHeader("Cache-Control", "no-store");
            } else if (rel.startsWith("assets/")) {
              // Vite fingerprints these filenames, so a change is a new URL.
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            }
          },
        })
      );

      // SPA fallback. Anything that is not the API and not a file on disk is a
      // client-side route (`/app/bookings`, `/pass/:id`, `/services`), so it
      // gets the shell and the router takes it from there.
      //
      // The API and /health are excluded explicitly. Without that guard an
      // unknown `/api/v1/nope` would return index.html with a 200, and a typo
      // in a client would look like a successful call that parsed as HTML.
      app.use((req: Request, res: Response, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        if (req.path === "/health" || req.path.startsWith("/api/")) return next();
        // `no-store` is set here rather than left to `sendFile`'s default
        // (`max-age=0`, which still allows a cached copy to be reused on a
        // revalidation failure). The entry point names the hashed bundles, so
        // a stale one pins the browser to an old build after a redeploy.
        res.sendFile(indexHtml, { headers: { "Cache-Control": "no-store" } }, (err) =>
          err ? next() : undefined
        );
      });

      logger.info("app.static", { dir: FRONTEND_DIST });
    } else {
      // Loud, because the alternative is a container that serves the JSON API
      // index at `/` and looks like the frontend was never deployed.
      logger.warn("app.static.missing", {
        dir: FRONTEND_DIST,
        hint: "SERVE_APP is on but the frontend build is missing - run `npm run build` at the repo root.",
      });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
