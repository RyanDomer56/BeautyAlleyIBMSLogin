// One-off verification for migration 24 (STAFF -> EMPLOYEE). Read-only.
require("./scripts/_load-env.js");
const { Client } = require("pg");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const labels = await c.query(
    `select e.enumlabel, e.enumsortorder
       from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'user_role' order by e.enumsortorder`
  );
  console.log("user_role labels:", labels.rows.map(r => r.enumlabel).join(", "));

  const roles = await c.query(
    `select role::text as role, count(*)::int as n from public.profiles group by 1 order by 1`
  );
  console.log("profiles by role:", JSON.stringify(roles.rows));

  const map = await c.query(
    `select k as input, public.role_from_app_metadata(jsonb_build_object('role', k))::text as mapped
       from (values ('STAFF'),('EMPLOYEE'),('CONCIERGE'),('ADMIN'),('CLIENT'),('GUEST'),('WIZARD')) v(k)`
  );
  for (const r of map.rows) console.log(`  role_from_app_metadata(${r.input.padEnd(9)}) -> ${r.mapped}`);

  const fn = await c.query(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'role_from_app_metadata'`
  );
  console.log("role_from_app_metadata overloads:", fn.rows[0].n);

  // Anything still holding the old label as text?
  const leftovers = await c.query(
    `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and pg_get_functiondef(p.oid) like '%''STAFF''%'`
  );
  console.log("public functions still mentioning 'STAFF' literal:", leftovers.rows[0].n);

  await c.end();
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
