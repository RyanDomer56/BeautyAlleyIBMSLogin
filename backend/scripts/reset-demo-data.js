/**
 * Reset the demo data to a clean, presentable state.
 *
 * ## Why this exists
 *
 * The smoke suite creates real records through the real API — that is the point
 * of it — and normally deletes them again. When a run is interrupted (the
 * server is killed, the network drops) the cleanup never happens, and the
 * database is left holding clients called "Victim", "Stranger" and "Wrong
 * Pass", plus their bookings. They are indistinguishable from real customers in
 * the UI, so the console looks broken when it is in fact working perfectly.
 *
 * ## What it keeps
 *
 *   - The catalogue: services, employees, qualifications, working hours, promos.
 *   - The **seeded** clients, identified by their fixed `33333333-…` uuids.
 *     Those are referenced by `demo-accounts.js`, so deleting them would break
 *     the client demo login.
 *   - Every auth account in `auth.users` — logins are not touched.
 *
 * ## What it removes
 *
 *   - Every booking (and its items, redemptions, passes and check-ins).
 *   - Every client that is not one of the seeded two. Those are, by
 *     construction, harness fixtures: nothing in the demo flow creates a client
 *     record, because guest booking deliberately does not.
 *
 * ## Safety
 *
 * Dry run by default — it prints exactly what it would remove and changes
 * nothing. `--apply` writes a full JSON backup of the affected rows to
 * `backend/backups/` **before** deleting, and does the delete in one
 * transaction so a failure leaves the database untouched.
 *
 * Child tables are discovered from `information_schema` rather than hard-coded,
 * so a future migration that adds another FK to `bookings` cannot silently make
 * this fail.
 *
 * Usage:
 *   node scripts/reset-demo-data.js            # show what would go
 *   node scripts/reset-demo-data.js --apply    # back up, then remove
 */

require("./_load-env");
const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

const SEEDED_CLIENT_PREFIX = "33333333-"; // see IDS in scripts/seed.js
const APPLY = process.argv.includes("--apply");

const c = { red: "\x1b[31m", green: "\x1b[32m", dim: "\x1b[2m", reset: "\x1b[0m" };

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  // --- discover every table with an FK into the tables we clear ------------
  const fks = (
    await db.query(
      `select tc.table_name as child, kcu.column_name as col, ccu.table_name as parent
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
         join information_schema.constraint_column_usage ccu
           on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'
          and ccu.table_name in ('bookings', 'clients')`,
    )
  ).rows;

  const bookings = (await db.query("select count(*)::int n from public.bookings")).rows[0].n;
  const junk = (
    await db.query(
      `select id, full_name from public.clients
        where id::text not like $1 order by full_name`,
      [`${SEEDED_CLIENT_PREFIX}%`],
    )
  ).rows;
  const keptClients = (
    await db.query(
      `select full_name from public.clients where id::text like $1 order by full_name`,
      [`${SEEDED_CLIENT_PREFIX}%`],
    )
  ).rows;

  console.log("");
  console.log("Demo data reset");
  console.log(`  bookings to remove   ${bookings}`);
  console.log(`  clients to remove    ${junk.length}`);
  for (const j of junk) console.log(`    ${c.dim}${j.full_name}${c.reset}`);
  console.log(`  clients to keep      ${keptClients.length}`);
  for (const k of keptClients) console.log(`    ${c.green}${k.full_name}${c.reset}`);
  console.log(`  dependent tables     ${fks.length ? [...new Set(fks.map((f) => f.child))].join(", ") : "none"}`);

  if (!APPLY) {
    console.log("");
    console.log(`  ${c.dim}dry run — nothing changed. Re-run with --apply to proceed.${c.reset}`);
    await db.end();
    return;
  }

  // --- back up before touching anything -----------------------------------
  const backup = { takenAt: new Date().toISOString(), tables: {} };
  for (const table of ["bookings", "clients", ...new Set(fks.map((f) => f.child))]) {
    const rows = await db.query(`select * from public.${table}`);
    backup.tables[table] = rows.rows;
  }
  const dir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `demo-reset-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), "utf8");
  console.log("");
  console.log(`  ${c.green}backup${c.reset} ${file}`);

  // --- one transaction, children first ------------------------------------
  await db.query("begin");
  try {
    for (const table of [...new Set(fks.map((f) => f.child))]) {
      // Child rows are removed wholesale: every one of them belongs to a
      // booking or a client that is going.
      await db.query(`delete from public.${table}`);
    }
    await db.query("delete from public.bookings");
    await db.query(`delete from public.clients where id::text not like $1`, [
      `${SEEDED_CLIENT_PREFIX}%`,
    ]);
    await db.query("commit");
    console.log(`  ${c.green}removed${c.reset} ${bookings} booking(s) and ${junk.length} fixture client(s)`);
  } catch (err) {
    await db.query("rollback");
    console.error(`  ${c.red}rolled back${c.reset} — ${err.message}`);
    process.exitCode = 1;
  }

  await db.end();
  console.log("");
  console.log("Next: npm run demo:bookings   (rebuild a fortnight of visits)");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
