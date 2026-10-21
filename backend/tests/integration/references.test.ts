import request from "supertest";
import { api } from "../helpers/api";
import { connectDb, db, disconnectDb, inRollback } from "../helpers/db";
import { ISO, SLOT_BANDS, nextWorkingSlot, useSlotBand } from "../helpers/time";

/**
 * Booking references must never collide.
 *
 * `bookings.reference` is unique and is minted by `next_booking_reference()`
 * from a per-day counter in `public.booking_counters`. The counter is not the
 * only writer of that namespace: `seed-demo-bookings.js` continues from the
 * highest suffix it finds in `bookings` and never advances the counter, and an
 * import or a restore has the same shape. The counter then falls behind, the
 * next real booking is handed a reference that already exists, and the API
 * answers 409 CONFLICT "Booking reference collision, please retry" - for the
 * rest of the local day, because retrying only walks one step further up the
 * same colliding run.
 *
 * Migration 27 fixed that by re-seeding the allocation from the highest suffix
 * actually in use and then skipping anything nonetheless taken. These tests hold
 * that behaviour in place. The failure mode is silent - the counter and the
 * reference set drift apart with nothing to notice it - so the only thing that
 * keeps it fixed is a test that recreates the drift on purpose.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeReferences = hasServiceRole ? describe : describe.skip;

// Claim this suite's day-offsets before any slot is computed. See
// tests/helpers/time.ts - every suite shares one database.
useSlotBand(SLOT_BANDS.references);

describeReferences("booking references", () => {
  const SVC_MASSAGE = "11111111-0000-0000-0000-000000000001";
  // Only Ana delivers Signature Massage; Cara is qualified for Cut & Style
  // alone. The reference-holding row is a raw INSERT (no qualification check),
  // so it can sit with anyone - but the booking made through the API cannot.
  const EMP_ANA = "22222222-0000-0000-0000-000000000001";
  const EMP_CARA = "22222222-0000-0000-0000-000000000003";

  const created: string[] = [];

  beforeAll(async () => {
    await connectDb();
  });

  afterEach(async () => {
    if (created.length === 0) return;
    // booking_items, qr_tokens, checkins and promo_redemptions all cascade.
    await db().query(`delete from public.bookings where id = any($1::uuid[])`, [created]);
    created.length = 0;
  });

  afterAll(async () => {
    await disconnectDb();
  });

  /** Today in the branch's timezone, as `YYYY-MM-DD`. */
  async function branchDay(): Promise<string> {
    const { rows } = await db().query(
      `select to_char((now() at time zone public.branch_timezone())::date, 'YYYY-MM-DD') as d`
    );
    return rows[0].d;
  }

  /**
   * The reference the COUNTER ALONE would issue next.
   *
   * Deliberately not what the current allocator returns: this is the value the
   * pre-migration-27 implementation would have produced, which is exactly the
   * reference that collided. Taking it is what recreates the bug.
   */
  async function counterOnlyNextReference(day: string): Promise<string> {
    const { rows } = await db().query(
      `select 'BA-' || to_char($1::date, 'YYYYMMDD') || '-' ||
              lpad((coalesce((select last_value from public.booking_counters
                               where day = $1::date), 0) + 1)::text, 4, '0') as r`,
      [day]
    );
    return rows[0].r;
  }

  describe("the allocator", () => {
    it("skips a reference that is already taken", async () => {
      // A rolled-back transaction: the probe must not leave a counter or a
      // booking behind, and a synthetic day keeps it clear of live data.
      await inRollback(async (c) => {
        const day = "2099-12-31";

        await c.query(
          `insert into public.bookings
             (reference, guest_name, guest_phone, employee_id, start_time, end_time,
              status, subtotal_cents, discount_cents, total_cents)
           values ('BA-20991231-0001', 'Taken', '+639170000900', $1,
                   timestamptz '2099-12-31 10:00+08', timestamptz '2099-12-31 11:00+08',
                   'CONFIRMED', 100000, 0, 100000)`,
          [EMP_CARA]
        );

        // The counter believes the day is untouched.
        await c.query(
          `insert into public.booking_counters (day, last_value) values ($1::date, 0)
           on conflict (day) do update set last_value = 0`,
          [day]
        );

        const { rows } = await c.query(`select public.next_booking_reference($1::date) as r`, [day]);
        expect(rows[0].r).toBe("BA-20991231-0002");
      });
    });

    it("never issues the same reference twice", async () => {
      await inRollback(async (c) => {
        const day = "2099-12-30";
        const { rows } = await c.query(
          `select public.next_booking_reference($1::date) as a,
                  public.next_booking_reference($1::date) as b,
                  public.next_booking_reference($1::date) as c`,
          [day]
        );
        const issued = [rows[0].a, rows[0].b, rows[0].c];
        expect(new Set(issued).size).toBe(3);
        for (const reference of issued) {
          expect(reference).toMatch(/^BA-20991230-\d{4,}$/);
        }
      });
    });
  });

  describe("sync_booking_counters", () => {
    it("pulls a counter that has fallen behind up to the references in use", async () => {
      await inRollback(async (c) => {
        const day = "2099-12-29";

        await c.query(
          `insert into public.bookings
             (reference, guest_name, guest_phone, employee_id, start_time, end_time,
              status, subtotal_cents, discount_cents, total_cents)
           values ('BA-20991229-0007', 'Repair', '+639170000902', $1,
                   timestamptz '2099-12-29 10:00+08', timestamptz '2099-12-29 11:00+08',
                   'CONFIRMED', 100000, 0, 100000)`,
          [EMP_CARA]
        );
        await c.query(
          `insert into public.booking_counters (day, last_value) values ($1::date, 2)
           on conflict (day) do update set last_value = 2`,
          [day]
        );

        await c.query(`select public.sync_booking_counters()`);

        const { rows } = await c.query(
          `select last_value from public.booking_counters where day = $1::date`,
          [day]
        );
        expect(Number(rows[0].last_value)).toBeGreaterThanOrEqual(7);
      });
    });

    it("is not reachable with the publishable key", async () => {
      // Internal bookkeeping: scripts call it directly, PostgREST never should.
      const { rows } = await db().query(
        `select has_function_privilege('anon', 'public.sync_booking_counters()', 'EXECUTE') as anon,
                has_function_privilege('authenticated', 'public.sync_booking_counters()', 'EXECUTE') as auth`
      );
      expect(rows[0].anon).toBe(false);
      expect(rows[0].auth).toBe(false);
    });
  });

  describe("POST /api/v1/bookings", () => {
    it("still creates a booking when a reference the counter would issue is taken", async () => {
      const day = await branchDay();
      const taken = await counterOnlyNextReference(day);

      // Recreate the drift the demo seeder leaves: a reference is in use that
      // the counter has never issued. Before migration 27 this made the next
      // booking fail with 409 CONFLICT and take the public booking flow down
      // with it.
      const slot = nextWorkingSlot(2, 11);
      const { rows } = await db().query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, start_time, end_time,
            status, subtotal_cents, discount_cents, total_cents)
         values ($1, 'Taken', '+639170000901', $2, $3, $4, 'CONFIRMED', 100000, 0, 100000)
         returning id`,
        [taken, EMP_CARA, ISO(slot), ISO(new Date(slot.getTime() + 3_600_000))]
      );
      created.push(rows[0].id);

      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(nextWorkingSlot(3, 11)),
          guest: { name: "Reference Probe", phone: "+639170000903" },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.reference).not.toBe(taken);
      expect(res.body.data.reference).toMatch(/^BA-\d{8}-\d{4}$/);
      created.push(res.body.data.id);
    });
  });
});
