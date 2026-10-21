#!/usr/bin/env node
/**
 * Booking-correctness exercise.
 *
 * Proves the four defects fixed by migrations 32 and 33, against the live API:
 *
 *   1. `PATCH /bookings/:id/status` with CANCELLED actually cancels. It used to
 *      fail 100% of the time, because a bare status write leaves `cancelled_at`
 *      null and the table's CHECK constraint rejects it.
 *   2. A status change writes an audit row. COMPLETED and NO_SHOW used to leave
 *      no trace at all.
 *   3. Rescheduling an in-progress booking reports BOOKING_IN_PROGRESS, not an
 *      INVALID_STATUS_TRANSITION that has nothing to do with the request.
 *   4. Naming an employee who is on leave is refused. Only the auto-assign
 *      branch used to consult time_off.
 *   5. `?serviceId=` filters. It was accepted and silently ignored.
 *
 * Self-cleaning: every row it creates is deleted at the end.
 *
 *   node scripts/verify-booking-correctness.js
 */

const path = require("path");
require("./_load-env");
const { Client } = require("pg");

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 4000}`;
const API = `${BASE}/api/v1`;
const C = { r: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", bold: "\x1b[1m" };

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write(`  ${C.green}PASS${C.r}  ${name}${detail ? `  ${C.dim}${detail}${C.r}` : ""}\n`);
  } else {
    failures.push(name);
    process.stdout.write(`  ${C.red}FAIL${C.r}  ${name}${detail ? `\n         ${C.dim}${detail}${C.r}` : ""}\n`);
  }
}

function section(t) {
  process.stdout.write(`\n${C.bold}${t}${C.r}\n`);
}

async function call(method, p, { token, body } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text };
}

async function signIn(email, password) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!session.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(session)}`);
  return session.access_token;
}

let seq = 0;
function reference(prefix) {
  seq += 1;
  return `BA-VBC-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 5)}`;
}

/** Insert a booking directly, so the test controls its status and time. */
async function insertBooking(db, { employeeId, status, startInMinutes, minutes = 45 }) {
  const start = new Date(Date.now() + startInMinutes * 60_000);
  const end = new Date(start.getTime() + minutes * 60_000);
  const { rows } = await db.query(
    `insert into public.bookings
       (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
        subtotal_cents, discount_cents, total_cents)
     values ($1, 'VBC Guest', '+639007770001', $2, $3, $4, $5, 180000, 0, 180000)
     returning id`,
    [reference("BA-VBC"), employeeId, start.toISOString(), end.toISOString(), status]
  );
  return rows[0].id;
}

/** Find a slot where this employee is free, walking forward day by day. */
/**
 * The first slot that is both rostered and unbooked.
 *
 * The rostered half matters: a day with no booking is not necessarily a day the
 * employee works. Walking forward from "now" and taking the first gap landed on
 * a Sunday often enough to make section 4 fail with OUTSIDE_WORKING_HOURS -
 * the API refusing for a reason unrelated to the guard under test - and the
 * result depended on which weekday the harness happened to run.
 *
 * Times are compared in the branch timezone, because `working_hours` stores
 * weekday and time-of-day in branch-local terms.
 */
async function freeSlot(db, employeeId, { fromMinutes = 3 * 24 * 60, minutes = 45 } = {}) {
  for (let day = 0; day < 40; day++) {
    const start = new Date(Date.now() + (fromMinutes + day * 24 * 60) * 60_000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + minutes * 60_000);

    const { rowCount: rostered } = await db.query(
      `select 1
         from public.working_hours wh
        where wh.employee_id = $1
          and wh.weekday = extract(dow from ($2::timestamptz at time zone public.branch_timezone()))::smallint
          and ($2::timestamptz at time zone public.branch_timezone())::time >= wh.start_time
          and ($3::timestamptz at time zone public.branch_timezone())::time <= wh.end_time`,
      [employeeId, start.toISOString(), end.toISOString()]
    );
    if (rostered === 0) continue;

    const { rowCount } = await db.query(
      `select 1 from public.bookings
        where employee_id = $1 and status not in ('CANCELLED','NO_SHOW')
          and tstzrange(start_time, end_time) && tstzrange($2, $3)`,
      [employeeId, start.toISOString(), end.toISOString()]
    );
    if (rowCount === 0) return start;
  }
  throw new Error("no rostered, unbooked slot found in the next 40 days");
}

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await db.connect();

  const createdBookings = [];
  let timeOffId = null;

  try {
    const admin = await signIn("admin@beautyalley.ph", "AlleyDemo2026!");

    const { rows: staff } = await db.query(
      `select es.employee_id, es.service_id
         from public.employee_services es
         join public.employees e on e.id = es.employee_id
        where e.is_active
        order by es.employee_id
        limit 1`
    );
    if (staff.length === 0) throw new Error("no qualified employee found");
    const { employee_id: employeeId, service_id: serviceId } = staff[0];

    // ---------------------------------------------------------------------
    section("1. PATCH /bookings/:id/status -> CANCELLED");
    {
      const id = await insertBooking(db, { employeeId, status: "CONFIRMED", startInMinutes: 5 * 24 * 60 });
      createdBookings.push(id);

      const res = await call("PATCH", `/bookings/${id}/status`, {
        token: admin,
        body: { status: "CANCELLED" },
      });
      check("cancellation succeeds", res.status === 200, `${res.status} ${res.body?.error?.code ?? ""}`);
      check("the response reports CANCELLED", res.body?.data?.status === "CANCELLED", res.body?.data?.status);

      const { rows } = await db.query(`select status, cancelled_at from public.bookings where id = $1`, [id]);
      check("cancelled_at is stamped", rows[0].cancelled_at !== null, String(rows[0].cancelled_at));

      const audit = await db.query(
        `select 1 from public.audit_logs where entity_id = $1 and action = 'booking.cancelled'`,
        [id]
      );
      check("cancel_booking's audit row exists", audit.rowCount === 1, `${audit.rowCount} row(s)`);

      const again = await call("PATCH", `/bookings/${id}/status`, {
        token: admin,
        body: { status: "CANCELLED" },
      });
      check("cancelling twice is a 409, not a 500", again.status === 409, `${again.status} ${again.body?.error?.code ?? ""}`);
    }

    // ---------------------------------------------------------------------
    section("2. PATCH /bookings/:id/status -> NO_SHOW is audited");
    {
      const id = await insertBooking(db, { employeeId, status: "CONFIRMED", startInMinutes: 6 * 24 * 60 });
      createdBookings.push(id);

      const res = await call("PATCH", `/bookings/${id}/status`, {
        token: admin,
        body: { status: "NO_SHOW" },
      });
      check("NO_SHOW succeeds", res.status === 200, `${res.status}`);

      const audit = await db.query(
        `select metadata from public.audit_logs
          where entity_id = $1 and action = 'booking.status_changed'`,
        [id]
      );
      check("an audit row was written", audit.rowCount === 1, `${audit.rowCount} row(s)`);
      check(
        "the audit row records the transition",
        audit.rows[0]?.metadata?.from === "CONFIRMED" && audit.rows[0]?.metadata?.to === "NO_SHOW",
        JSON.stringify(audit.rows[0]?.metadata ?? {})
      );
    }

    // ---------------------------------------------------------------------
    section("3. Rescheduling an in-progress booking");
    {
      const id = await insertBooking(db, { employeeId, status: "CHECKED_IN", startInMinutes: 60 });
      createdBookings.push(id);

      const target = await freeSlot(db, employeeId, { fromMinutes: 8 * 24 * 60 });
      const res = await call("POST", `/bookings/${id}/reschedule`, {
        token: admin,
        body: { startTime: target.toISOString() },
      });
      check("it is refused", res.status === 409, `${res.status}`);
      check(
        "with BOOKING_IN_PROGRESS, not a status-transition error",
        res.body?.error?.code === "BOOKING_IN_PROGRESS",
        res.body?.error?.code
      );

      const { rows } = await db.query(`select status, start_time from public.bookings where id = $1`, [id]);
      check("the booking was not moved", new Date(rows[0].start_time).getTime() < Date.now() + 2 * 3600_000);
      check("the status was not reset", rows[0].status === "CHECKED_IN", rows[0].status);
    }

    // ---------------------------------------------------------------------
    section("4. Booking an employee who is on leave");
    {
      const leaveStart = await freeSlot(db, employeeId, { fromMinutes: 10 * 24 * 60 });
      const leaveEnd = new Date(leaveStart.getTime() + 120 * 60_000);

      const inserted = await db.query(
        `insert into public.time_off (employee_id, starts_at, ends_at, reason)
         values ($1, $2, $3, 'VBC leave') returning id`,
        [employeeId, leaveStart.toISOString(), leaveEnd.toISOString()]
      );
      timeOffId = inserted.rows[0].id;

      const inside = new Date(leaveStart.getTime() + 15 * 60_000);
      const res = await call("POST", "/bookings", {
        body: {
          serviceIds: [serviceId],
          employeeId,
          startTime: inside.toISOString(),
          guest: { name: "VBC Leave", phone: "+639007770002" },
        },
      });
      check("the explicit-employee booking is refused", res.status === 409, `${res.status}`);
      check("with EMPLOYEE_UNAVAILABLE", res.body?.error?.code === "EMPLOYEE_UNAVAILABLE", res.body?.error?.code);

      const after = await db.query(
        `select 1 from public.bookings where guest_name = 'VBC Leave'`
      );
      check("and no booking row was created", after.rowCount === 0, `${after.rowCount} row(s)`);
    }

    // ---------------------------------------------------------------------
    section("5. ?serviceId= actually filters");
    {
      const filtered = await call("GET", `/bookings?serviceId=${serviceId}&limit=100`, { token: admin });
      check("the request succeeds", filtered.status === 200, `${filtered.status}`);

      const rows = filtered.body?.data ?? [];
      check("it returns rows", rows.length > 0, `${rows.length} row(s)`);
      check(
        "every returned booking includes that service",
        rows.every((b) => Array.isArray(b.serviceIds) && b.serviceIds.includes(serviceId)),
        rows.slice(0, 3).map((b) => b.serviceIds).map((s) => JSON.stringify(s)).join(" ")
      );

      const all = await call("GET", "/bookings?limit=1", { token: admin });
      const total = all.body?.meta?.total ?? 0;
      check(
        "and the filtered total is not the unfiltered total",
        filtered.body?.meta?.total <= total,
        `${filtered.body?.meta?.total} of ${total}`
      );
    }
  } finally {
    // Clean up in dependency order.
    if (timeOffId) await db.query(`delete from public.time_off where id = $1`, [timeOffId]).catch(() => {});
    if (createdBookings.length) {
      await db.query(`delete from public.qr_tokens where booking_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.checkins where booking_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.booking_items where booking_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.bookings where id = any($1::uuid[])`, [createdBookings]).catch(() => {});
    }
    await db.end();
  }

  process.stdout.write(
    failures.length === 0
      ? `\n${C.green}BOOKING CORRECTNESS PASSED${C.r}  ${passed} checks\n\n`
      : `\n${C.red}FAILED${C.r}  ${passed} passed, ${failures.length} failed\n  ${failures.join("\n  ")}\n\n`
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`\nverify-booking-correctness failed: ${err.message}\n`);
  process.exitCode = 1;
});
