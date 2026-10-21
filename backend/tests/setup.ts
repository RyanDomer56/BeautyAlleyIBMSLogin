/**
 * Jest global setup.
 *
 * The integration suite talks to a real Supabase project, so this file's job
 * is to make "the environment is not configured" an explicit, loud skip
 * rather than a cascade of confusing 503s.
 *
 * The guard matters: without it, a missing service-role key turns every
 * authenticated test into a failure that looks like a code bug. That is the
 * single most expensive kind of red herring.
 */

import path from "path";
import dotenv from "dotenv";

// Loaded here as well as in src/config/env.ts, because these assertions run
// before any src module is imported. .env.local carries the real credentials
// and is read first; .env is the tracked template and fills in the gaps.
dotenv.config({
  path: [
    path.join(__dirname, "..", ".env.local"),
    path.join(__dirname, "..", ".env"),
  ],
});

// Tests must never accidentally run against production settings.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY"] as const;

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(
      `Missing ${key}. The tests run against a real Supabase project - ` +
        `copy backend/.env.example to backend/.env.local and fill it in.`
    );
  }
}

export const hasServiceRoleKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Printed once per process, not once per test file.
 *
 * `setupFilesAfterEnv` runs for every file, and with `--runInBand` every file
 * shares worker 1 - so a JEST_WORKER_ID check does not deduplicate it. A
 * marker on globalThis does.
 */
const flag = "__beautyAlleyServiceRoleWarned";
if (!hasServiceRoleKey && !(globalThis as Record<string, unknown>)[flag]) {
  (globalThis as Record<string, unknown>)[flag] = true;
  // eslint-disable-next-line no-console
  console.warn(
    "\n[test setup] SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
      "            Authenticated and write endpoints return 503 without it,\n" +
      "            so those integration suites are reported as SKIPPED.\n" +
      "            The unit suite and the public/RLS suites run in full.\n"
  );
}

jest.setTimeout(30_000);
