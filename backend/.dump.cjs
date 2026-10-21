require("./scripts/_load-env.js");
const fs = require("fs");
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  for (const fn of ["role_from_app_metadata", "handle_new_auth_user"]) {
    const r = await c.query(`select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [fn]);
    fs.writeFileSync(`.fn_${fn}.sql`, r.rows.map(x => x.def).join("\n\n"));
    console.log("=== " + fn + " ===");
    console.log(r.rows[0].def);
    console.log();
  }
  await c.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
