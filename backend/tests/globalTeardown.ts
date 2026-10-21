/**
 * Jest globalTeardown - runs once, after every suite has finished.
 *
 * ## Why this is not optional
 *
 * `globalSetup` seeds the database, which rebuilds `public.employees` from
 * scratch and then calls `relinkDemoProfiles()` to put the demo logins back.
 * That is necessary but not sufficient, because the suites run *after* it and
 * some of them legitimately borrow a seeded employee row:
 *
 *   - `tests/integration/qr.test.ts` calls `createTestStaff(EMP_ANA)` - the
 *     demo stylist - because a check-in test needs a real stylist with a real
 *     rota behind them.
 *   - `createTestStaff` does `update public.employees set profile_id = $1
 *     where id = $2`, which is correct for a test fixture and which
 *     *overwrites* the demo account's pointer.
 *   - The suite's `afterAll` then calls `deleteTestUsers()`, deleting that
 *     throwaway auth user. `employees.profile_id` references `profiles(id)`,
 *     which cascades from `auth.users`, so the delete nulls the pointer.
 *
 * Net effect, before this file existed: `npm test` passed, and left the
 * Employee demo login silently broken - the account still authenticated
 * perfectly but came back with `employeeId: null`, so `/attendance/me`,
 * `/tasks/mine` and `/attendance/summary` answered 403. The failure showed up
 * later, in the browser, and looked like an app bug.
 *
 * ## What it does
 *
 * The same repair the seed performs, run once more at the end so the database
 * is left in a state a human can actually sign in to. It is best-effort and
 * never throws: a teardown that fails a green test run is worse than the
 * problem it fixes.
 */
import path from "path";
import dotenv from "dotenv";

export default async function globalTeardown() {
  // Same precedence as globalSetup: `.env.local` holds the real credentials.
  dotenv.config({
    path: [
      path.join(__dirname, "..", ".env.local"),
      path.join(__dirname, "..", ".env"),
    ],
  });

  if (!process.env.DATABASE_URL) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { relinkDemoProfiles } = require("../scripts/seed.js");

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    // `relinkDemoProfiles` reports through the logger it is handed; capture the
    // line so the run says whether anything actually had to be repaired.
    const messages: string[] = [];
    await relinkDemoProfiles(client, (msg: string) => messages.push(msg));
    // eslint-disable-next-line no-console
    console.log(
      `[globalTeardown] demo account links re-checked${messages.length ? ` - ${messages.join("; ")}` : " - all intact"}`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[globalTeardown] could not re-link demo accounts: ${(err as Error).message}`
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
