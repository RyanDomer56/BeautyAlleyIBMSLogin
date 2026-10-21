#!/usr/bin/env node
/**
 * End-to-end arrival-pass exercise.
 *
 * The brief's section 7.5 says a "Confirm Arrival" must:
 *
 *   - update the reservation and record the check-in date/time,
 *   - associate the concierge who did it,
 *   - prevent duplicates,
 *   - make the status visible to the assigned employee,
 *   - and **must not** mark the service completed or the payment paid.
 *
 * The Jest suite proves the rules in-process and `smoke.js` proves the built
 * artefact serves them, but neither drives the *whole* lifecycle against the
 * live server with the real demo logins. This does, so that "the demo concierge
 * can check a guest in" is a fact and not an inference.
 *
 * It is self-cleaning: everything it creates is deleted at the end.
 *
 *   node scripts/verify-arrival-pass.js        # or: npm run verify:arrival
 */

const path = require("path");
const fs = require("fs");
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

/** Sign in one of the tracked demo accounts, exactly as the login page does. */
async function signIn(email, password) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const session = await res.json();
  if (!session.access_token) {
    throw new Error(`sign-in failed for ${email}: ${JSON.stringify(session)}`);
  }
  return session.access_token;
}

/**
 * A booking that is scannable right now.
 *
 * The pass opens `QR_CHECKIN_WINDOW_MINUTES` before the appointment starts and
 * closes when it ends, so the start has to sit inside
 * `[now - duration, now + window]`. The demo grid runs 45-minute treatments, so
 * a 30-minute booking at a 5-minute granularity is the smallest thing that can
 * reliably find a free gap; stylists are tried in turn because one of them can
 * genuinely be booked solid across the window.
 */
async function insertCheckinableBooking(db, employeeIds, reference) {
  const windowMs = Number(process.env.QR_CHECKIN_WINDOW_MINUTES || 60) * 60_000;
  const durationMs = 30 * 60_000;
  const step = 5 * 60_000;

  for (const employeeId of employeeIds) {
    for (let offset = windowMs - step; offset >= -(durationMs - step); offset -= step) {
      const start = new Date(Date.now() + offset);
      const end = new Date(start.getTime() + durationMs);
      try {
        const inserted = await db.query(
          `insert into public.bookings
             (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
              subtotal_cents, discount_cents, total_cents)
           values ($1, 'E2E Arrival', '+639009990004', $2, $3, $4, 'CONFIRMED', 180000, 0, 180000)
           returning id`,
          [reference, employeeId, start.toISOString(), end.toISOString()]
        );
        return { id: inserted.rows[0].id, employeeId };
      } catch (err) {
        if (err.code === "23P01") continue; // slot taken - try the next offset
        throw err;
      }
    }
  }
  throw new Error("no check-in-able slot was free for any stylist");
}

/**
 * A booking some days out, for the checks that only need a row to exist.
 *
 * Walks forward day by day until the insert is accepted. A fixed "now + N
 * days" is exactly the mistake this project's notes warn about: the Jest
 * suites leave guest bookings behind (a booking with no `client_id` is not
 * owned by a profile, so deleting the test users never removes it), and one of
 * them can be sitting in whichever slot this script picked. Attempting the
 * insert and moving on `23P01` lets the EXCLUDE constraint be the oracle
 * instead of restating the rule here.
 */
async function insertFutureBooking(db, { clientId, employeeId, startDaysAhead = 3 }) {
  for (let days = startDaysAhead; days < startDaysAhead + 30; days += 1) {
    const start = new Date(Date.now() + days * 86_400_000);
    const end = new Date(start.getTime() + 45 * 60_000);
    try {
      const { rows } = await db.query(
        `insert into public.bookings
           (reference, client_id, employee_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values ($1, $2, $3, $4, $5, 'CONFIRMED', 180000, 0, 180000)
         returning id`,
        [
          `BA-E2E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          clientId,
          employeeId,
          start.toISOString(),
          end.toISOString(),
        ]
      );
      return rows[0].id;
    } catch (err) {
      if (err.code === "23P01") continue; // that day is taken - try the next
      throw err;
    }
  }
  throw new Error("no free future slot found for a fixture booking");
}

async function main() {
  const created = { bookings: [] };
  const demo = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "demo-accounts.json"), "utf8")
  );
  const byRole = Object.fromEntries(demo.accounts.map((a) => [a.role, a]));

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    // -----------------------------------------------------------------------
    section("1. The demo logins still work (section 6)");

    const tokens = {};
    for (const role of ["ADMIN", "CONCIERGE", "EMPLOYEE", "CLIENT"]) {
      tokens[role] = await signIn(byRole[role].email, demo.password);
    }
    check("all four demo accounts sign in", Object.values(tokens).every((t) => typeof t === "string"));

    const meConcierge = await call("GET", "/auth/me", { token: tokens.CONCIERGE });
    check(
      "the concierge demo account reports the CONCIERGE role",
      meConcierge.status === 200 && meConcierge.body?.data?.role === "CONCIERGE",
      `${meConcierge.status} ${meConcierge.body?.data?.role}`
    );

    const meEmployee = await call("GET", "/auth/me", { token: tokens.EMPLOYEE });
    check(
      "the employee demo account is still linked to an employee record",
      meEmployee.status === 200 && Boolean(meEmployee.body?.data?.employeeId),
      `employeeId=${meEmployee.body?.data?.employeeId}`
    );

    // -----------------------------------------------------------------------
    section("2. A guest books, and the pass carries no personal data");

    const { rows: stylists } = await db.query(
      `select id from public.employees
        where is_active and profile_id is not null
        order by (id = $1) desc, id`,
      [byRole.EMPLOYEE.employeeId]
    );
    const stylistIds = stylists.map((r) => r.id);
    check("there is at least one linked, active stylist", stylistIds.length > 0, `${stylistIds.length}`);

    const reference = `BA-E2E-${Date.now()}`;
    const { id: bookingId, employeeId } = await insertCheckinableBooking(db, stylistIds, reference);
    created.bookings.push(bookingId);
    await db.query(
      `insert into public.qr_tokens (booking_id, expires_at) values ($1, now() + interval '2 days')`,
      [bookingId]
    );

    const qr = await call("GET", `/bookings/${bookingId}/qr`, { token: tokens.CONCIERGE });
    const pass = qr.body?.data?.pass;
    check("GET /bookings/:id/qr issues a signed pass", qr.status === 200 && typeof pass === "string",
      `${qr.status} ${String(pass).slice(0, 12)}...`);

    const parts = String(pass).split(".");
    let payload = {};
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      /* handled by the assertions below */
    }
    const payloadKeys = Object.keys(payload).sort();
    check(
      "the QR payload is only {jti,bid,exp} - no name, email, phone or password",
      JSON.stringify(payloadKeys) === JSON.stringify(["bid", "exp", "jti"]),
      payloadKeys.join(",")
    );
    check(
      "the QR payload does not leak the client's identity",
      !JSON.stringify(payload).match(/@|\+63|password|email|name/i),
      JSON.stringify(payload)
    );

    // -----------------------------------------------------------------------
    section("3. Confirm arrival at the desk");

    const before = await db.query(
      `select status, total_cents, subtotal_cents, discount_cents from public.bookings where id = $1`,
      [bookingId]
    );

    const checkin = await call("POST", "/qr/check-in", { token: tokens.CONCIERGE, body: { pass } });
    check(
      "POST /qr/check-in confirms the arrival",
      checkin.status === 200 && checkin.body?.data?.status === "CHECKED_IN",
      `${checkin.status} ${checkin.body?.data?.status ?? JSON.stringify(checkin.body?.error)}`
    );
    check(
      "a check-in timestamp is recorded",
      Boolean(checkin.body?.data?.checkedInAt) && /Z$/.test(checkin.body?.data?.checkedInAt ?? ""),
      checkin.body?.data?.checkedInAt
    );
    check("a check-in row id comes back", Boolean(checkin.body?.data?.checkinId), checkin.body?.data?.checkinId);

    const after = await db.query(
      `select status, total_cents, subtotal_cents, discount_cents from public.bookings where id = $1`,
      [bookingId]
    );
    check("the reservation is now CHECKED_IN", after.rows[0].status === "CHECKED_IN", after.rows[0].status);

    // The brief is explicit: arriving must NOT finish the service.
    check(
      "the service is NOT auto-completed (no COMPLETED / IN_SERVICE)",
      !["COMPLETED", "IN_SERVICE"].includes(after.rows[0].status),
      after.rows[0].status
    );

    // There is no payment/paid state on a booking at all - money is a set of
    // integer amounts - so "must not mark the payment paid" is structurally
    // guaranteed rather than merely observed. Assert the amounts are untouched
    // AND that no payment column exists to be flipped.
    const { rows: payCols } = await db.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'bookings'
          and (column_name ilike '%paid%' or column_name ilike '%payment%')`
    );
    check(
      "a booking has no paid/payment state to set",
      payCols.length === 0,
      payCols.map((c) => c.column_name).join(",") || "none"
    );
    check(
      "the money on the booking is unchanged by the check-in",
      before.rows[0].subtotal_cents === after.rows[0].subtotal_cents &&
        before.rows[0].discount_cents === after.rows[0].discount_cents &&
        before.rows[0].total_cents === after.rows[0].total_cents,
      `total ${before.rows[0].total_cents} -> ${after.rows[0].total_cents}`
    );

    // -----------------------------------------------------------------------
    section("4. The concierge is associated with the arrival");

    const { rows: checkins } = await db.query(
      `select id, booking_id, staff_id, checked_in_at from public.checkins where booking_id = $1`,
      [bookingId]
    );
    check("a checkins row exists for the booking", checkins.length === 1, `${checkins.length} row(s)`);

    const { rows: audit } = await db.query(
      `select actor_id, action, metadata from public.audit_logs
        where entity_id = $1 and action = 'booking.checked_in'`,
      [bookingId]
    );
    check("the check-in is written to the audit log", audit.length === 1, `${audit.length} entry`);

    const conciergeProfileId = meConcierge.body?.data?.id;
    check(
      "the audit entry names the concierge who confirmed it",
      audit[0]?.actor_id === conciergeProfileId,
      `actor=${audit[0]?.actor_id}`
    );
    // A concierge is reception, not a service provider, so the schema has no
    // employees row for them and `staff_id` is null by design - the actor on the
    // audit entry is what identifies them. Report it rather than pretend.
    process.stdout.write(
      `  ${C.dim}INFO${C.r}  checkins.staff_id = ${checkins[0]?.staff_id ?? "null"} (concierge has no employees row; the audit actor is the association)\n`
    );

    // -----------------------------------------------------------------------
    section("5. Duplicates are refused and the pass is spent");

    const replay = await call("POST", "/qr/check-in", { token: tokens.CONCIERGE, body: { pass } });
    check(
      "a second scan of the same pass is refused",
      replay.status === 409 && replay.body?.error?.code === "ALREADY_CHECKED_IN",
      `${replay.status} ${replay.body?.error?.code}`
    );

    const { rows: afterReplay } = await db.query(
      `select count(*)::int as n from public.checkins where booking_id = $1`,
      [bookingId]
    );
    check("the replay did not add a second check-in row", afterReplay[0].n === 1, `${afterReplay[0].n}`);

    const qrAgain = await call("GET", `/bookings/${bookingId}/qr`, { token: tokens.CONCIERGE });
    check(
      "the pass now reports itself used",
      qrAgain.status === 200 && qrAgain.body?.data?.used === true,
      `used=${qrAgain.body?.data?.used}`
    );

    const forged = `BA1.${Buffer.from(
      JSON.stringify({ jti: crypto.randomUUID(), bid: crypto.randomUUID(), exp: 9999999999 })
    ).toString("base64url")}.${Buffer.from("nope").toString("base64url")}`;
    const forgedRes = await call("POST", "/qr/check-in", { token: tokens.CONCIERGE, body: { pass: forged } });
    check(
      "a QR that matches no reservation is refused (walk-in path)",
      forgedRes.status === 400 && forgedRes.body?.error?.code === "QR_INVALID",
      `${forgedRes.status} ${forgedRes.body?.error?.code}`
    );

    const { rows: afterForged } = await db.query(`select count(*)::int as n from public.bookings where id = $1`, [
      bookingId,
    ]);
    check("the forged scan created no reservation", afterForged[0].n === 1, `${afterForged[0].n} booking(s)`);

    // -----------------------------------------------------------------------
    section("6. The arrival is visible to staff");

    const asEmployee = await call("GET", `/bookings/${bookingId}`, { token: tokens.EMPLOYEE });
    check(
      "the assigned employee can see the booking and its CHECKED_IN status",
      asEmployee.status === 200 && asEmployee.body?.data?.status === "CHECKED_IN",
      `${asEmployee.status} ${asEmployee.body?.data?.status}`
    );

    const asAdmin = await call("GET", `/bookings/${bookingId}`, { token: tokens.ADMIN });
    check(
      "the admin sees the same status",
      asAdmin.status === 200 && asAdmin.body?.data?.status === "CHECKED_IN",
      `${asAdmin.status} ${asAdmin.body?.data?.status}`
    );

    // A *guest* booking is deliberately readable by uuid alone - that is how a
    // guest opens their confirmation link with no account - so it is not the
    // right fixture for an isolation check. Cross-client isolation is asserted
    // in section 7 against a booking that actually belongs to a client.
    const asClient = await call("GET", `/bookings/${bookingId}`, { token: tokens.CLIENT });
    check(
      "a guest booking stays readable by uuid alone (by design)",
      asClient.status === 200,
      `${asClient.status} ${asClient.body?.data?.status}`
    );

    // -----------------------------------------------------------------------
    section("7. The client's own arrival pass");

    const { rows: clientRows } = await db.query(
      `select c.id, c.profile_id from public.clients c
        join public.profiles p on p.id = c.profile_id
        join auth.users u on u.id = c.profile_id
       where lower(u.email) = lower($1)`,
      [byRole.CLIENT.email]
    );
    if (clientRows.length === 0) {
      check("the demo client is linked to a clients row", false, "no linked clients row found");
    } else {
      const clientId = clientRows[0].id;
      const mineId = await insertFutureBooking(db, { clientId, employeeId, startDaysAhead: 3 });
      created.bookings.push(mineId);
      await db.query(
        `insert into public.qr_tokens (booking_id, expires_at) values ($1, now() + interval '4 days')`,
        [mineId]
      );

      const own = await call("GET", `/bookings/${mineId}/qr`, { token: tokens.CLIENT });
      check(
        "a client can open the arrival pass for their own booking",
        own.status === 200 && typeof own.body?.data?.pass === "string",
        `${own.status}`
      );
      check(
        "the client's own pass is a different token from the guest's",
        own.body?.data?.pass !== pass,
        "distinct per reservation"
      );

      // Now the real isolation rule: a booking that belongs to *another* client
      // must be invisible. The seed ships a second client with no login, which
      // is exactly the "someone else" this needs.
      const { rows: other } = await db.query(
        `select id from public.clients where full_name = 'Ben Ocampo' limit 1`
      );
      if (other.length === 0) {
        check("a second client exists to test isolation against", false, "Ben Ocampo not found");
      } else {
        const theirsId = await insertFutureBooking(db, {
          clientId: other[0].id,
          employeeId,
          startDaysAhead: 5,
        });
        created.bookings.push(theirsId);

        const peek = await call("GET", `/bookings/${theirsId}`, { token: tokens.CLIENT });
        check(
          "a client cannot read another client's booking",
          peek.status === 404,
          `${peek.status} ${peek.body?.error?.code}`
        );
      }
    }
  } finally {
    // -----------------------------------------------------------------------
    section("8. Cleanup");
    if (created.bookings.length) {
      await db.query(`delete from public.qr_tokens where booking_id = any($1::uuid[])`, [created.bookings]);
      await db.query(`delete from public.checkins where booking_id = any($1::uuid[])`, [created.bookings]);
      await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [created.bookings]);
      const del = await db.query(`delete from public.bookings where id = any($1::uuid[])`, [created.bookings]);
      check("fixtures removed", del.rowCount === created.bookings.length, `${del.rowCount} booking(s)`);
    }
    await db.end();
  }

  process.stdout.write(
    failures.length
      ? `\n${C.red}${C.bold}ARRIVAL PASS E2E FAILED${C.r}  ${passed} passed, ${failures.length} failed\n  - ${failures.join("\n  - ")}\n`
      : `\n${C.green}${C.bold}ARRIVAL PASS E2E PASSED${C.r}  ${passed} passed, 0 failed\n`
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`\n${C.red}e2e crashed: ${e.stack}${C.r}\n`);
  process.exit(1);
});
