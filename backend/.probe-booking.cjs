// One-off probe: verify the working-hours check now refuses an out-of-hours
// start. Each call gets its own transaction and is rolled back, so a
// successful booking cannot persist.
require("./scripts/_load-env.js");
const { Client } = require("pg");

const SVC_MASSAGE = "11111111-0000-0000-0000-000000000001";
const EMP_ANA = "22222222-0000-0000-0000-000000000001";

function manila(daysAhead, hour) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + daysAhead);
  base.setUTCHours(0, 0, 0, 0);
  const utc = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, 0, 0, 0));
  utc.setUTCHours(utc.getUTCHours() - 8);
  return utc;
}

async function attempt(c, label, slot, enforce = true) {
  await c.query("begin");
  try {
    const r = await c.query(
      `select public.create_booking(
         p_service_ids => $1::uuid[], p_employee_id => $2::uuid,
         p_start_time => $3::timestamptz, p_guest => $4::jsonb,
         p_enforce_hours => $5) as out`,
      [[SVC_MASSAGE], EMP_ANA, slot.toISOString(), JSON.stringify({ name: "__probe", phone: "+639000000001" }), enforce]
    );
    console.log(`${label.padEnd(42)} ACCEPTED  ref=${r.rows[0].out.reference}`);
  } catch (e) {
    console.log(`${label.padEnd(42)} REFUSED   ${e.message}`);
  } finally {
    await c.query("rollback");
  }
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  await attempt(c, "23:00 (after close)", manila(4, 23));
  await attempt(c, "17:30 + 60min (overruns close)", manila(4, 17));
  await attempt(c, "10:00 (inside hours)", manila(4, 10));
  await attempt(c, "23:00 with p_enforce_hours = false", manila(4, 23), false);

  await c.end();
})().catch((e) => {
  console.error("probe failed:", e.message);
  process.exit(1);
});
