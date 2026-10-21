/**
 * Demo bookings.
 *
 * `seed.js` fills the *catalogue* — services, employees, clients, promos — and
 * deliberately creates no bookings, because a booking is a transaction and a
 * fixture booking in the wrong place is worse than none. But the console then
 * opens on an empty week: revenue is ₱0, the run sheet is blank, the board has
 * nothing to arrange. That is correct and useless.
 *
 * So this script creates a plausible two weeks of visits around *today*: the
 * past fortnight is mostly completed (which is what produces revenue), today is
 * part-done and part-outstanding, and tomorrow is booked ahead.
 *
 * ## Rules it obeys
 *
 * It goes through the same rules the API enforces, because it writes to the same
 * tables:
 *
 *   - Slots stay inside the branch's opening hours (Mon–Sat, 09:00–18:00
 *     `Asia/Manila`). Sunday is closed, so Sunday gets nothing.
 *   - `end_time` is the service's real duration, and `total_cents` is
 *     `subtotal - discount`, so the money columns stay consistent.
 *   - A past slot can only be `COMPLETED`/`NO_SHOW`/`CANCELLED`; a future one
 *     only `PENDING`/`CONFIRMED`. No "completed" visit tomorrow.
 *   - Two bookings never share an employee at the same time.
 *
 * ## Idempotence
 *
 * It refuses to touch a day that already has bookings, and says which ones it
 * skipped. Running it twice therefore changes nothing, and it will not clobber
 * bookings you made by hand. Pass `--force` to clear its own days and rebuild.
 *
 * Usage:  node scripts/seed-demo-bookings.js [--force] [--quiet]
 */

require("./_load-env");
const { Client } = require("pg");

const BRANCH_OFFSET = "+08:00"; // Asia/Manila, fixed (no DST)
const PAST_DAYS = 13; // yesterday .. 13 days ago
const FUTURE_DAYS = 1; // tomorrow
const SLOTS = ["10:00", "11:30", "13:00", "14:30", "16:00"];

/**
 * A small, plausible client book.
 *
 * Fixed uuids under the `5555…` block so re-running is an upsert rather than a
 * pile of duplicates — the same convention `seed.js` uses for its own fixtures
 * (`1111…` services, `2222…` employees, `3333…` clients, `4444…` promos).
 *
 * These exist because two clients is not a client *record*: the Clients page
 * ranks by lifetime value and the board shows a top-clients panel, and neither
 * says anything with a sample of two.
 */
const DEMO_CLIENTS = [
  ["Marisol Vega", "+63 917 555 0142", "marisol.vega@example.ph"],
  ["Ines Baptista", "+63 917 555 0188", "ines.baptista@example.ph"],
  ["Rosalind Tan", "+63 917 555 0231", "rosalind.tan@example.ph"],
  ["Carmen Diaz", "+63 917 555 0277", "carmen.diaz@example.ph"],
  ["Luis Herrera", "+63 917 555 0314", "luis.herrera@example.ph"],
  ["Naomi Aquino", "+63 917 555 0360", "naomi.aquino@example.ph"],
  ["Sofia Reyes", "+63 917 555 0409", "sofia.reyes@example.ph"],
  ["Theo Marchand", "+63 917 555 0455", "theo.marchand@example.ph"],
];

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const QUIET = argv.includes("--quiet");

/** `YYYY-MM-DD` at the branch, shifted by whole days. */
function branchDay(offset = 0) {
  const now = new Date(Date.now() + offset * 86_400_000);
  // en-CA gives YYYY-MM-DD, and the timeZone option makes it the branch's day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 0 = Sunday, in branch time. */
function branchWeekday(day) {
  return new Date(`${day}T12:00:00${BRANCH_OFFSET}`).getUTCDay();
}

function instant(day, hhmm) {
  return new Date(`${day}T${hhmm}:00${BRANCH_OFFSET}`);
}

/** "HH:MM" as the branch reads that instant. Compares correctly as a string. */
function branchClock(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const CLOSE = "18:00";

/** Deterministic pseudo-random in [0,1) so re-runs look identical. */
function rng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function log(msg) {
  if (!QUIET) process.stdout.write(msg + "\n");
}

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  // --- client book (upsert, so re-runs do not duplicate) -------------------
  for (const [i, [name, phone, email]] of DEMO_CLIENTS.entries()) {
    const id = `55555555-0000-0000-0000-0000000000${String(i + 1).padStart(2, "0")}`;
    await c.query(
      `insert into public.clients (id, full_name, phone, email, is_active)
       values ($1,$2,$3,$4,true)
       on conflict (id) do update
         set full_name = excluded.full_name,
             phone     = excluded.phone,
             email     = excluded.email,
             is_active = true`,
      [id, name, phone, email],
    );
  }
  log(`  ${DEMO_CLIENTS.length} demo clients ready`);

  const services = (
    await c.query(
      `select id, name, price_cents, duration_minutes
         from public.services where is_active order by id`,
    )
  ).rows;
  const employees = (
    await c.query(`select id, full_name from public.employees where is_active order by id`)
  ).rows;
  const clients = (
    await c.query(`select id, full_name from public.clients where is_active order by id`)
  ).rows;
  const promos = (
    await c.query(`select id, code from public.promo_codes where is_active order by code`)
  ).rows;

  if (!services.length || !employees.length || !clients.length) {
    throw new Error("catalogue is empty — run `npm run db:seed` first");
  }

  const save10 = promos.find((p) => p.code === "SAVE10") ?? null;

  const days = [];
  for (let d = -PAST_DAYS; d <= FUTURE_DAYS; d++) days.push(d);

  let created = 0;
  let skippedDays = 0;
  let cleared = 0;

  for (const offset of days) {
    const day = branchDay(offset);
    if (branchWeekday(day) === 0) continue; // Sunday — closed

    const existing = await c.query(
      `select count(*)::int as n
         from public.bookings
        where (start_time at time zone 'Asia/Manila')::date = $1::date`,
      [day],
    );

    if (existing.rows[0].n > 0) {
      if (!FORCE) {
        skippedDays++;
        log(`  skip ${day} — ${existing.rows[0].n} booking(s) already there`);
        continue;
      }
      const del = await c.query(
        `delete from public.bookings
          where (start_time at time zone 'Asia/Manila')::date = $1::date`,
        [day],
      );
      cleared += del.rowCount;
      log(`  cleared ${day} — ${del.rowCount} booking(s)`);
    }

    const daySeed = rng(day);
    /** employeeId -> [{s, e}] ms, so two visits never share a chair. */
    const busy = new Map();

    // Continue the day's reference sequence rather than starting at 0001 —
    // `bookings.reference` is unique, and other fixtures (the smoke test) mint
    // references for the same calendar day.
    const prefix = `BA-${day.replace(/-/g, "")}-`;
    const highest = await c.query(
      `select coalesce(max(substring(reference from '[0-9]+$')::int), 0) as n
         from public.bookings where reference like $1`,
      [`${prefix}%`],
    );
    let seq = highest.rows[0].n + 1;

    for (const hhmm of SLOTS) {
      const start = instant(day, hhmm);
      const isPast = start.getTime() < Date.now();

      // 3–5 visits a day, deterministic per day, always including the first slot.
      const wanted = 3 + Math.floor(daySeed * 3);
      if (SLOTS.indexOf(hhmm) >= wanted) continue;

      const pick = rng(`${day}|${hhmm}`);
      const service = services[Math.floor(pick * services.length) % services.length];
      const employee =
        employees[Math.floor(rng(`${day}|${hhmm}|e`) * employees.length) % employees.length];

      const startMs = start.getTime();
      const endMs = startMs + service.duration_minutes * 60_000;
      const end = new Date(endMs);

      // Never run past the 18:00 close.
      if (branchClock(end) > CLOSE) continue;

      // Overlap check — a 2-hour treatment at 10:00 still owns the chair at
      // 11:30, so adjacency of *slots* is not enough.
      const taken = busy.get(employee.id) ?? [];
      if (taken.some((iv) => startMs < iv.e && endMs > iv.s)) continue;
      taken.push({ s: startMs, e: endMs });
      busy.set(employee.id, taken);

      // ---- who ------------------------------------------------------
      const isGuest = rng(`${day}|${hhmm}|g`) < 0.2;
      const client = isGuest
        ? null
        : clients[Math.floor(rng(`${day}|${hhmm}|c`) * clients.length) % clients.length];

      // ---- status ---------------------------------------------------
      let status;
      const roll = rng(`${day}|${hhmm}|s`);
      if (isPast) {
        status = roll < 0.86 ? "COMPLETED" : roll < 0.94 ? "NO_SHOW" : "CANCELLED";
      } else {
        status = roll < 0.72 ? "CONFIRMED" : "PENDING";
      }

      // ---- money ----------------------------------------------------
      let discount = 0;
      let promoId = null;
      if (save10 && status === "COMPLETED" && rng(`${day}|${hhmm}|p`) < 0.18) {
        discount = Math.round(service.price_cents * 0.1);
        promoId = save10.id;
      }
      const total = service.price_cents - discount;

      const reference = `BA-${day.replace(/-/g, "")}-${String(seq).padStart(4, "0")}`;
      seq++;

      const inserted = await c.query(
        `insert into public.bookings
           (reference, client_id, guest_name, guest_phone, employee_id,
            start_time, end_time, status, subtotal_cents, discount_cents,
            total_cents, promo_code_id, cancelled_at, cancellation_reason, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         returning id`,
        [
          reference,
          client?.id ?? null,
          isGuest ? `Walk-in ${String.fromCharCode(65 + (seq % 26))}` : null,
          isGuest ? `0917${String(1000000 + (seq * 7919) % 8999999)}` : null,
          employee.id,
          start.toISOString(),
          end.toISOString(),
          status,
          service.price_cents,
          discount,
          total,
          promoId,
          status === "CANCELLED" ? start.toISOString() : null,
          status === "CANCELLED" ? "Cancelled by client" : null,
          null,
        ],
      );

      await c.query(
        `insert into public.booking_items
           (booking_id, service_id, employee_id, name_snapshot,
            price_cents_snapshot, duration_minutes_snapshot)
         values ($1,$2,$3,$4,$5,$6)`,
        [
          inserted.rows[0].id,
          service.id,
          employee.id,
          service.name,
          service.price_cents,
          service.duration_minutes,
        ],
      );

      if (promoId) {
        await c.query(
          `insert into public.promo_redemptions
             (promo_code_id, booking_id, client_id, amount_cents)
           values ($1,$2,$3,$4)`,
          [promoId, inserted.rows[0].id, client?.id ?? null, discount],
        );
      }

      created++;
    }
  }

  // The references above were continued from the highest suffix already in use
  // rather than drawn from `booking_counters`, so the counter is now BEHIND the
  // reference set. Left alone, the next real booking is handed a reference that
  // already exists: 23505 on bookings_reference_key, which the API reports as
  // 409 CONFLICT "Booking reference collision, please retry" - and retrying
  // walks one step further up the same colliding run, so the public booking
  // flow stays broken for the rest of the day.
  //
  // Migration 27 makes the allocator self-heal, so this is no longer fatal - but
  // the stored state should not be left lying, and a seeder that knowingly
  // desyncs a counter is a trap for whoever reads it next.
  const synced = await c.query("select public.sync_booking_counters() as n");

  await c.end();
  log("");
  log(`Demo bookings`);
  log(`  created        ${created}`);
  if (cleared) log(`  cleared first  ${cleared}`);
  log(`  days skipped   ${skippedDays}${skippedDays ? " (already had bookings — use --force to rebuild)" : ""}`);
  log(`  range          ${branchDay(-PAST_DAYS)} .. ${branchDay(FUTURE_DAYS)} (branch time)`);
  log(`  counters synced ${synced.rows[0].n}`);
})().catch((e) => {
  console.error("seed-demo-bookings failed:", e.message);
  process.exit(1);
});
