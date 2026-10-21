/**
 * Generate migration 25 from the LIVE definition of create_booking.
 *
 * Same technique migration 21 used: dump with pg_get_functiondef, make the one
 * change, diff against the dump to prove nothing else moved. Hand-retyping a
 * 12 KB function is how migration 18 lost the fix from migration 16 in the
 * first place.
 *
 *   node .gen25.cjs            # write the migration
 *   node .gen25.cjs --dry      # print a diff and write nothing
 */
require("./scripts/_load-env.js");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const OUT = path.join(__dirname, "supabase", "migrations", "20261013000025_restore_working_hours_check.sql");

const BROKEN =
  "and (v_local_start::time + make_interval(mins => v_duration)) <= wh.end_time";
const FIXED =
  "and (v_local_start::time - wh.start_time) + make_interval(mins => v_duration)\n" +
  "            <= (wh.end_time - wh.start_time)";

const OLD_COMMENT =
  "-- Compared in the `time` domain to sidestep the midnight wrap: a shift\n" +
  "    -- that ends at 23:00 cannot contain a 22:30 start plus 90 minutes, and\n" +
  "    -- `time` arithmetic simply refuses it rather than wrapping to 00:00.";

const NEW_COMMENT =
  "-- Compared as OFFSETS from the start of the shift, not as wall-clock\n" +
  "    -- times. `time + interval` is taken modulo 24 hours, so\n" +
  "    -- `time '23:00' + interval '1 hour'` is `00:00`, and `00:00 <= '18:00'`\n" +
  "    -- is true - a 23:00 appointment was accepted by an employee whose shift\n" +
  "    -- ends at 18:00. `time - time` yields an interval, and interval\n" +
  "    -- arithmetic does not wrap, so an overrun compares as longer than the\n" +
  "    -- shift and is refused. (Migration 16 made exactly this change; the\n" +
  "    -- migration that added rooms restated the function from a stale body and\n" +
  "    -- silently put the wrap back.)";

(async () => {
  const dry = process.argv.includes("--dry");
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const { rows } = await c.query(
    `select p.oid, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'create_booking'`
  );
  await c.end();

  if (rows.length !== 1) throw new Error(`expected exactly 1 create_booking, found ${rows.length}`);

  const before = rows[0].def;
  if (!before.includes(BROKEN)) throw new Error("the broken working-hours condition was not found - refusing to write a no-op migration");

  let after = before.replace(BROKEN, FIXED);
  after = after.replace(OLD_COMMENT, NEW_COMMENT);
  if (after === before) throw new Error("nothing changed");

  // pg_get_functiondef omits the trailing semicolon.
  const body = after.trimEnd() + ";";

  const header = `-- ---------------------------------------------------------------------------
-- Migration 25: restore the working-hours check that migration 18 reverted.
--
-- Migration 16 fixed a real acceptance bug: \`create_booking\` compared the
-- appointment's end against the shift end using \`time + interval\`, which
-- Postgres takes modulo 24 hours. \`time '23:00' + interval '1 hour'\` is
-- \`00:00\`, and \`00:00 <= '18:00'\` is true, so a 23:00 appointment was
-- accepted by an employee whose shift ends at 18:00 - while
-- \`get_available_slots\` correctly refused to *offer* it. That is precisely the
-- "the API trusts the UI to validate" bug the check exists to prevent.
--
-- Migration 18 (rooms) restated the whole function from a body that predated
-- migration 16, so the wrap came back. Migration 21 then regenerated the
-- function from the live definition and faithfully carried the regression
-- forward - the diff proved nothing else had moved, which is exactly why the
-- stale clause survived: it was already live.
--
-- Found by \`tests/integration/bookings.test.ts\` ("refuses a time outside the
-- stylist's working hours"), which had been failing since migration 18.
--
-- The body below is the deployed definition, dumped with pg_get_functiondef
-- and changed in exactly two places: the comparison, and the comment that
-- claimed the wrap could not happen.
--
-- Offset arithmetic, not wall-clock:
--
--   (v_local_start::time - wh.start_time) + duration <= (wh.end_time - wh.start_time)
--
-- \`time - time\` yields an interval and interval arithmetic does not wrap, so an
-- appointment that overruns closing - or runs past midnight - compares as
-- longer than the shift and is refused.
-- ---------------------------------------------------------------------------

`;

  const checks = `

-- ---------------------------------------------------------------------------
-- Self-checks.
--
-- The behavioural check runs the real function against a shift that ends at
-- 18:00 with an appointment starting at 23:00, inside a transaction that is
-- rolled back. Asserting on the *source text* would pass on a function that
-- merely mentions the right words.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_src   text;
begin
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';
  if v_count <> 1 then
    raise exception 'migration 25: expected exactly 1 create_booking, found %', v_count;
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';

  if v_src like '%v_local_start::time + make_interval%' then
    raise exception 'migration 25: the wrapping wall-clock comparison is still present';
  end if;
  if v_src not like '%(v_local_start::time - wh.start_time)%' then
    raise exception 'migration 25: the offset comparison is missing';
  end if;
end $$;

do $$
declare
  v_employee uuid;
  v_service  uuid;
  v_slot     timestamptz;
begin
  -- Pick any employee/service pair that exists, so this works against a seeded
  -- database and against an empty one alike.
  select id into v_employee from public.employees order by id limit 1;
  select id into v_service  from public.services  order by id limit 1;

  if v_employee is null or v_service is null then
    raise notice 'migration 25: no employees/services to exercise - skipping the behavioural check';
    return;
  end if;

  -- 23:00 Manila on the next open day. No working_hours row covers 23:00 for a
  -- 09:00-18:00 shift, so this must be refused regardless of the shift's shape.
  v_slot := (date_trunc('day', now() at time zone public.branch_timezone())
             + interval '1 day' + interval '23 hours') at time zone public.branch_timezone();

  begin
    perform public.create_booking(
      p_service_ids   => array[v_service],
      p_employee_id   => v_employee,
      p_start_time    => v_slot,
      p_guest         => jsonb_build_object('name', '__migration25_probe', 'phone', '+639000000000'),
      p_enforce_hours => true);
    raise exception 'migration 25: a 23:00 appointment was ACCEPTED - the wrap is still live';
  exception
    when others then
      -- OUTSIDE_WORKING_HOURS is the answer we want. Anything else (a room
      -- clash, a qualification miss) means the probe did not reach the check,
      -- so it proves nothing and must not be mistaken for a pass.
      if sqlerrm not like 'OUTSIDE_WORKING_HOURS%' then
        raise exception 'migration 25: expected OUTSIDE_WORKING_HOURS, got: %', sqlerrm;
      end if;
  end;
end $$;
`;

  if (dry) {
    const b = before.split("\n");
    const a = after.split("\n");
    for (let i = 0; i < Math.max(b.length, a.length); i++) {
      if (b[i] !== a[i]) {
        console.log(`line ${i + 1}:`);
        console.log("  -", b[i]);
        console.log("  +", a[i]);
      }
    }
    return;
  }

  fs.writeFileSync(OUT, header + body + checks, "utf8");
  console.log("wrote", path.basename(OUT), `(${(header + body + checks).length} bytes)`);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
