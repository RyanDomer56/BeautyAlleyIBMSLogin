import request from "supertest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Express } from "express";
import { createApp } from "../../src/createApp";
import { db } from "./db";

/**
 * Test harness for the HTTP layer.
 *
 * `createApp()` is called fresh per suite so a rate limiter's in-memory
 * counter does not leak between files - otherwise a suite that deliberately
 * floods /auth/login would lock out an unrelated suite running after it.
 */
let app: Express | null = null;

export function api(): Express {
  if (!app) app = createApp();
  return app;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  role: "CLIENT" | "EMPLOYEE" | "CONCIERGE" | "ADMIN";
  clientId?: string | null;
  employeeId?: string | null;
}

const supabaseAdmin = (): SupabaseClient =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

let seq = 0;
function uniqueEmail(prefix: string) {
  seq += 1;
  return `${prefix}.${Date.now()}.${seq}@beautyalley.ph`;
}

// ---------------------------------------------------------------------------
// Rate limiting
//
// The API validates bearer tokens by asking GoTrue (`auth.getUser`) rather than
// by verifying the signature locally, so every fixture needs a real session -
// two requests to the hosted auth service, one to create the user and one to
// sign it in. The hosted service refuses bursts with
// `over_request_rate_limit`, which turned a suite of 195 tests into a run that
// failed halfway through with "Request rate limit reached": a failure with
// nothing to do with the code under test.
//
// Two mitigations. The fixture cache below cuts the number of requests
// dramatically; the retry here turns any residual limiting into a slow test
// rather than a false failure.
// ---------------------------------------------------------------------------

const RATE_LIMIT_BACKOFF_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 60_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimited = (error: { status?: number; code?: string } | null | undefined) =>
  error?.status === 429 || error?.code === "over_request_rate_limit";

/**
 * Retry an auth call while GoTrue is refusing it for rate-limit reasons.
 *
 * Only 429s are retried. Anything else - a duplicate email, a weak password -
 * is a genuine failure and is thrown immediately, so a broken fixture is never
 * disguised as a slow one.
 */
async function withRateLimitRetry<T extends { error: { status?: number; code?: string; message: string } | null }>(
  label: string,
  call: () => Promise<T>
): Promise<T> {
  let lastMessage = "";

  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF_MS.length; attempt++) {
    const result = await call();
    if (!result.error) return result;

    if (!isRateLimited(result.error)) {
      throw new Error(`${label} failed: ${result.error.message}`);
    }

    lastMessage = result.error.message;
    if (attempt < RATE_LIMIT_BACKOFF_MS.length) {
      await sleep(RATE_LIMIT_BACKOFF_MS[attempt]);
    }
  }

  throw new Error(
    `${label} was rate limited by GoTrue (${lastMessage}) and did not recover after ` +
      `${RATE_LIMIT_BACKOFF_MS.length} retries. The hosted auth service has a per-window cap on ` +
      `token requests; reduce fixture churn or re-run once the window has passed.`
  );
}

/**
 * Fixture cache.
 *
 * Jest gives every test file its own module registry, so this map is
 * effectively per-suite: the first call for a given key creates the account,
 * later calls in the same suite get the same identity back.
 *
 * This is not only an optimisation. Creating a fresh admin for each of the
 * twenty tests in admin.test.ts cost forty requests to the hosted auth service
 * on fixtures alone. Sharing them is safe because no test mutates a fixture:
 * `createTestClient` still mints a distinct `clients` row per name, and the
 * ownership tests ask for differently-named clients.
 */
const fixtures = new Map<string, Promise<TestUser>>();

function once(key: string, make: () => Promise<TestUser>): Promise<TestUser> {
  const existing = fixtures.get(key);
  if (existing) return existing;
  const created = make();
  fixtures.set(key, created);
  return created;
}

/**
 * Create a user with a known role and a working session.
 *
 * Goes through the admin API rather than /auth/register because the project
 * has email confirmation enabled, and a self-registered account gets no
 * session until the address is confirmed - which a test cannot do.
 *
 * The role is set in `app_metadata`, which is the only field the
 * `handle_new_auth_user` trigger reads for the role and which a user cannot
 * write themselves.
 */
export async function createTestUser(opts: {
  role: "CLIENT" | "EMPLOYEE" | "CONCIERGE" | "ADMIN";
  email?: string;
  fullName?: string;
  password?: string;
}): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail(opts.role.toLowerCase());
  const password = opts.password ?? "TestPass123!";
  const admin = supabaseAdmin();

  const created = await withRateLimitRetry("createTestUser(createUser)", () =>
    admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: opts.role },
      user_metadata: { full_name: opts.fullName ?? `${opts.role} Tester` },
    })
  );
  if (!created.data.user) throw new Error("createTestUser: no user returned");

  const signedIn = await withRateLimitRetry("createTestUser(signIn)", () =>
    admin.auth.signInWithPassword({ email, password })
  );
  if (!signedIn.data.session) throw new Error("createTestUser: sign-in returned no session");

  return {
    id: created.data.user.id,
    email,
    password,
    token: signedIn.data.session.access_token,
    role: opts.role,
  };
}

/**
 * A CLIENT user with a linked `clients` row, ready to own bookings.
 *
 * Cached by name within the suite - see the note on `fixtures`. Pass a distinct
 * `fullName` when a test needs two clients that must not be the same account.
 */
export function createTestClient(fullName = "Test Client"): Promise<TestUser> {
  return once(`CLIENT:${fullName}`, async () => {
    const user = await createTestUser({ role: "CLIENT", fullName });
    const { rows } = await db().query(
      `insert into public.clients (profile_id, full_name, email)
       values ($1, $2, $3)
       returning id`,
      [user.id, fullName, user.email]
    );
    user.clientId = rows[0].id;
    return user;
  });
}

/** An ADMIN user. Cached per suite. */
export function createTestAdmin(fullName = "Test Admin"): Promise<TestUser> {
  return once(`ADMIN:${fullName}`, () => createTestUser({ role: "ADMIN", fullName }));
}

/**
 * An EMPLOYEE user linked to an existing employees row.
 *
 * Cached per employee, because linking a second account to the same employee
 * would just overwrite `employees.profile_id` and orphan the first.
 */
export function createTestStaff(employeeId: string): Promise<TestUser> {
  return once(`EMPLOYEE:${employeeId}`, async () => {
    const user = await createTestUser({ role: "EMPLOYEE", fullName: "Test Employee" });
    await db().query(`update public.employees set profile_id = $1 where id = $2`, [user.id, employeeId]);
    user.employeeId = employeeId;
    return user;
  });
}

/**
 * A CONCIERGE user: the front desk.
 *
 * Not linked to an `employees` row - a concierge is reception, not someone who
 * delivers a service, and the schema only hangs qualifications and rotas off
 * employees. Use this fixture for anything the desk owns: taking payment,
 * redeeming loyalty, reassigning a room.
 */
export function createTestConcierge(fullName = "Test Concierge"): Promise<TestUser> {
  return once(`CONCIERGE:${fullName}`, () => createTestUser({ role: "CONCIERGE", fullName }));
}

/** Remove users created by a suite. Bookings cascade from the profile. */
export async function deleteTestUsers(users: TestUser[]): Promise<void> {
  if (users.length === 0) return;
  const admin = supabaseAdmin();
  // The fixture cache means the same user may be listed more than once.
  const unique = [...new Map(users.map((u) => [u.id, u])).values()];
  await Promise.all(unique.map((u) => admin.auth.admin.deleteUser(u.id).catch(() => undefined)));
}

export function auth(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

/**
 * Bearer header as a tuple, so call sites read `.set(...as(token))`.
 *
 * A tuple rather than an object because supertest's `.set()` is overloaded and
 * spreading a plain object is a type error.
 */
export function as(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}
