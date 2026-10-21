#!/usr/bin/env node
/**
 * Create the four demo logins the web app advertises.
 *
 *   node scripts/demo-accounts.js            # create/repair, then verify
 *   node scripts/demo-accounts.js --quiet    # same, no progress output
 *
 * ## Why this is separate from seed.js
 *
 * `seed.js` truncates and repopulates the *domain* tables — services,
 * employees, bookings, clients. Auth accounts live in `auth.users`, which the
 * seed deliberately never touches: truncating it would invalidate every
 * session and is not what "reseed the fixtures" should mean.
 *
 * So the two are separate concerns and this script is idempotent on its own:
 * run it once, or fifty times, and the end state is the same four accounts
 * with the same passwords and the same linked rows.
 *
 * ## Why the credentials live in a JSON file at the repo root
 *
 * `demo-accounts.json` is also imported by the web app's login page, which
 * offers them as one-click quick-fill buttons. One source, so the password
 * printed on screen is provably the password this script sets. The classic
 * failure mode of a demo build is a README quoting a password the seed does
 * not set, and it only ever surfaces in front of an audience.
 *
 * ## Why it repairs rather than only creates
 *
 * If an account already exists with a different password, "create" would fail
 * and the demo would be broken in a way that looks like a bug in the login
 * form. So an existing account is reset to the documented password instead.
 */

require("./_load-env");
const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const { Client } = require("pg");

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const DEMO_FILE = path.resolve(__dirname, "..", "..", "demo-accounts.json");

function loadDemoFile() {
  if (!fs.existsSync(DEMO_FILE)) {
    throw new Error(`Missing ${DEMO_FILE}`);
  }
  const parsed = JSON.parse(fs.readFileSync(DEMO_FILE, "utf8"));
  if (!parsed.password || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    throw new Error(`${DEMO_FILE} must define a password and at least one account`);
  }
  return parsed;
}

/** GoTrue paginates; the test suite has left a few hundred accounts behind. */
async function findUserByEmail(supabase, email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

async function ensureAccount(supabase, account, password, log) {
  const meta = {
    app_metadata: { role: account.role },
    user_metadata: { full_name: account.fullName },
  };

  const existing = await findUserByEmail(supabase, account.email);

  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      ...meta,
    });
    if (error) throw error;
    log(`  ${c.yellow}reset${c.reset}  ${account.role.padEnd(6)} ${account.email}`);
    return existing.id;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: account.email,
    password,
    email_confirm: true,
    ...meta,
  });
  if (error) throw error;
  if (!data.user) throw new Error(`Creating ${account.email} returned no user`);
  log(`  ${c.green}created${c.reset} ${account.role.padEnd(6)} ${account.email}`);
  return data.user.id;
}

async function main() {
  const quiet = process.argv.includes("--quiet");
  const log = (msg) => {
    if (!quiet) process.stdout.write(msg + "\n");
  };

  const demo = loadDemoFile();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env");
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const failures = [];

  try {
    log(`${c.bold}Demo accounts${c.reset}`);

    for (const account of demo.accounts) {
      const userId = await ensureAccount(supabase, account, demo.password, log);

      /*
       * The profile row is created by the `handle_new_auth_user` trigger and
       * kept in sync by migration 15's `AFTER UPDATE OF raw_app_meta_data`
       * trigger. Setting it explicitly here is belt-and-braces: it makes this
       * script correct even if it runs against a project where the triggers
       * were never installed, and it costs one idempotent UPDATE.
       */
      await db.query(
        `insert into public.profiles (id, full_name, role, is_active)
         values ($1, $2, $3, true)
         on conflict (id) do update
           set full_name = excluded.full_name,
               role      = excluded.role,
               is_active = true`,
        [userId, account.fullName, account.role]
      );

      // Link the account to the seeded row it represents, so the app has an
      // identity to work with: a stylist's `employeeId` is what a QR check-in
      // is attributed to, and a client's `clientId` is what their bookings hang off.
      if (account.employeeId) {
        const res = await db.query(
          `update public.employees set profile_id = $1 where id = $2`,
          [userId, account.employeeId]
        );
        if (res.rowCount === 0) {
          failures.push(`${account.email}: no employees row ${account.employeeId} to link`);
        }
      }

      if (account.clientId) {
        /*
         * Detach first, then attach.
         *
         * `clients.profile_id` is UNIQUE. A demo client who has ever signed up
         * through the app gets a clients row created for them automatically, so
         * by the time this script runs there can already be a *different* row
         * holding this profile id. Setting it on the seeded row then fails with
         * 23505 and the whole run aborts - which is exactly how the Concierge
         * account ended up half-created and unable to sign in.
         *
         * Clearing the stale link is safe: the row itself is kept, along with
         * every booking hanging off it. Only the "this profile owns me"
         * pointer moves to the canonical seeded row.
         */
        await db.query(
          `update public.clients set profile_id = null where profile_id = $1 and id <> $2`,
          [userId, account.clientId]
        );

        const res = await db.query(
          `update public.clients set profile_id = $1, email = $2 where id = $3`,
          [userId, account.email, account.clientId]
        );
        if (res.rowCount === 0) {
          failures.push(`${account.email}: no clients row ${account.clientId} to link`);
        }
      }
    }

    // --- verify, rather than assume ----------------------------------------
    // The role is what the whole RBAC story hangs on, and it travels through
    // three layers (app_metadata -> trigger -> profiles). Asserting the end
    // state is the only way to know it arrived.
    log("");
    log(`${c.bold}Verifying${c.reset}`);

    for (const account of demo.accounts) {
      const { rows } = await db.query(
        `select p.role, p.is_active, p.full_name,
                (select count(*) from public.clients   c where c.profile_id = p.id) as clients,
                (select count(*) from public.employees e where e.profile_id = p.id) as employees
           from public.profiles p
           join auth.users u on u.id = p.id
          where lower(u.email) = lower($1)`,
        [account.email]
      );

      const row = rows[0];
      if (!row) {
        failures.push(`${account.email}: no profile row found after the update`);
        continue;
      }
      if (row.role !== account.role) {
        failures.push(`${account.email}: role is ${row.role}, expected ${account.role}`);
      }
      if (row.is_active !== true) {
        failures.push(`${account.email}: profile is not active`);
      }

      const linked =
        account.role === "EMPLOYEE"
          ? `${row.employees} employee row(s)`
          : account.role === "CLIENT"
            ? `${row.clients} client row(s)`
            : "no linked row needed";

      log(
        `  ${row.role === account.role ? c.green + "ok" : c.red + "!!"}${c.reset} ` +
          `${account.role.padEnd(10)} ${account.email.padEnd(26)} ${linked}`
      );
    }

    // A sign-in is the only end-to-end proof that the password actually works.
    log("");
    log(`${c.bold}Testing sign-in${c.reset}`);

    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    for (const account of demo.accounts) {
      const { data, error } = await anon.auth.signInWithPassword({
        email: account.email,
        password: demo.password,
      });
      if (error) {
        failures.push(`${account.email}: sign-in failed (${error.message})`);
        log(`  ${c.red}fail${c.reset}  ${account.email}: ${error.message}`);
      } else {
        log(`  ${c.green}ok${c.reset}    ${account.email.padEnd(26)} token ${data.session ? "issued" : "MISSING"}`);
        if (!data.session) failures.push(`${account.email}: sign-in returned no session`);
        await anon.auth.signOut().catch(() => {});
      }
    }
  } finally {
    await db.end();
  }

  log("");
  if (failures.length) {
    process.stderr.write(`${c.red}${c.bold}FAILED${c.reset}\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }

  log(`${c.bold}${c.green}All demo accounts ready.${c.reset}`);
  log(`Password for all ${demo.accounts.length}: ${c.cyan}${demo.password}${c.reset}`);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`\n${c.red}demo-accounts failed: ${e.message}${c.reset}\n`);
    process.exit(1);
  });
}
