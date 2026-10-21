/**
 * Scan-only: list bookings that do not match the canonical reference format.
 *
 * The canonical reference is `BA-YYYYMMDD-NNNN`, minted by the booking service.
 * Anything else in this database was written by a test harness directly — the
 * smoke suite mints its own references so it can find and clean up after
 * itself, and the ones left behind are rows whose cleanup did not run.
 *
 * This script DELETES NOTHING. It prints what it found so the decision to
 * remove them is a deliberate one.
 *
 * Usage: node scripts/find-test-residue.js
 */

require("./_load-env");
const { Client } = require("pg");

const CANONICAL = "^BA-[0-9]{8}-[0-9]{4}$";

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  const total = (await c.query("select count(*)::int n from public.bookings")).rows[0].n;
  const off = await c.query(
    `select b.reference, b.status, b.start_time,
            coalesce(cl.full_name, b.guest_name) as who,
            (b.start_time at time zone 'Asia/Manila')::date as day
       from public.bookings b
       left join public.clients cl on cl.id = b.client_id
      where b.reference !~ $1
      order by b.start_time`,
    [CANONICAL],
  );

  console.log(`bookings total          ${total}`);
  console.log(`off-pattern references  ${off.rowCount}`);
  if (off.rowCount) {
    console.log("");
    for (const r of off.rows) {
      console.log(
        `  ${r.reference.padEnd(26)} ${String(r.day).padEnd(11)} ${r.status.padEnd(10)} ${r.who ?? "—"}`,
      );
    }
  }

  // Client records that look like harness fixtures rather than people.
  const junkClients = await c.query(
    `select id, full_name, created_at
       from public.clients
      where full_name ~* '^(gone|done|audited|promo quest|smoke|test|tmp)'
      order by created_at`,
  );
  console.log("");
  console.log(`harness-looking clients ${junkClients.rowCount}`);
  for (const r of junkClients.rows) {
    console.log(`  ${r.full_name.padEnd(24)} ${r.id}`);
  }

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
