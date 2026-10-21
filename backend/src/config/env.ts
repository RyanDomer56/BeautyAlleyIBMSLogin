import path from "path";
import dotenv from "dotenv";
import { z } from "zod";

/**
 * Where this module's directory is, when the runtime tells us.
 *
 * `__dirname` exists in CommonJS and does not exist at all in an ES module -
 * referring to it there is a ReferenceError, thrown while the module is being
 * initialised, i.e. before any of the request handling below can catch it. A
 * platform that compiles this entry to ESM (Vercel's Express preset does) would
 * therefore kill the function on every request with an error that names
 * nothing. `typeof` is safe on an undeclared identifier, so the guard costs
 * one comparison and removes the whole failure mode.
 *
 * When it is unavailable there is nothing to load: a bundled function is
 * configured by the platform's environment variables, not by a file next to
 * the bundle. `process.cwd()` is the honest stand-in for "somewhere a .env may
 * sit" without pretending to know the bundle layout.
 */
const HERE = typeof __dirname === "string" ? __dirname : process.cwd();

// Resolved from the compiled location (dist/config) or the source location
// (src/config) - both sit two levels below the project root.
//
// .env.local holds the real credentials and is gitignored; it is read first so
// it wins. .env is tracked and carries placeholders only, so a fresh clone can
// still start and will fail loudly on the missing values rather than silently
// running against someone else's project.
dotenv.config({
  path: [
    path.join(HERE, "..", "..", ".env.local"),
    path.join(HERE, "..", "..", ".env"),
  ],
});

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  SUPABASE_URL: z.string().url("SUPABASE_URL must be a full https URL"),

  // Supabase now issues `sb_publishable_...` / `sb_secret_...` keys in place of
  // the legacy `anon` / `service_role` JWTs. Both formats are accepted here -
  // the SDK handles either - so this only checks that something was supplied.
  SUPABASE_ANON_KEY: z.string().min(20, "SUPABASE_ANON_KEY looks too short"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional().or(z.literal("")),

  // Only used by scripts/migrate.js and scripts/verify.js.
  DATABASE_URL: z.string().optional(),

  BRANCH_TIMEZONE: z.string().default("Asia/Manila"),
  CANCELLATION_WINDOW_HOURS: z.coerce.number().int().nonnegative().default(2),

  // Comma-separated browser origins allowed to call the API with cookies.
  // Empty keeps the development behaviour (reflect any origin); set it the
  // moment the API is reachable from the public internet - a Vercel deployment,
  // or a container behind a proxy.
  ALLOWED_ORIGINS: z.string().optional().default(""),

  // Serve the built frontend from this process as well, so one origin carries
  // both the app and the API. That is what the self-hosted container turns on:
  // a single public URL, no CORS, and no `VITE_API_URL` to keep in sync.
  // Leave it off on Vercel, where the frontend is its own service.
  //
  // Deliberately NOT `z.coerce.boolean()`: that runs `Boolean(value)`, and
  // `Boolean("false")` is `true` - so `SERVE_APP=false` would switch it ON.
  SERVE_APP: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  QR_SIGNING_SECRET: z
    .string()
    .min(32, "QR_SIGNING_SECRET must be at least 32 chars"),
  QR_CHECKIN_WINDOW_MINUTES: z.coerce.number().int().nonnegative().default(60),

  // Where a scanned QR pass points. Defaults to the branch check-in page.
  QR_CHECKIN_URL: z.string().url().default("https://beautyalley.app/check-in"),

  // The walk-in door QR. A different sticker from the desk check-in QR: this
  // one starts a registration, the other redeems an existing pass.
  BRANCH_ID: z.string().trim().min(1).default("beautyalley-main"),
  QR_ENTER_URL: z.string().url().default("https://beautyalley.app/welcome"),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
});

type EnvShape = z.infer<typeof schema>;

/**
 * Values used when the environment is invalid, so that *importing* this module
 * never throws.
 *
 * That matters on a serverless platform. The entry point wraps `createApp()` in
 * a try/catch precisely so a misconfigured deployment answers with a 500 that
 * names the missing variable. But a bundler is free to hoist this module's
 * top-level code into the bundle's prologue - outside that try/catch - and then
 * the same misconfiguration surfaces as Vercel's opaque
 * `FUNCTION_INVOCATION_FAILED` with no hint of the cause.
 *
 * So the failure is *recorded* here and *raised* by `assertEnv()`, which every
 * real boot path calls: `createApp()` on Vercel, `local.ts` on a container or a
 * laptop. The loud failure is preserved, just moved to where it can be caught
 * and reported. Nothing serves a request with these values - `assertEnv()`
 * throws first - they only keep `createClient()` from throwing at import.
 */
const FALLBACK: EnvShape = {
  NODE_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
  PORT: 4000,
  SUPABASE_URL: "http://localhost:54321",
  SUPABASE_ANON_KEY: "unconfigured-anon-key-placeholder",
  SUPABASE_SERVICE_ROLE_KEY: "",
  DATABASE_URL: undefined,
  BRANCH_TIMEZONE: "Asia/Manila",
  CANCELLATION_WINDOW_HOURS: 2,
  ALLOWED_ORIGINS: "",
  SERVE_APP: false,
  QR_SIGNING_SECRET: "unconfigured-qr-signing-secret-placeholder",
  QR_CHECKIN_WINDOW_MINUTES: 60,
  QR_CHECKIN_URL: "https://beautyalley.app/check-in",
  BRANCH_ID: "beautyalley-main",
  QR_ENTER_URL: "https://beautyalley.app/welcome",
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_LOCKOUT_MINUTES: 15,
};

const parsed = schema.safeParse(process.env);

/**
 * Why the process must not serve traffic, or `null` when the configuration is
 * usable. Built once, thrown by `assertEnv()`.
 */
export const envError: Error | null = (() => {
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`
    );
    return new Error(
      `Invalid environment configuration:\n${lines.join("\n")}\n\n` +
        `Copy .env.example to .env and fill it in.`
    );
  }

  // A public API must never reflect an arbitrary origin while allowing
  // credentials. In development that behaviour is a convenience; in production
  // it is a hole. Two configurations are safe:
  //
  //   - an explicit ALLOWED_ORIGINS allow-list, or
  //   - SERVE_APP, where the app and the API share one origin and CORS is not
  //     involved at all.
  //
  // Anything else stops the boot, because a boot failure is a five-second fix
  // and a silently permissive production API is not.
  if (
    parsed.data.NODE_ENV === "production" &&
    parsed.data.ALLOWED_ORIGINS.trim() === "" &&
    parsed.data.SERVE_APP !== true
  ) {
    return new Error(
      "Invalid environment configuration:\n" +
        "  - ALLOWED_ORIGINS is empty in production, so the API would reflect any\n" +
        "    origin with credentials.\n\n" +
        "Set ALLOWED_ORIGINS to the deployed frontend origin(s), or set\n" +
        "SERVE_APP=true to serve the app from this same origin."
    );
  }

  return null;
})();

/** Throws `envError` if the environment is unusable. Call before serving. */
export function assertEnv(): void {
  if (envError) throw envError;
}

const data: EnvShape = parsed.success ? parsed.data : FALLBACK;

export const env = {
  nodeEnv: data.NODE_ENV,
  isProduction: data.NODE_ENV === "production",
  isTest: data.NODE_ENV === "test",
  port: data.PORT,

  supabaseUrl: data.SUPABASE_URL,
  supabaseAnonKey: data.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: data.SUPABASE_SERVICE_ROLE_KEY || "",

  databaseUrl: data.DATABASE_URL || "",

  branchTimezone: data.BRANCH_TIMEZONE,
  cancellationWindowHours: data.CANCELLATION_WINDOW_HOURS,

  allowedOrigins: data.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  serveApp: data.SERVE_APP,

  qrSigningSecret: data.QR_SIGNING_SECRET,
  qrCheckinWindowMinutes: data.QR_CHECKIN_WINDOW_MINUTES,
  qrCheckInUrl: data.QR_CHECKIN_URL,
  branchId: data.BRANCH_ID,
  qrEnterUrl: data.QR_ENTER_URL,

  loginMaxAttempts: data.LOGIN_MAX_ATTEMPTS,
  loginLockoutMinutes: data.LOGIN_LOCKOUT_MINUTES,
};

export const hasServiceRoleKey = env.supabaseServiceRoleKey.length > 0;
