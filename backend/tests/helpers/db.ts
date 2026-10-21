import { Client } from "pg";

/**
 * Direct Postgres access for the tests.
 *
 * Some assertions cannot be made through the API at all - "is RLS enabled on
 * every table", "does the exclusion constraint reject a raw INSERT that
 * bypasses the service layer". Those need the database itself.
 *
 * This is also how the suite builds fixtures, because creating a pre-confirmed
 * auth user is only possible through the admin API or a direct connection.
 */

let client: Client | null = null;

export function db(): Client {
  if (!client) throw new Error("Database client not initialised - call connectDb() first");
  return client;
}

export async function connectDb(): Promise<Client> {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the integration tests");
  }
  client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
  }
}

/**
 * Run a callback inside a transaction that is always rolled back.
 *
 * Used for the RLS assertions: they need to `set local role anon` and read
 * tables, and that must not leak a role change into the next test.
 */
export async function inRollback<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = db();
  await c.query("begin");
  try {
    return await fn(c);
  } finally {
    await c.query("rollback");
  }
}

/**
 * Create an auth.users row, returning its id.
 *
 * `public.profiles.id` has a foreign key to `auth.users(id)`, so a profile
 * cannot be inserted without an account behind it. The trigger
 * `handle_new_auth_user` fires on this insert and creates the profile too -
 * which is convenient, and also means the tests exercise the real sign-up path
 * rather than hand-writing a profile row.
 */
export async function createAuthUser(
  c: Client,
  opts: { role?: string; fullName?: string; email?: string } = {}
): Promise<string> {
  const email = opts.email ?? `rls.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@beautyalley.ph`;
  const { rows } = await c.query(
    `insert into auth.users
       (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values
       ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
        $1, extensions.crypt('irrelevant', extensions.gen_salt('bf')), now(), now(), now(),
        jsonb_build_object('role', $2::text),
        jsonb_build_object('full_name', $3::text))
     returning id`,
    [email, opts.role ?? "CLIENT", opts.fullName ?? "RLS User"]
  );
  return rows[0].id;
}

/**
 * Assert that a statement fails, without poisoning the surrounding transaction.
 *
 * Postgres aborts the whole transaction on error: every later statement in the
 * same transaction returns 25P02 ("current transaction is aborted") regardless
 * of what it asks. A savepoint per expected failure is what keeps a suite of
 * negative assertions usable.
 */
export async function expectQueryError(
  c: Client,
  sql: string,
  params: unknown[],
  expectedCode: string
): Promise<void> {
  await c.query("savepoint expected_failure");
  try {
    await c.query(sql, params);
    await c.query("release savepoint expected_failure");
    throw new Error(`expected ${expectedCode}, but the statement succeeded`);
  } catch (err) {
    await c.query("rollback to savepoint expected_failure");
    const code = (err as { code?: string }).code;
    if (code !== expectedCode) {
      throw new Error(`expected ${expectedCode}, got ${code ?? "no code"}: ${(err as Error).message}`);
    }
  }
}

/** True when the service-role key is present, i.e. the API can do privileged work. */
export const serviceRoleAvailable = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * `describe.skip` when privileged access is unavailable.
 *
 * Deliberately not `describe` with a soft assertion: a skipped test that
 * reports as "passed" is worse than no test, because it hides the gap.
 */
export const describeWithServiceRole = serviceRoleAvailable ? describe : describe.skip;
