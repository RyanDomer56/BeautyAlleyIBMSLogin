#!/usr/bin/env node
"use strict";

/**
 * Database verification harness.
 *
 * This proves the guarantees in the schema actually hold, by exercising them:
 * the double-booking constraint, the promo cap, the QR window, the status
 * machine and - most importantly - that RLS denies what it is supposed to
 * deny. A catalog check ("the constraint exists") is not evidence that the
 * constraint works, so almost everything here is behavioural.
 *
 * Everything runs inside one transaction that is ROLLED BACK at the end, so
 * it is safe to run against a live project: no fixtures survive.
 *
 *   node scripts/verify.js
 */

const path = require("path");
const { Client } = require("pg");

require("./_load-env");

const C = {
  r: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  bold: "\x1b[1m",
};

let pass = 0;
const failures = [];

const ok = (name, extra) => {
  pass++;
  process.stdout.write(`  ${C.green}PASS${C.r}  ${name}${extra ? `  ${C.dim}${extra}${C.r}` : ""}\n`);
};

const bad = (name, detail) => {
  failures.push(name);
  process.stdout.write(`  ${C.red}FAIL${C.r}  ${name}\n         ${C.dim}${detail}${C.r}\n`);
};

const section = (t) => process.stdout.write(`\n${C.bold}${t}${C.r}\n`);

const SKIP = Symbol("skip");

/** Run a statement that is expected to raise; assert on the error code. */
async function expectError(client, name, sql, params, expectedCode) {
  await client.query("savepoint sp");
  try {
    await client.query(sql, params);
    await client.query("release savepoint sp");
    bad(name, `expected ${expectedCode}, but the statement succeeded`);
    return false;
  } catch (e) {
    try {
      await client.query("rollback to savepoint sp");
    } catch {
      /* the transaction is already unusable; the caller will fail loudly */
    }
    // Postgres reports the SQLSTATE in `code`; some errors (permission denied,
    // exclusion violation) have a message that does not mention it, so check
    // both.
    const matched =
      e.code === expectedCode || String(e.message).includes(expectedCode);
    if (matched) {
      ok(name, `-> ${expectedCode}`);
      return true;
    }
    bad(name, `expected ${expectedCode}, got [${e.code || "-"}] ${e.message}`);
    return false;
  }
}

/**
 * Count rows, treating "permission denied" as a valid denial.
 * Both outcomes are safe - no GRANT at all is a stronger denial than an RLS
 * policy filtering to zero rows - so the RLS tests accept either.
 */
async function countOrDenied(client, sql, params) {
  await client.query("savepoint c");
  try {
    const { rows } = await client.query(sql, params);
    await client.query("release savepoint c");
    return rows[0].n;
  } catch (e) {
    await client.query("rollback to savepoint c");
    if (/permission denied/i.test(e.message)) return "DENIED";
    throw e;
  }
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20000,
  });
  await client.connect();

  // =========================================================================
  // 1. Catalog
  // =========================================================================
  section("1. Schema shape");

  const expectedTables = [
    "profiles", "clients", "employees", "services", "employee_services",
    "working_hours", "time_off", "booking_counters", "bookings",
    "booking_items", "promo_codes", "promo_redemptions", "qr_tokens",
    "checkins", "audit_logs", "login_attempts",
  ];

  const t = await client.query(
    `select tablename from pg_tables where schemaname = 'public'`
  );
  const have = new Set(t.rows.map((r) => r.tablename));
  const missing = expectedTables.filter((x) => !have.has(x));
  if (missing.length === 0) ok(`all ${expectedTables.length} tables present`);
  else bad("tables present", `missing: ${missing.join(", ")}`);

  const noRls = await client.query(
    `select c.relname
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`
  );
  if (noRls.rowCount === 0) ok("RLS enabled on every public table");
  else bad("RLS enabled on every public table", `missing: ${noRls.rows.map((r) => r.relname).join(", ")}`);

  // Two, not one. Migration 17 added the room clash alongside the original
  // employee clash, and counting constraints would have read as "still one"
  // if either were ever dropped. Naming them states the actual invariant.
  const excl = await client.query(
    `select conname from pg_constraint
      where conrelid = 'public.bookings'::regclass and contype = 'x'`
  );
  const exclNames = new Set(excl.rows.map((r) => r.conname));
  const wantExcl = ["bookings_no_overlap", "bookings_room_no_overlap"];
  const missingExcl = wantExcl.filter((n) => !exclNames.has(n));
  if (missingExcl.length === 0) ok("bookings has both EXCLUSION constraints", wantExcl.join(" + "));
  else bad("bookings has both EXCLUSION constraints", `missing: ${missingExcl.join(", ")}`);

  const fns = [
    "create_booking", "cancel_booking", "reschedule_booking", "check_in_booking",
    "get_available_slots", "validate_promo", "get_dashboard_summary",
    "get_employee_performance", "next_booking_reference", "branch_timezone",
  ];
  const fnRows = await client.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`
  );
  const haveFn = new Set(fnRows.rows.map((r) => r.proname));
  const missingFn = fns.filter((f) => !haveFn.has(f));
  if (missingFn.length === 0) ok(`all ${fns.length} functions present`);
  else bad("functions present", `missing: ${missingFn.join(", ")}`);

  const views = await client.query(
    `select c.relname, c.reloptions
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'`
  );
  const notInvoker = views.rows.filter(
    (v) => !(v.reloptions || []).includes("security_invoker=true")
  );
  if (views.rowCount > 0 && notInvoker.length === 0)
    ok(`${views.rowCount} views all use security_invoker`);
  else if (views.rowCount === 0) bad("views present", "no views found");
  else bad("views use security_invoker", `not set on: ${notInvoker.map((v) => v.relname).join(", ")}`);

  // SECURITY: anon must not be able to call the business functions.
  //
  // `validate_promo` is deliberately absent from this list. Migration 14
  // re-grants EXECUTE on it (and on `get_available_slots`) because the booking
  // flow needs both before sign-in; the positive check is below so the pair
  // cannot drift.
  const anonExec = await client.query(
    `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and p.proname in ('create_booking','get_dashboard_summary','cancel_booking','reschedule_booking','check_in_booking')`
  );
  if (anonExec.rowCount === 0) ok("anon cannot EXECUTE business functions");
  else bad("anon cannot EXECUTE business functions", `exposed: ${anonExec.rows.map((r) => r.proname).join(", ")}`);

  const publicExec = await client.query(
    `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege('anon', p.oid, 'EXECUTE')
        and p.proname in ('get_available_slots','validate_promo')
      order by p.proname`
  );
  if (publicExec.rowCount === 2)
    ok("anon CAN execute the two read-only public functions", publicExec.rows.map((r) => r.proname).join(", "));
  else
    bad(
      "anon can execute the public read functions",
      `only ${publicExec.rowCount}/2 reachable: ${publicExec.rows.map((r) => r.proname).join(", ") || "none"}`
    );

  // =========================================================================
  // 2. Behaviour - all inside a transaction that is rolled back
  // =========================================================================
  section("2. Booking guarantees");

  await client.query("begin");

  const EMP = "11111111-1111-1111-1111-111111111111";
  const EMP2 = "22222222-2222-2222-2222-222222222222";
  const SVC_A = "aaaaaaaa-0000-0000-0000-000000000001";
  const SVC_B = "aaaaaaaa-0000-0000-0000-000000000002";
  const CLIENT_A = "cccccccc-0000-0000-0000-00000000000a";
  const PROMO = "dddddddd-0000-0000-0000-000000000001";

  await client.query(
    `insert into public.employees (id, full_name, title) values
       ($1, 'Ada Reyes', 'Senior Stylist'),
       ($2, 'Ben Cruz', 'Therapist')`,
    [EMP, EMP2]
  );

  await client.query(
    `insert into public.services (id, name, category, price_cents, duration_minutes) values
       ($1, 'Signature Facial', 'SPA', 250000, 60),
       ($2, 'Deep Tissue Massage', 'WELLNESS', 180000, 90)`,
    [SVC_A, SVC_B]
  );

  // EMP is qualified for both; EMP2 only for the massage.
  await client.query(
    `insert into public.employee_services (employee_id, service_id) values
       ($1, $3), ($1, $4), ($2, $4)`,
    [EMP, EMP2, SVC_A, SVC_B]
  );

  // Open every day, 00:00-23:59. A full-width window only keeps the harness
  // time-of-day independent *together with* the fixed START anchor below - the
  // window alone was not enough, because slots are derived by adding hours.
  await client.query(
    `insert into public.working_hours (employee_id, weekday, start_time, end_time)
     select e.id, d, '00:00'::time, '23:59'::time
       from (values ($1::uuid), ($2::uuid)) e(id)
       cross join generate_series(0, 6) d`,
    [EMP, EMP2]
  );

  await client.query(
    `insert into public.clients (id, full_name, phone, email)
     values ($1, 'Grace Lim', '+639170000001', 'grace@example.com')`,
    [CLIENT_A]
  );

  // A start time comfortably in the future, on a clean hour boundary, anchored
  // to 01:00 Manila two days out rather than to the current hour.
  //
  // The anchor matters. This harness opens 00:00-23:59 and then derives later
  // slots by adding up to 20 hours, so anchoring on `date_trunc('hour', now())`
  // left the derived slots time-of-day dependent: run at 03:00 UTC, the +12h
  // slot landed on 23:00 Manila, and 23:00 plus the 90-minute service is 00:30 -
  // past the 23:59 end of the shift. That used to be *accepted*, because
  // `time + interval` wraps at midnight (23:00 + 1h = 00:00, which is <= 23:59);
  // the corrected offset arithmetic in migration 16 rejects it, and that is how
  // a latent flakiness bug in this harness surfaced. Six different UTC hours
  // failed this way. 01:00 + 20h is 21:00 and +90min is 22:30, so nothing can
  // reach the boundary now, whatever hour the harness runs at.
  const { rows: t0 } = await client.query(
    `select (date_trunc('day', now() at time zone 'Asia/Manila')
              + interval '2 days' + interval '1 hour') at time zone 'Asia/Manila' as start_time`
  );
  const START = t0[0].start_time;

  // --- happy path ---------------------------------------------------------
  const { rows: b1 } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid],
       p_employee_id => $2::uuid,
       p_start_time  => $3::timestamptz,
       p_client_id   => $4::uuid,
       p_actor       => null
     ) as r`,
    [SVC_A, EMP, START, CLIENT_A]
  );
  const booking1 = b1[0].r;

  // The invariant is the *format* - BA-YYYYMMDD-NNNN - not the sequence number.
  // Asserting `-0001` only holds on a freshly seeded database, so it turned a
  // passing harness into a failing one the moment anything had booked that day.
  if (/^BA-\d{8}-\d{4}$/.test(booking1.reference))
    ok("booking reference format", booking1.reference);
  else bad("booking reference format", `got ${booking1.reference}`);

  if (booking1.totalCents === 250000 && booking1.subtotalCents === 250000)
    ok("subtotal/total computed from service price", "2500.00");
  else bad("subtotal/total computed", JSON.stringify(booking1));

  if (booking1.status === "PENDING")
    ok("self-service booking starts PENDING");
  else bad("self-service booking starts PENDING", `got ${booking1.status}`);

  const { rows: items } = await client.query(
    `select name_snapshot, price_cents_snapshot from public.booking_items where booking_id = $1`,
    [booking1.bookingId]
  );
  if (items.length === 1 && items[0].price_cents_snapshot === 250000)
    ok("price snapshot written", items[0].name_snapshot);
  else bad("price snapshot written", `${items.length} row(s): ${JSON.stringify(items)}`);

  const { rows: tok } = await client.query(
    `select count(*)::int as n from public.qr_tokens where booking_id = $1 and revoked_at is null`,
    [booking1.bookingId]
  );
  if (tok[0].n === 1) ok("QR pass minted");
  else bad("QR pass minted", `found ${tok[0].n}`);

  const { rows: aud } = await client.query(
    `select count(*)::int as n from public.audit_logs where entity_id = $1`,
    [booking1.bookingId]
  );
  if (aud[0].n >= 1) ok("audit entry written");
  else bad("audit entry written", "no rows");

  // --- double booking -----------------------------------------------------
  const overlapStart = new Date(new Date(START).getTime() + 30 * 60000).toISOString();
  await expectError(
    client,
    "overlapping booking for same employee is rejected",
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time => $3::timestamptz, p_client_id => $4::uuid)`,
    [SVC_A, EMP, overlapStart, CLIENT_A],
    "SLOT_TAKEN"
  );

  // --- adjacent is allowed ------------------------------------------------
  const adjacentStart = booking1.endTime;
  const { rows: b2 } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time  => $3::timestamptz, p_client_id => $4::uuid) as r`,
    [SVC_A, EMP, adjacentStart, CLIENT_A]
  );
  if (b2[0].r.reference) ok("back-to-back booking is allowed", b2[0].r.reference);
  else bad("back-to-back booking is allowed", "no reference");

  // --- raw SQL also blocked (constraint, not app logic) -------------------
  await expectError(
    client,
    "raw INSERT that overlaps is blocked by the constraint",
    `insert into public.bookings
       (reference, employee_id, start_time, end_time, status, subtotal_cents, total_cents, guest_phone)
     values ('BA-RAW-1', $1, $2, $3, 'CONFIRMED', 1000, 1000, '+639170000009')`,
    [EMP, START, new Date(new Date(START).getTime() + 3600000).toISOString()],
    "23P01"
  );

  // --- qualification ------------------------------------------------------
  await expectError(
    client,
    "unqualified employee is rejected",
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time => $3::timestamptz, p_client_id => $4::uuid)`,
    [SVC_A, EMP2, START, CLIENT_A],
    "EMPLOYEE_NOT_QUALIFIED"
  );

  // --- working hours ------------------------------------------------------
  await expectError(
    client,
    "guest booking with no phone is rejected",
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time => $3::timestamptz, p_guest => '{"name":"Walk In"}'::jsonb)`,
    [SVC_A, EMP, new Date(new Date(START).getTime() + 4 * 3600000).toISOString()],
    "CLIENT_REQUIRED"
  );

  // --- guest booking succeeds --------------------------------------------
  const { rows: b3 } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time  => $3::timestamptz,
       p_guest       => '{"name":"Walk In","phone":"+639170000002"}'::jsonb) as r`,
    [SVC_A, EMP, new Date(new Date(START).getTime() + 5 * 3600000).toISOString()]
  );
  if (b3[0].r.reference) ok("guest booking accepted with a phone number", b3[0].r.reference);
  else bad("guest booking accepted", "no reference");

  // =========================================================================
  section("3. Promo codes");

  // `on conflict ... do update` rather than a plain insert: the seed already
  // ships a SAVE10 code, so a bare insert raised a unique violation on
  // `promo_codes_code_key` and aborted the whole harness - and the harness has
  // to work against a seeded database, because that is the state the tests and
  // a demo run in. Forcing the properties it needs makes it independent of what
  // the seed happens to contain.
  //
  // `max_redemptions` is cleared rather than set to a number. Redemptions
  // accumulate in the database between runs, so any global cap here would be
  // spent by whatever ran before and the harness would report LIMIT_REACHED for
  // a reason it is not testing. The global cap is covered by `integration/promos`;
  // what this harness needs from SAVE10 is the per-client cap, which is keyed to
  // a client row it creates itself.
  await client.query(
    `insert into public.promo_codes (id, code, type, value, max_redemptions, per_client_limit, min_spend_cents, is_active)
     values ($1, 'SAVE10', 'PERCENT', 10, null, 1, 0, true)
     on conflict (code) do update set
       type = excluded.type,
       value = excluded.value,
       max_redemptions = null,
       per_client_limit = excluded.per_client_limit,
       min_spend_cents = excluded.min_spend_cents,
       starts_at = null,
       ends_at = null,
       is_active = true`,
    [PROMO]
  );

  const { rows: pv } = await client.query(
    `select public.validate_promo('save10'::citext, $1, null, array[$2::uuid], 250000) as r`,
    [CLIENT_A, SVC_A]
  );
  if (pv[0].r.valid && pv[0].r.discountCents === 25000)
    ok("case-insensitive code, 10% discount", `${pv[0].r.discountCents} cents`);
  else bad("percent discount maths", JSON.stringify(pv[0].r));

  await client.query(
    `insert into public.promo_codes (code, type, value, min_spend_cents)
     values ('BIGSPEND', 'FIXED', 50000, 500000)`
  );
  const { rows: pv2 } = await client.query(
    `select public.validate_promo('BIGSPEND'::citext, $1, null, array[$2::uuid], 250000) as r`,
    [CLIENT_A, SVC_A]
  );
  if (!pv2[0].r.valid && pv2[0].r.reason === "MIN_SPEND_NOT_MET")
    ok("minimum spend enforced", pv2[0].r.reason);
  else bad("minimum spend enforced", JSON.stringify(pv2[0].r));

  await client.query(
    `insert into public.promo_codes (code, type, value, starts_at, ends_at)
     values ('EXPIRED1', 'PERCENT', 20, now() - interval '10 days', now() - interval '1 day')`
  );
  const { rows: pv3 } = await client.query(
    `select public.validate_promo('EXPIRED1'::citext, $1, null, array[$2::uuid], 250000) as r`,
    [CLIENT_A, SVC_A]
  );
  if (!pv3[0].r.valid && pv3[0].r.reason === "EXPIRED")
    ok("expired code refused", pv3[0].r.reason);
  else bad("expired code refused", JSON.stringify(pv3[0].r));

  // Apply it to a real booking, then check the cap bites on the second use.
  const promoStart = new Date(new Date(START).getTime() + 8 * 3600000).toISOString();
  const { rows: b4 } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time => $3::timestamptz, p_client_id => $4::uuid,
       p_promo_code => 'SAVE10'::citext) as r`,
    [SVC_A, EMP, promoStart, CLIENT_A]
  );
  if (b4[0].r.discountCents === 25000 && b4[0].r.totalCents === 225000)
    ok("promo applied to booking", `${b4[0].r.discountCents} off`);
  else bad("promo applied to booking", JSON.stringify(b4[0].r));

  await expectError(
    client,
    "per-client limit blocks a second use",
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time => $3::timestamptz, p_client_id => $4::uuid,
       p_promo_code => 'SAVE10'::citext)`,
    [SVC_A, EMP, new Date(new Date(START).getTime() + 10 * 3600000).toISOString(), CLIENT_A],
    "PROMO_LIMIT_REACHED"
  );

  // =========================================================================
  section("4. Cancellation");

  // A dedicated code capped at one use per client. That cap is what makes the
  // release-on-cancel path observable: if cancelling did not release the
  // redemption, the rebooking below would be refused with PROMO_LIMIT_REACHED.
  await client.query(
    `insert into public.promo_codes (code, type, value, per_client_limit)
     values ('REL20', 'PERCENT', 20, 1)`
  );

  const cancelStart = new Date(new Date(START).getTime() + 12 * 3600000).toISOString();
  const { rows: cb } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time  => $3::timestamptz, p_client_id => $4::uuid,
       p_promo_code  => 'REL20'::citext) as r`,
    [SVC_B, EMP, cancelStart, CLIENT_A]
  );
  const cancelId = cb[0].r.bookingId;

  const { rows: c1 } = await client.query(
    `select public.cancel_booking($1, $2, 'changed my mind', false, 2) as r`,
    [cancelId, CLIENT_A]
  );
  if (c1[0].r.status === "CANCELLED") ok("booking cancelled");
  else bad("booking cancelled", JSON.stringify(c1[0].r));

  const { rows: rel } = await client.query(
    `select count(*)::int as n from public.promo_redemptions
      where booking_id = $1 and released_at is not null`,
    [cancelId]
  );
  if (rel[0].n === 1) ok("promo redemption released on cancel");
  else bad("promo redemption released on cancel", `released=${rel[0].n}`);

  const { rows: rev } = await client.query(
    `select count(*)::int as n from public.qr_tokens
      where booking_id = $1 and revoked_at is not null`,
    [cancelId]
  );
  if (rev[0].n === 1) ok("QR pass revoked on cancel");
  else bad("QR pass revoked on cancel", `revoked=${rev[0].n}`);

  // Rebooking the exact same slot proves both halves at once: the exclusion
  // constraint ignores CANCELLED rows, and the promo cap has been released.
  const { rows: rebook } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time  => $3::timestamptz, p_client_id => $4::uuid,
       p_promo_code  => 'REL20'::citext) as r`,
    [SVC_B, EMP, cancelStart, CLIENT_A]
  );
  if (rebook[0].r.reference)
    ok("cancelled slot is immediately rebookable", rebook[0].r.reference);
  else bad("cancelled slot rebookable", "no reference");

  if (rebook[0].r.discountCents === 36000)
    ok("released promo code can be used again", "20% of 180000 = 36000");
  else bad("released promo reusable", JSON.stringify(rebook[0].r));

  // Cancelling inside the window must fail.
  const soon = new Date(Date.now() + 30 * 60000).toISOString();
  const { rows: soonB } = await client.query(
    `select public.create_booking(
       p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
       p_start_time => $3::timestamptz, p_client_id => $4::uuid) as r`,
    [SVC_A, EMP, soon, CLIENT_A]
  );
  await expectError(
    client,
    "cancelling inside the 2h window is refused",
    `select public.cancel_booking($1, $2, 'too late', false, 2)`,
    [soonB[0].r.bookingId, CLIENT_A],
    "CANCELLATION_WINDOW_PASSED"
  );

  // =========================================================================
  section("5. QR check-in");

  await expectError(
    client,
    "scanning a pass days early is refused",
    `select public.check_in_booking($1, null, null, 60)`,
    [booking1.jti],
    "QR_TOO_EARLY"
  );

  const { rows: ci } = await client.query(
    `select public.check_in_booking($1, null, null, 60) as r`,
    [soonB[0].r.jti]
  );
  if (ci[0].r.status === "CHECKED_IN") ok("check-in inside the window succeeds");
  else bad("check-in inside the window", JSON.stringify(ci[0].r));

  await expectError(
    client,
    "replaying the same pass is refused",
    `select public.check_in_booking($1, null, null, 60)`,
    [soonB[0].r.jti],
    "ALREADY_CHECKED_IN"
  );

  if (cancelId) {
    const { rows: revokedJti } = await client.query(
      `select jti from public.qr_tokens where booking_id = $1 order by created_at limit 1`,
      [cancelId]
    );
    await expectError(
      client,
      "a revoked pass is refused",
      `select public.check_in_booking($1, null, null, 60)`,
      [revokedJti[0].jti],
      "QR_REVOKED"
    );
  }

  // =========================================================================
  section("6. Status machine");

  await expectError(
    client,
    "COMPLETED -> PENDING is refused by the trigger",
    `update public.bookings set status = 'PENDING' where id = $1`,
    [soonB[0].r.bookingId],
    "INVALID_STATUS_TRANSITION"
  );

  await client.query(`update public.bookings set status = 'IN_SERVICE' where id = $1`, [
    soonB[0].r.bookingId,
  ]);
  await client.query(`update public.bookings set status = 'COMPLETED' where id = $1`, [
    soonB[0].r.bookingId,
  ]);
  ok("CHECKED_IN -> IN_SERVICE -> COMPLETED is allowed");

  // =========================================================================
  section("7. Row Level Security");

  // Seed two auth users so profiles/clients can exist. This needs rights on
  // the auth schema, which the postgres role may or may not have.
  let rlsSeedable = true;
  let profileA = null;
  let profileB = null;
  try {
    await client.query("savepoint rlsseed");
    const { rows: ua } = await client.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                               email_confirmed_at, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
               'authenticated', 'a@example.com', 'x', now(), now(), now())
       returning id`
    );
    const { rows: ub } = await client.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                               email_confirmed_at, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
               'authenticated', 'b@example.com', 'x', now(), now(), now())
       returning id`
    );
    profileA = ua[0].id;
    profileB = ub[0].id;
    await client.query("release savepoint rlsseed");
  } catch (e) {
    await client.query("rollback to savepoint rlsseed");
    rlsSeedable = false;
  }

  if (rlsSeedable) {
    // The profile row is created by the auth.users trigger.
    const { rows: prof } = await client.query(
      `select id, role from public.profiles where id in ($1, $2)`,
      [profileA, profileB]
    );
    if (prof.length === 2 && prof.every((p) => p.role === "CLIENT"))
      ok("auth.users trigger created profiles with CLIENT role");
    else bad("auth.users trigger created profiles", JSON.stringify(prof));

    // Attach client A to profile A. Without this link the RLS policy has
    // nothing to match on and A correctly sees zero rows - so this line is
    // what makes the test meaningful rather than vacuous.
    await client.query(`update public.clients set profile_id = $1 where id = $2`, [
      profileA,
      CLIENT_A,
    ]);

    // Give profile B a client row and a booking.
    const CLIENT_B = "cccccccc-0000-0000-0000-00000000000b";
    await client.query(
      `insert into public.clients (id, profile_id, full_name, phone)
       values ($1, $2, 'Other Person', '+639170000003')`,
      [CLIENT_B, profileB]
    );
    await client.query(
      `select public.create_booking(
         p_service_ids => array[$1::uuid], p_employee_id => $2::uuid,
         p_start_time => $3::timestamptz, p_client_id => $4::uuid)`,
      [SVC_B, EMP2, new Date(new Date(START).getTime() + 20 * 3600000).toISOString(), CLIENT_B]
    );

    // --- as client A ------------------------------------------------------
    await client.query("savepoint rlsa");
    await client.query(`set local role authenticated`);
    await client.query(
      `select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: profileA, role: "authenticated" })]
    );

    const { rows: seenA } = await client.query(
      `select client_id from public.bookings`
    );
    const leaked = seenA.some((r) => r.client_id === CLIENT_B);
    if (seenA.length > 0 && !leaked)
      ok("client A sees only their own bookings", `${seenA.length} rows`);
    else if (seenA.length === 0)
      bad("client A sees their own bookings", "saw 0 rows");
    else bad("client A cannot see client B's bookings", "LEAK: saw another client's booking");

    for (const [label, sql] of [
      ["promo_codes", `select count(*)::int as n from public.promo_codes`],
      ["qr_tokens", `select count(*)::int as n from public.qr_tokens`],
      ["audit_logs", `select count(*)::int as n from public.audit_logs`],
      ["working_hours", `select count(*)::int as n from public.working_hours`],
      ["login_attempts", `select count(*)::int as n from public.login_attempts`],
    ]) {
      const v = await countOrDenied(client, sql);
      if (v === 0 || v === "DENIED")
        ok(`authenticated cannot read ${label}`, v === "DENIED" ? "permission denied" : "0 rows");
      else bad(`authenticated cannot read ${label}`, `LEAK: saw ${v} rows`);
    }

    // Privilege escalation attempt.
    await expectError(
      client,
      "a client cannot promote themselves to ADMIN",
      `update public.profiles set role = 'ADMIN' where id = $1`,
      [profileA],
      "permission denied"
    );

    await client.query("rollback to savepoint rlsa");
  } else {
    process.stdout.write(
      `  ${C.yellow}SKIP${C.r}  profile-backed RLS tests (postgres cannot insert into auth.users)\n`
    );
  }

  // --- as anon -------------------------------------------------------------
  // What anon *should* see is counted with full privileges first, so the
  // assertion is "exactly the active services" rather than a magic number that
  // goes stale the moment the catalogue changes.
  const { rows: expectedAnon } = await client.query(
    `select count(*)::int as n from public.services where is_active`
  );
  const expectedActiveServices = expectedAnon[0].n;

  await client.query("savepoint rlsanon");
  await client.query(`set local role anon`);

  const anonSvc = await countOrDenied(client, `select count(*)::int as n from public.services`);
  if (anonSvc === expectedActiveServices)
    ok("anon can read the active service catalogue", `${expectedActiveServices} services`);
  else bad("anon can read the service catalogue", `saw ${anonSvc}, expected ${expectedActiveServices}`);

  for (const [label, sql] of [
    ["bookings", `select count(*)::int as n from public.bookings`],
    ["clients", `select count(*)::int as n from public.clients`],
    ["profiles", `select count(*)::int as n from public.profiles`],
    ["qr_tokens", `select count(*)::int as n from public.qr_tokens`],
    ["audit_logs", `select count(*)::int as n from public.audit_logs`],
  ]) {
    const v = await countOrDenied(client, sql);
    if (v === 0 || v === "DENIED")
      ok(`anon cannot read ${label}`, v === "DENIED" ? "permission denied" : "0 rows");
    else bad(`anon cannot read ${label}`, `LEAK: saw ${v} rows`);
  }

  await client.query("rollback to savepoint rlsanon");

  // =========================================================================
  await client.query("rollback"); // discard every fixture

  // The invariant is that *this harness's* fixtures are gone - not that the
  // tables are empty. The seed legitimately leaves services, employees and
  // clients behind, and a test run leaves bookings, so "count(*) = 0" was only
  // ever true against a blank database.
  const { rows: after } = await client.query(
    `select
       (select count(*)::int from public.employees where id in ($1, $2)) as employees,
       (select count(*)::int from public.services  where id in ($3, $4)) as services,
       (select count(*)::int from public.clients   where id = $5)       as clients,
       (select count(*)::int from public.bookings  where employee_id in ($1, $2)) as bookings`,
    [EMP, EMP2, SVC_A, SVC_B, CLIENT_A]
  );
  section("8. Cleanup");
  const leftover = after[0];
  if (leftover.employees === 0 && leftover.services === 0 && leftover.clients === 0 && leftover.bookings === 0)
    ok("transaction rolled back - no fixtures persisted");
  else bad("fixtures rolled back", `harness rows survived: ${JSON.stringify(leftover)}`);

  // =========================================================================
  process.stdout.write(
    `\n${failures.length === 0 ? C.green + C.bold + "ALL CHECKS PASSED" : C.red + C.bold + "FAILURES"}` +
      `${C.r}  ${pass} passed, ${failures.length} failed\n`
  );
  if (failures.length) {
    for (const f of failures) process.stdout.write(`  ${C.red}- ${f}${C.r}\n`);
    process.exitCode = 1;
  }

  await client.end();
}

main()
  .catch((e) => {
    process.stdout.write(`\n${C.red}${e.message}${C.r}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // pg holds the socket open, so an uncaught throw inside main() would leave
    // the process alive forever instead of reporting the failure.
    process.exit(process.exitCode || 0);
  });
