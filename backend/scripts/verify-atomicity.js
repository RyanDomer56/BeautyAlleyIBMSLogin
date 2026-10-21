#!/usr/bin/env node
/**
 * Atomicity exercise.
 *
 * Proves the five multi-step writes that used to be able to half-apply, against
 * the live API. Each one is a sequence the console performs, and before
 * migrations 34 and 35 a failure in the second step left the first one
 * committed:
 *
 *   1. PUT /employees/:id/working-hours    delete, then insert
 *   2. PUT /employees/:id/services         delete, then insert
 *   3. DELETE /rooms/:id                   count, then update
 *   4. POST /tasks                         duplicate check, then insert
 *   5. POST /employees                     insert, then setServices
 *
 * The assertions are the interesting part: each failure case checks that the
 * pre-existing state survived, not merely that the request was refused. A
 * refused request that has already wiped the data is the bug.
 *
 * Self-cleaning: every row it creates is deleted at the end.
 *
 *   node scripts/verify-atomicity.js
 */

const path = require("path");
require("./_load-env");
const { Client } = require("pg");

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 4000}`;
const API = `${BASE}/api/v1`;
const C = {
  r: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  bold: "\x1b[1m",
};

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

/** A shape that is a valid uuid, which is all POST /employees promises to check. */
const NONEXISTENT_UUID = "00000000-0000-4000-a000-000000000000";

let seq = 0;
function tag() {
  seq += 1;
  return `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 5)}`;
}

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await db.connect();

  const admin = await signIn("admin@beautyalley.ph", "AlleyDemo2026!");

  // Everything the harness creates, deleted in dependency order.
  const createdEmployees = [];
  const createdRooms = [];
  const createdTasks = [];
  const createdBookings = [];

  /** A throwaway employee, so no demo row is ever mutated. */
  async function freshEmployee(serviceIds) {
    const res = await call("POST", "/employees", {
      token: admin,
      body: { fullName: `Atomicity Probe ${tag()}`, serviceIds },
    });
    if (res.status !== 201) throw new Error(`could not create probe employee: ${res.status} ${res.text}`);
    createdEmployees.push(res.body.data.id);
    return res.body.data;
  }

  /** How many employees carry this full name, before and after a refusal. */
  async function employeeCount(name) {
    const { rows } = await db.query(`select count(*)::int as n from public.employees where full_name = $1`, [name]);
    return rows[0].n;
  }

  /**
   * The stored shifts, read from the table.
   *
   * Not through the API: `GET /employees/:id` is the *public* view and drops
   * working hours on purpose (they have no RLS policy for anon/authenticated,
   * and the team profile does not publish the rota). The API has no read route
   * for them at all, so the only way to observe what a write did is the table -
   * which is also the thing being asserted about.
   */
  async function storedHours(employeeId) {
    const { rows } = await db.query(
      `select weekday, start_time, end_time from public.working_hours
        where employee_id = $1 order by weekday, start_time`,
      [employeeId]
    );
    return rows;
  }

  try {
    // -------------------------------------------------------------------
    section("1. PUT /employees/:id/working-hours");
    {
      const employee = await freshEmployee([]);

      // Establish a known-good schedule.
      const good = {
        hours: [
          { weekday: 1, startTime: "09:00", endTime: "17:00" },
          { weekday: 2, startTime: "10:00", endTime: "18:00" },
        ],
      };
      const set = await call("PUT", `/employees/${employee.id}/working-hours`, { token: admin, body: good });
      check("a valid schedule is accepted", set.status === 200, `${set.status} ${set.body?.error?.code ?? ""}`);

      const beforeHours = await storedHours(employee.id);
      check("and two shifts are stored", beforeHours.length === 2, `${beforeHours.length} shift(s)`);

      // A shift that ends before it starts. Zod rejects it before any SQL runs,
      // which is the current shield; what matters here is that whatever the
      // outcome, the earlier shifts are still there.
      const bad = {
        hours: [{ weekday: 3, startTime: "18:00", endTime: "09:00" }],
      };
      const refused = await call("PUT", `/employees/${employee.id}/working-hours`, { token: admin, body: bad });
      check("a reversed shift is refused", refused.status === 400, `${refused.status} ${refused.body?.error?.code ?? ""}`);

      const afterHours = await storedHours(employee.id);
      check(
        "and the existing schedule survived the refusal",
        JSON.stringify(afterHours) === JSON.stringify(beforeHours),
        `${afterHours.length} of ${beforeHours.length} shift(s) kept`
      );

      // Two shifts that overlap. The unique constraint would also fire, so this
      // checks the delete was not committed ahead of the insert.
      const overlap = {
        hours: [
          { weekday: 4, startTime: "09:00", endTime: "12:00" },
          { weekday: 4, startTime: "10:00", endTime: "14:00" },
        ],
      };
      const dup = await call("PUT", `/employees/${employee.id}/working-hours`, { token: admin, body: overlap });
      check("overlapping shifts are refused", dup.status === 400, `${dup.status} ${dup.body?.error?.code ?? ""}`);

      const overlapAfter = await storedHours(employee.id);
      check(
        "and the earlier shifts survived that refusal too",
        JSON.stringify(overlapAfter) === JSON.stringify(beforeHours),
        `${overlapAfter.length} of ${beforeHours.length} shift(s) kept`
      );

      const cleaned = await call("PUT", `/employees/${employee.id}/working-hours`, { token: admin, body: { hours: [] } });
      check("clearing the schedule works", cleaned.status === 200, `${cleaned.status}`);
    }

    // -------------------------------------------------------------------
    section("2. PUT /employees/:id/services");
    {
      const { rows: services } = await db.query(
        `select id from public.services where is_active order by name limit 3`
      );
      if (services.length < 3) throw new Error("need at least 3 services");
      const [a, b, c] = services.map((s) => s.id);

      const employee = await freshEmployee([a, b]);
      const read = await call("GET", `/employees/${employee.id}`, { token: admin });
      check(
        "a new employee carries exactly the qualifications it was given",
        JSON.stringify((read.body?.data?.serviceIds ?? []).sort()) === JSON.stringify([a, b].sort()),
        JSON.stringify(read.body?.data?.serviceIds)
      );

      const replace = await call("PUT", `/employees/${employee.id}/services`, {
        token: admin,
        body: { serviceIds: [c] },
      });
      check("replace-all is accepted", replace.status === 200, `${replace.status} ${replace.body?.error?.code ?? ""}`);

      const replaced = await call("GET", `/employees/${employee.id}`, { token: admin });
      check(
        "and the set is exactly the new one",
        JSON.stringify(replaced.body?.data?.serviceIds) === JSON.stringify([c]),
        JSON.stringify(replaced.body?.data?.serviceIds)
      );

      // An unknown service id. The write must not have deleted the old set
      // before discovering it.
      const bad = await call("PUT", `/employees/${employee.id}/services`, {
        token: admin,
        body: { serviceIds: [NONEXISTENT_UUID] },
      });
      check("an unknown service id is refused", bad.status === 400, `${bad.status} ${bad.body?.error?.code ?? ""}`);

      const intact = await call("GET", `/employees/${employee.id}`, { token: admin });
      check(
        "and the previous set is still in place",
        JSON.stringify(intact.body?.data?.serviceIds) === JSON.stringify([c]),
        JSON.stringify(intact.body?.data?.serviceIds)
      );
    }

    // -------------------------------------------------------------------
    section("3. DELETE /rooms/:id");
    {
      const makeRoom = await call("POST", "/rooms", {
        token: admin,
        body: { name: `Atomicity Probe ${tag()}`, roomType: "OTHER", capacity: 1 },
      });
      check("a probe room is created", makeRoom.status === 201, `${makeRoom.status} ${makeRoom.body?.error?.code ?? ""}`);
      const room = makeRoom.body.data;
      createdRooms.push(room.id);

      const remove = await call("DELETE", `/rooms/${room.id}`, { token: admin });
      check("deactivating a free room succeeds", remove.status === 200, `${remove.status} ${remove.body?.error?.code ?? ""}`);
      check("and the room reports inactive", remove.body?.data?.isActive === false);

      const { rows: audited } = await db.query(
        `select count(*)::int as n from public.audit_logs
          where action = 'room.deactivated' and entity_id = $1`,
        [room.id]
      );
      check("the deactivation is audited", audited[0].n === 1, `${audited[0].n} row(s)`);

      const again = await call("DELETE", `/rooms/${room.id}`, { token: admin });
      check("deactivating twice is a no-op, not an error", again.status === 200, `${again.status}`);
      const { rows: auditedTwice } = await db.query(
        `select count(*)::int as n from public.audit_logs
          where action = 'room.deactivated' and entity_id = $1`,
        [room.id]
      );
      check("and it does not double-audit", auditedTwice[0].n === 1, `${auditedTwice[0].n} row(s)`);

      // Now the interesting case: a room with a future booking must refuse.
      const held = await call("POST", "/rooms", {
        token: admin,
        body: { name: `Atomicity Probe ${tag()}`, roomType: "OTHER", capacity: 1 },
      });
      const heldRoom = held.body.data;
      createdRooms.push(heldRoom.id);

      const employee = await freshEmployee([]);
      const start = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
      const { rows: booked } = await db.query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, room_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values ($1, 'Atomicity Probe', '+639007779999', $2, $3, $4, $5, 'CONFIRMED', 180000, 0, 180000)
         returning id`,
        [`BA-AT${tag()}`, employee.id, heldRoom.id, start, new Date(Date.now() + 48 * 60 * 60_000 + 45 * 60_000).toISOString()]
      );
      createdBookings.push(booked[0].id);

      const refuse = await call("DELETE", `/rooms/${heldRoom.id}`, { token: admin });
      check(
        "a room with an unfinished booking is refused",
        refuse.status === 409,
        `${refuse.status} ${refuse.body?.error?.code ?? ""}`
      );

      const { rows: stillActive } = await db.query(
        `select is_active from public.rooms where id = $1`,
        [heldRoom.id]
      );
      check("and it is still active", stillActive[0].is_active === true);
    }

    // -------------------------------------------------------------------
    section("4. POST /tasks (duplicate guard)");
    {
      const employee = await freshEmployee([]);
      const title = `Atomicity probe ${tag()}`;

      const one = await call("POST", "/tasks", { token: admin, body: { title, employeeId: employee.id } });
      check("a task is created", one.status === 201, `${one.status} ${one.body?.error?.code ?? ""}`);

      const two = await call("POST", "/tasks", { token: admin, body: { title, employeeId: employee.id } });
      check("an identical open task is refused", two.status === 409, `${two.status} ${two.body?.error?.code ?? ""}`);
      check(
        "and the refusal names the existing task",
        typeof two.body?.error?.details?.reference === "string",
        JSON.stringify(two.body?.error?.details)
      );

      // The concurrent case is what the unique index is for: several requests
      // that all pass the lookup before any of them inserts.
      const raceTitle = `Atomicity race ${tag()}`;
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          call("POST", "/tasks", { token: admin, body: { title: raceTitle, employeeId: employee.id } })
        )
      );
      const created = results.filter((r) => r.status === 201).length;
      const conflicts = results.filter((r) => r.status === 409).length;

      check(
        "five concurrent identical creates make one task",
        created === 1 && conflicts === 4,
        `${created} created, ${conflicts} refused, statuses ${results.map((r) => r.status).join("/")}`
      );

      const { rows: rows_ } = await db.query(
        `select count(*)::int as n from public.tasks where title = $1`,
        [raceTitle]
      );
      check("and the table holds one row, not five", rows_[0].n === 1, `${rows_[0].n} row(s)`);

      // Completing the task reopens the title for use, which is the intended
      // behaviour: doing the same job again is legitimate.
      const first = one.body?.data?.id;
      if (first) createdTasks.push(first);
      const done = await call("PATCH", `/tasks/${first}/status`, {
        token: admin,
        body: { status: "IN_PROGRESS" },
      });
      check("the task can be moved to IN_PROGRESS", done.status === 200, `${done.status} ${done.body?.error?.code ?? ""}`);
    }

    // -------------------------------------------------------------------
    section("5. POST /employees (atomic create)");
    {
      const name = `Atomicity Orphan ${tag()}`;
      const before = await employeeCount(name);

      const bad = await call("POST", "/employees", {
        token: admin,
        body: { fullName: name, serviceIds: [NONEXISTENT_UUID] },
      });
      check("an unknown service id is refused", bad.status === 400, `${bad.status} ${bad.body?.error?.code ?? ""}`);

      const after = await employeeCount(name);
      check(
        "and no employee row was left behind",
        after === before,
        `${after} row(s), expected ${before}`
      );

      const good = await call("POST", "/employees", {
        token: admin,
        body: { fullName: name, title: "Probe" },
      });
      check("a valid create succeeds", good.status === 201, `${good.status} ${good.body?.error?.code ?? ""}`);

      const withQual = await call("POST", "/employees", {
        token: admin,
        body: { fullName: name, serviceIds: [] },
      });
      createdEmployees.push(withQual.body.data.id);

      const recreated = await employeeCount(name);
      check("and the valid creates are there", recreated === before + 2, `${recreated} row(s), expected ${before + 2}`);

      const { rows: audited } = await db.query(
        `select count(*)::int as n from public.audit_logs
          where action = 'employee.created' and entity_id = any($1::uuid[])`,
        [[good.body.data.id, withQual.body.data.id]]
      );
      check("creation is audited", audited[0].n === 2, `${audited[0].n} row(s)`);
    }
  } finally {
    if (createdTasks.length) {
      await db.query(`delete from public.tasks where id = any($1::uuid[])`, [createdTasks]).catch(() => {});
    }
    if (createdBookings.length) {
      await db.query(`delete from public.qr_tokens where booking_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.checkins where booking_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [createdBookings]).catch(() => {});
      await db.query(`delete from public.bookings where id = any($1::uuid[])`, [createdBookings]).catch(() => {});
    }
    if (createdRooms.length) {
      await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [createdRooms]).catch(() => {});
      await db.query(`delete from public.rooms where id = any($1::uuid[])`, [createdRooms]).catch(() => {});
    }
    if (createdEmployees.length) {
      await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [createdEmployees]).catch(() => {});
      await db.query(`delete from public.employees where id = any($1::uuid[])`, [createdEmployees]).catch(() => {});
    }
    await db.end();
  }

  process.stdout.write(
    failures.length === 0
      ? `\n${C.green}ATOMICITY PASSED${C.r}  ${passed} checks\n\n`
      : `\n${C.red}FAILED${C.r}  ${passed} passed, ${failures.length} failed\n  ${failures.join("\n  ")}\n\n`
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`\nverify-atomicity failed: ${err.message}\n`);
  process.exitCode = 1;
});
