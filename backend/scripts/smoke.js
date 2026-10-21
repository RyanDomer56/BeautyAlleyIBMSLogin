#!/usr/bin/env node
/**
 * Live smoke test.
 *
 * Boots against an already-running server and walks the documented API surface
 * in the order a real client would: browse the catalogue, check availability,
 * book as a guest, read the booking back with nothing but its uuid, take the
 * pass to the desk, and finally look at the staff and admin views.
 *
 * This is deliberately not a replacement for the Jest suite. The suite proves
 * the rules; this proves the *built artefact* actually serves them - the suite
 * runs `createApp()` in-process, so it would not notice a broken entry point,
 * a port that never binds, or a route mounted only in the test harness.
 *
 *   node scripts/smoke.js            # against http://127.0.0.1:4000
 *   BASE=http://host:port node scripts/smoke.js
 *
 * Every row it creates is deleted at the end, so it is safe to point at the
 * live project.
 */

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

function section(title) {
  process.stdout.write(`\n${C.bold}${title}${C.r}\n`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
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
    /* CSV and 204s are not JSON */
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

/** A future instant inside the seeded shift: Mon-Sat, 09:00-18:00 Manila. */
function workingSlot(daysAhead = 3, manilaHour = 10) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + daysAhead);
  base.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 10; i++) {
    const utc = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), manilaHour, 0, 0, 0)
    );
    utc.setUTCHours(utc.getUTCHours() - 8);
    if (new Date(utc.getTime() + 8 * 3_600_000).getUTCDay() !== 0) return utc;
    base.setUTCDate(base.getUTCDate() + 1);
  }
  throw new Error("no working slot found");
}

const SVC_MASSAGE = "11111111-0000-0000-0000-000000000001";
const EMP_ANA = "22222222-0000-0000-0000-000000000001";

/**
 * Create a booking that is check-in-able *right now*, for a stylist who is free.
 *
 * The check-in window is one hour wide: a pass opens `QR_CHECKIN_WINDOW_MINUTES`
 * before the appointment starts and closes when the appointment ends. So the
 * start has to sit inside `[now - duration, now + window]` to be scannable the
 * moment it is created.
 *
 * "Now + 20 minutes" is not safe. The seeded demo data puts real appointments on
 * the grid, and a hardcoded offset collided with a 13:00 booking - the insert
 * died on `bookings_no_overlap` and took the whole smoke run with it. Walk the
 * window instead, and let the database be the oracle: attempt the insert, and on
 * an exclusion violation (23P01) move to the next candidate. The rule is then
 * never restated here, so it cannot drift from the constraint that enforces it.
 *
 * Two further concessions to a populated database, both learned the hard way:
 *
 *   - The booking is 30 minutes, not 60. The demo grid runs 45-minute treatments
 *     and the gaps between them are 45 minutes wide, so a one-hour booking has
 *     nowhere to go even when the stylist is not busy - every candidate in the
 *     window overlaps something. The pass only has to be scannable; the
 *     treatment length is irrelevant to what is being tested.
 *   - Stylists are tried in turn. One stylist can genuinely be booked across the
 *     whole window, and that is not a reason to fail a check-in test.
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
           values ($1, 'Smoke Soon', '+639009990003', $2, $3, $4, 'CONFIRMED', 250000, 0, 250000)
           returning id`,
          [reference, employeeId, start.toISOString(), end.toISOString()]
        );
        return inserted.rows[0].id;
      } catch (err) {
        // The stylist (or a room) is already busy then - try the next candidate.
        // Anything else is a real failure and must not be swallowed.
        if (err.code === "23P01") continue;
        throw err;
      }
    }
  }

  throw new Error("no check-in-able slot was free for any stylist");
}

async function main() {
  const created = { bookings: [], users: [] };
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    // ---------------------------------------------------------------------
    section("0. Liveness");
    // /health is mounted on the root, not under /api/v1.
    const raw = await fetch(`${BASE}/health`);
    const healthBody = await raw.json();
    check("server responds to /health", raw.status === 200, `status ${raw.status}`);
    check(
      "health reports the database and service-role key as configured",
      healthBody?.checks?.database === "ok" && healthBody?.checks?.serviceRoleKey === true,
      JSON.stringify(healthBody?.checks)
    );

    // The root used to be a bare `NOT_FOUND`, which reads as "broken" when the
    // service is fine and simply has no page there. It now answers with either
    // the JSON service index (API-only) or the app shell (SERVE_APP=1, i.e. the
    // tunnel) - both are correct, so the index itself is asserted at /api/v1,
    // which serves it in either mode, and the root only has to be useful.
    const indexRes = await call("GET", "");
    const indexData = indexRes.body?.data;
    check("GET /api/v1 serves the service index",
      indexRes.status === 200 && indexData?.endpointCount > 0,
      `${indexData?.endpointCount ?? 0} endpoints documented`);
    check("the index says it is an API with no HTML page",
      typeof indexData?.note === "string" && /no HTML page/i.test(indexData.note));
    check("every documented path is under /api/v1 or is /health",
      Array.isArray(indexData?.groups) &&
        indexData.groups.every((g) => g.endpoints.every((e) => e.path.startsWith("/api/v1") || e.path === "/health")),
      `${indexData?.groups?.length ?? 0} groups`);
    check("the index reports its own base URL",
      indexData?.baseUrl === "/api/v1", indexData?.baseUrl);

    const rootRes = await fetch(`${BASE}/`);
    const rootType = rootRes.headers.get("content-type") || "";
    check("the root is never a bare 404 - it is the index or the app",
      rootRes.status === 200,
      `status ${rootRes.status} ${rootType.includes("text/html") ? "(app shell)" : "(index)"}`);

    // ---------------------------------------------------------------------
    section("1. Public catalogue (publishable key only)");
    const services = await call("GET", "/services?limit=50");
    check("GET /services", services.status === 200 && Array.isArray(services.body?.data),
      `${services.body?.meta?.total} services`);

    const one = await call("GET", `/services/${SVC_MASSAGE}`);
    check("GET /services/:id", one.status === 200 && one.body?.data?.priceCents === 250000,
      `${one.body?.data?.name} @ ${one.body?.data?.priceCents}`);

    const missing = await call("GET", "/services/99999999-0000-0000-0000-000000000000");
    check("GET /services/:id 404s an unknown id", missing.status === 404 && missing.body?.error?.code === "SERVICE_NOT_FOUND",
      missing.body?.error?.code);

    const search = await call("GET", "/services/search?q=massage");
    check("GET /services/search", search.status === 200 && search.body?.data?.length >= 1,
      `${search.body?.data?.length} hit(s)`);

    const employees = await call("GET", "/employees");
    check("GET /employees", employees.status === 200 && employees.body?.data?.length === 3,
      `${employees.body?.data?.length} stylists`);

    const emp = await call("GET", `/employees/${EMP_ANA}`);
    check("GET /employees/:id omits private working hours",
      emp.status === 200 && emp.body?.data?.workingHours === undefined,
      "workingHours absent");

    // ---------------------------------------------------------------------
    section("2. Availability");
    // 200 days out: well clear of every day-offset band the test suite reserves
    // (see SLOT_BANDS in tests/helpers/time.ts), so the smoke test cannot be
    // perturbed by, or perturb, a previous test run.
    const slot = workingSlot(200, 10);
    const day = slot.toISOString().slice(0, 10);
    const avail = await call(
      "GET",
      `/availability?serviceId=${SVC_MASSAGE}&date=${day}&employeeId=${EMP_ANA}&intervalMinutes=60`
    );
    const slots = avail.body?.data?.employees?.[0]?.slots ?? [];
    check("GET /availability returns a slot grid", avail.status === 200 && slots.length > 0,
      `${slots.length} slot(s) on ${day}`);
    check("first slot is 09:00 Manila", slots[0]?.start === `${day}T01:00:00.000Z`, slots[0]?.start);

    // ---------------------------------------------------------------------
    section("3. Promo preview");
    const promo = await call("POST", "/promos/validate", {
      body: { code: "save10", serviceIds: [SVC_MASSAGE], subtotalCents: 250000 },
    });
    check("POST /promos/validate (case-insensitive)", promo.status === 200 && promo.body?.data?.discountCents === 25000,
      `${promo.body?.data?.discountCents} off`);

    const bogus = await call("POST", "/promos/validate", {
      body: { code: "NOPE404", serviceIds: [SVC_MASSAGE], subtotalCents: 250000 },
    });
    check("unknown code is a 200 with valid:false, not a 4xx",
      bogus.status === 200 && bogus.body?.data?.valid === false, bogus.body?.data?.reason);

    // ---------------------------------------------------------------------
    section("4. Guest booking, start to finish");
    const booking = await call("POST", "/bookings", {
      body: {
        serviceIds: [SVC_MASSAGE],
        employeeId: EMP_ANA,
        startTime: slot.toISOString(),
        guest: { name: "Smoke Test", phone: "+639009990001" },
      },
    });
    check("POST /bookings creates a guest booking", booking.status === 201,
      `${booking.body?.data?.reference} ${booking.status}`);
    const bookingId = booking.body?.data?.id;
    const pass = booking.body?.data?.qr?.pass;
    if (bookingId) created.bookings.push(bookingId);
    check("a signed pass comes back with it", typeof pass === "string" && pass.startsWith("BA1."),
      pass ? `${pass.slice(0, 12)}...` : "none");
    check("guest booking starts PENDING", booking.body?.data?.status === "PENDING", booking.body?.data?.status);

    const reread = await call("GET", `/bookings/${bookingId}`);
    check("GET /bookings/:id works with the uuid and no token", reread.status === 200,
      `status ${reread.status}`);

    const qr = await call("GET", `/bookings/${bookingId}/qr`);
    check("GET /bookings/:id/qr re-issues the pass", qr.status === 200 && qr.body?.data?.used === false,
      qr.body?.data?.used === false ? "unused" : JSON.stringify(qr.body));

    const moved = await call("POST", `/bookings/${bookingId}/reschedule`, {
      body: { startTime: new Date(slot.getTime() + 2 * 3_600_000).toISOString() },
    });
    check("POST /bookings/:id/reschedule", moved.status === 200 && moved.body?.data?.qr?.pass !== pass,
      "new pass issued");

    const clash = await call("POST", "/bookings", {
      body: {
        serviceIds: [SVC_MASSAGE],
        employeeId: EMP_ANA,
        startTime: new Date(slot.getTime() + 2 * 3_600_000 + 30 * 60_000).toISOString(),
        guest: { name: "Clash", phone: "+639009990002" },
      },
    });
    check("overlapping booking is refused 409 SLOT_TAKEN",
      clash.status === 409 && clash.body?.error?.code === "SLOT_TAKEN", clash.body?.error?.code);

    // ---------------------------------------------------------------------
    section("5. Auth + staff check-in");

    /**
     * Create an account with a role and return a real session.
     *
     * Goes through the admin API rather than /auth/register because email
     * confirmation is on, so a self-registered account gets no session.
     */
    async function makeUser(role) {
      const email = `smoke.${role.toLowerCase()}.${Date.now()}@beautyalley.ph`;
      const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          email,
          password: "SmokePass123!",
          email_confirm: true,
          app_metadata: { role },
          user_metadata: { full_name: `Smoke ${role}` },
        }),
      });
      const user = await res.json();
      created.users.push(user.id);

      const signIn = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password: "SmokePass123!" }),
      });
      const session = await signIn.json();
      return { id: user.id, token: session.access_token };
    }

    const staff = await makeUser("EMPLOYEE");
    const concierge = await makeUser("CONCIERGE");
    const admin = await makeUser("ADMIN");
    const staffToken = staff.token;
    const conciergeToken = concierge.token;
    const adminToken = admin.token;
    check("employee, concierge and admin accounts sign in and get sessions",
      typeof staffToken === "string" && typeof conciergeToken === "string" && typeof adminToken === "string");

    const me = await call("GET", "/auth/me", { token: staffToken });
    check("GET /auth/me reports the EMPLOYEE role", me.status === 200 && me.body?.data?.role === "EMPLOYEE",
      me.body?.data?.role);

    const meConcierge = await call("GET", "/auth/me", { token: conciergeToken });
    check("GET /auth/me reports the CONCIERGE role",
      meConcierge.status === 200 && meConcierge.body?.data?.role === "CONCIERGE",
      meConcierge.body?.data?.role);

    const noToken = await call("GET", "/admin/dashboard?from=2026-01-01&to=2026-12-31");
    check("admin route without a token is 401", noToken.status === 401, `status ${noToken.status}`);

    // Admin reporting is ADMIN-only; an employee token must be refused. This is
    // the distinction the first draft of this script got wrong by using one
    // token for everything.
    const staffOnAdmin = await call("GET", "/admin/dashboard?from=2026-01-01&to=2026-12-31", { token: staffToken });
    check("admin reporting refuses an EMPLOYEE token with 403",
      staffOnAdmin.status === 403 && staffOnAdmin.body?.error?.code === "INSUFFICIENT_ROLE",
      `${staffOnAdmin.status} ${staffOnAdmin.body?.error?.code ?? ""}`);

    // The concierge is the interesting case: running the desk must not confer
    // admin, and being refused admin must not lock them out of the desk. Both
    // halves are asserted, because a gate that is simply too wide also passes
    // the "refuses" half if the route is broken outright.
    const conciergeOnAdmin = await call("GET", "/admin/dashboard?from=2026-01-01&to=2026-12-31", { token: conciergeToken });
    check("admin reporting refuses a CONCIERGE token with 403",
      conciergeOnAdmin.status === 403 && conciergeOnAdmin.body?.error?.code === "INSUFFICIENT_ROLE",
      `${conciergeOnAdmin.status} ${conciergeOnAdmin.body?.error?.code ?? ""}`);

    const conciergeOnDesk = await call("GET", "/loyalty/clients?limit=1", { token: conciergeToken });
    check("the concierge CAN read the loyalty worklist",
      conciergeOnDesk.status === 200,
      `${conciergeOnDesk.status} ${JSON.stringify(conciergeOnDesk.body?.error ?? "")}`);

    // Staff-created bookings start CONFIRMED, and check-in needs a booking that
    // is actually inside its window - so place one that is scannable now, rather
    // than reusing the days-out booking above. EMP_ANA is preferred, but any
    // active stylist will do: the pass, the window and the status are what
    // authorise a check-in, not whose chair it is.
    const stylists = await db.query(
      `select id from public.employees where is_active order by (id = $1) desc, id`,
      [EMP_ANA]
    );
    const soonId = await insertCheckinableBooking(
      db,
      stylists.rows.map((r) => r.id),
      `BA-SMOKE-${Date.now()}`
    );
    created.bookings.push(soonId);
    await db.query(`insert into public.qr_tokens (booking_id, expires_at) values ($1, now() + interval '2 days')`, [soonId]);
    const soonPass = (await call("GET", `/bookings/${soonId}/qr`)).body?.data?.pass;

    const checkin = await call("POST", "/qr/check-in", { token: staffToken, body: { pass: soonPass } });
    check("POST /qr/check-in marks the booking CHECKED_IN",
      checkin.status === 200 && checkin.body?.data?.status === "CHECKED_IN",
      `${checkin.status} ${checkin.body?.data?.status ?? JSON.stringify(checkin.body?.error)}`);

    const replay = await call("POST", "/qr/check-in", { token: staffToken, body: { pass: soonPass } });
    check("replaying the same pass is refused 409",
      replay.status === 409 && replay.body?.error?.code === "ALREADY_CHECKED_IN", replay.body?.error?.code);

    const forged = `BA1.${Buffer.from(JSON.stringify({ jti: crypto.randomUUID(), bid: crypto.randomUUID(), exp: 9999999999 })).toString("base64url")}.${Buffer.from("nope").toString("base64url")}`;
    const forgedRes = await call("POST", "/qr/check-in", { token: staffToken, body: { pass: forged } });
    check("a forged pass is refused", forgedRes.status === 400 && forgedRes.body?.error?.code === "QR_INVALID",
      forgedRes.body?.error?.code);

    // ---------------------------------------------------------------------
    section("6. Admin reporting");
    const dash = await call("GET", "/admin/dashboard?from=2026-01-01&to=2026-12-31", { token: adminToken });
    check("GET /admin/dashboard", dash.status === 200 && dash.body?.data?.totals !== undefined,
      JSON.stringify(dash.body?.data?.totals));

    const clients = await call("GET", "/admin/clients", { token: adminToken });
    check("GET /admin/clients", clients.status === 200 && clients.body?.meta?.total >= 2,
      `${clients.body?.meta?.total} clients`);

    const csv = await call("GET", "/admin/clients/export.csv", { token: adminToken });
    check("GET /admin/clients/export.csv is a CSV attachment",
      csv.status === 200 && csv.headers.get("content-type")?.includes("text/csv") &&
        csv.headers.get("content-disposition")?.includes("attachment"),
      csv.headers.get("content-type"));

    const audit = await call("GET", "/admin/audit-logs?limit=5", { token: adminToken });
    check("GET /admin/audit-logs", audit.status === 200 && Array.isArray(audit.body?.data),
      `${audit.body?.meta?.total} entries`);

    const adminBookings = await call("GET", "/admin/bookings?limit=5", { token: adminToken });
    check("GET /admin/bookings", adminBookings.status === 200 && adminBookings.body?.meta !== undefined,
      `${adminBookings.body?.meta?.total} bookings`);

    const branch = await call("GET", "/qr/branch", { token: staffToken });
    check("GET /qr/branch is not a credential", branch.status === 200 && branch.body?.data?.authorises === false,
      `authorises=${branch.body?.data?.authorises}`);

    // ---------------------------------------------------------------------
    section("6b. Timestamp wire format");
    // Every timestamp the API puts in a *typed* DTO field must be `Z`-suffixed
    // UTC. Two layers render `timestamptz` differently - PostgREST says
    // `+00:00`, a `jsonb` return from a PL/pgSQL function says `Z` - and a
    // client cannot compare the two as strings. This check exists because
    // `/availability` was leaking `+00:00` while `/bookings` said `Z` for the
    // same kind of field. The single exemption is audit metadata, which is
    // asserted below rather than waved through.
    const offsetSuffixed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
    function collectBadTimestamps(node, path, found) {
      if (typeof node === "string") {
        if (offsetSuffixed.test(node)) found.push(`${path} = ${node}`);
        return found;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => collectBadTimestamps(v, `${path}[${i}]`, found));
        return found;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) collectBadTimestamps(v, `${path}.${k}`, found);
      }
      return found;
    }

    const surfaces = {
      "/availability": (await call("GET", `/availability?serviceId=${SVC_MASSAGE}&date=${day}&employeeId=${EMP_ANA}&intervalMinutes=60`)).body,
      "/bookings/:id": reread.body,
      "/bookings/:id/qr": qr.body,
      "/qr/check-in": checkin.body,
      "/admin/clients": clients.body,
      "/admin/dashboard": dash.body,
      "/promos/validate": promo.body,
      "/services": services.body,
      "/employees": employees.body,
    };
    const bad = [];
    for (const [name, body] of Object.entries(surfaces)) collectBadTimestamps(body, name, bad);
    check("every DTO timestamp is Z-suffixed UTC, never an offset", bad.length === 0,
      bad.length ? bad.slice(0, 5).join("; ") : `${Object.keys(surfaces).length} payloads scanned`);

    // `audit_logs.metadata` is the one deliberate exception, so it is asserted
    // rather than skipped. It is an untyped jsonb snapshot the database built
    // itself (`jsonb_build_object` renders timestamptz with an offset), and the
    // read path passes it through untouched on purpose - see the note on
    // toAuditLogDto(). Two halves: the row's typed fields ARE normalised, and
    // the snapshot really does arrive unrewritten.
    const auditBad = [];
    for (const [i, row] of (audit.body?.data ?? []).entries()) {
      const { metadata, ...typed } = row;
      void metadata;
      collectBadTimestamps(typed, `/admin/audit-logs[${i}]`, auditBad);
    }
    check("audit-log row fields are Z-suffixed UTC", auditBad.length === 0,
      auditBad.length ? auditBad.slice(0, 3).join("; ") : `${(audit.body?.data ?? []).length} rows scanned`);

    const snapshots = await call("GET", "/admin/audit-logs?action=booking.rescheduled&limit=20", { token: adminToken });
    const verbatim = (snapshots.body?.data ?? []).filter(
      (r) => collectBadTimestamps(r.metadata, "m", []).length > 0
    );
    check("audit metadata is preserved verbatim, not rewritten", verbatim.length > 0,
      verbatim.length
        ? `${verbatim.length} snapshot(s) still in database spelling, e.g. ${verbatim[0].metadata.startTime}`
        : "no booking.rescheduled snapshot found to inspect");

    // ---------------------------------------------------------------------
    section("7. Cancellation");
    const cancelled = await call("POST", `/bookings/${bookingId}/cancel`, { body: { reason: "smoke" } });
    check("POST /bookings/:id/cancel", cancelled.status === 200 && cancelled.body?.data?.booking?.status === "CANCELLED",
      cancelled.body?.data?.booking?.status);

    const deadPass = await call("GET", `/bookings/${bookingId}/qr`);
    check("the cancelled booking's pass is dead",
      deadPass.status === 400 && deadPass.body?.error?.code === "QR_INVALID", deadPass.body?.error?.code);

    // ---------------------------------------------------------------------
    section("8. Error shapes");
    const unknownRoute = await call("GET", "/nope");
    check("unknown route 404s in the standard shape",
      unknownRoute.status === 404 && unknownRoute.body?.error?.code !== undefined, unknownRoute.body?.error?.code);

    const badBody = await fetch(`${API}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const badBodyJson = await badBody.json().catch(() => null);
    check("malformed JSON is a 400, not a 500", badBody.status === 400, `status ${badBody.status}`);
    void badBodyJson;
  } finally {
    // Clean up: children cascade from bookings, so one statement each is enough.
    if (created.bookings.length) {
      await db.query(`delete from public.bookings where id = any($1::uuid[])`, [created.bookings]);
    }
    for (const id of created.users) {
      await db.query(`delete from auth.users where id = $1`, [id]).catch(() => undefined);
    }
    await db.end();

    process.stdout.write(
      `\n${failures.length === 0 ? C.green + C.bold + "SMOKE TEST PASSED" : C.red + C.bold + "SMOKE TEST FAILED"}` +
        `${C.r}  ${passed} passed, ${failures.length} failed\n`
    );
    if (failures.length) {
      for (const f of failures) process.stdout.write(`  ${C.red}- ${f}${C.r}\n`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  process.stdout.write(`\n${C.red}${err.stack || err.message}${C.r}\n`);
  process.exitCode = 1;
});
