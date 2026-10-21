import { connectDb, db, disconnectDb, inRollback } from "../helpers/db";

/**
 * The structural guarantees.
 *
 * These assert against the database itself rather than through the API,
 * because the whole point of putting these rules in Postgres is that they hold
 * even when the API is not the one doing the writing. A test that only proves
 * "the service layer checks for conflicts" would pass against a schema with no
 * constraint at all.
 */
describe("schema guarantees", () => {
  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  describe("double-booking", () => {
    it("has the exclusion constraint on bookings", async () => {
      const { rows } = await db().query(
        `select conname, pg_get_constraintdef(oid) as def
           from pg_constraint
          where conrelid = 'public.bookings'::regclass and conname = 'bookings_no_overlap'`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].def).toContain("EXCLUDE USING gist");
      expect(rows[0].def).toContain("tstzrange");
      // Cancelled and no-show bookings must not hold their slot.
      expect(rows[0].def).toContain("CANCELLED");
      expect(rows[0].def).toContain("NO_SHOW");
    });

    it("rejects a raw overlapping INSERT that bypasses the service layer", async () => {
      await inRollback(async (c) => {
        const emp = "22222222-0000-0000-0000-000000000001";
        const { rows: svc } = await c.query(
          `select id, duration_minutes from public.services where id = '11111111-0000-0000-0000-000000000001'`
        );
        const dur = svc[0].duration_minutes;

        const insert = (offsetHours: number) =>
          c.query(
            `insert into public.bookings
               (reference, guest_name, guest_phone, employee_id, start_time, end_time,
                status, subtotal_cents, discount_cents, total_cents)
             values
               ($1, 'Raw Guest', '+639170000000', $2,
                timestamptz '2030-06-03 01:00:00+00' + ($3 || ' hours')::interval,
                timestamptz '2030-06-03 01:00:00+00' + ($3 || ' hours')::interval + ($4 || ' minutes')::interval,
                'CONFIRMED', 0, 0, 0)`,
            [crypto.randomUUID(), emp, offsetHours, dur]
          );

        await insert(0);
        // Overlaps by 30 minutes -> must raise 23P01.
        await expect(insert(0.5)).rejects.toMatchObject({ code: "23P01" });
      });
    });

    it("allows a back-to-back booking that only touches at the boundary", async () => {
      await inRollback(async (c) => {
        const emp = "22222222-0000-0000-0000-000000000001";
        const insert = (startIso: string, endIso: string) =>
          c.query(
            `insert into public.bookings
               (reference, guest_name, guest_phone, employee_id, start_time, end_time,
                status, subtotal_cents, discount_cents, total_cents)
             values ($1, 'Raw Guest', '+639170000000', $2, $3, $4, 'CONFIRMED', 0, 0, 0)`,
            [crypto.randomUUID(), emp, startIso, endIso]
          );

        await insert("2030-06-04T01:00:00Z", "2030-06-04T02:00:00Z");
        // [start, end) is half-open, so 02:00-03:00 is adjacent, not overlapping.
        await expect(insert("2030-06-04T02:00:00Z", "2030-06-04T03:00:00Z")).resolves.toBeDefined();
      });
    });

    it("lets a cancelled booking's slot be reused immediately", async () => {
      await inRollback(async (c) => {
        const emp = "22222222-0000-0000-0000-000000000001";
        const first = await c.query(
          `insert into public.bookings
             (reference, guest_name, guest_phone, employee_id, start_time, end_time,
              status, subtotal_cents, discount_cents, total_cents, cancelled_at)
           values ($1, 'Raw Guest', '+639170000000', $2, '2030-06-05T01:00:00Z', '2030-06-05T02:00:00Z',
                   'CANCELLED', 0, 0, 0, now())
           returning id`,
          [crypto.randomUUID(), emp]
        );
        expect(first.rows[0].id).toBeTruthy();

        // The WHERE clause on the constraint excludes CANCELLED, so this
        // insert must succeed.
        await expect(
          c.query(
            `insert into public.bookings
               (reference, guest_name, guest_phone, employee_id, start_time, end_time,
                status, subtotal_cents, discount_cents, total_cents)
             values ($1, 'Raw Guest', '+639170000000', $2, '2030-06-05T01:00:00Z', '2030-06-05T02:00:00Z',
                     'CONFIRMED', 0, 0, 0)`,
            [crypto.randomUUID(), emp]
          )
        ).resolves.toBeDefined();
      });
    });
  });

  describe("row level security", () => {
    it("has RLS enabled on every table in public", async () => {
      const { rows } = await db().query(
        `select c.relname
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
          order by 1`
      );
      // An empty list is the assertion: the absence of a policy IS the denial,
      // so a table with RLS off is a table that leaks.
      expect(rows.map((r) => r.relname)).toEqual([]);
    });

    it("denies anon and authenticated EXECUTE on every write function", async () => {
      const { rows } = await db().query(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('create_booking','cancel_booking','reschedule_booking',
                              'check_in_booking','get_dashboard_summary','next_booking_reference')
            and (has_function_privilege('anon', p.oid, 'EXECUTE')
                 or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          order by 1`
      );
      expect(rows.map((r) => r.proname)).toEqual([]);
    });

    it("does allow anon to execute the two public read functions", async () => {
      const { rows } = await db().query(
        `select p.proname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('get_available_slots','validate_promo')
            and has_function_privilege('anon', p.oid, 'EXECUTE')
          order by 1`
      );
      expect(rows.map((r) => r.proname)).toEqual(["get_available_slots", "validate_promo"]);
    });

    it("revokes direct SELECT on bookings from anon", async () => {
      const { rows } = await db().query(
        `select has_table_privilege('anon', 'public.bookings', 'SELECT') as can_read`
      );
      expect(rows[0].can_read).toBe(false);
    });

    it("does not grant UPDATE on profiles.role to authenticated", async () => {
      // The column-scoped grant is what stops `update profiles set role =
      // 'ADMIN'` from being a one-line privilege escalation.
      const { rows } = await db().query(
        `select
           has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')      as can_role,
           has_column_privilege('authenticated', 'public.profiles', 'is_active', 'UPDATE') as can_active,
           has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE') as can_name`
      );
      expect(rows[0].can_role).toBe(false);
      expect(rows[0].can_active).toBe(false);
      expect(rows[0].can_name).toBe(true);
    });
  });

  describe("integrity constraints", () => {
    it("rejects a booking whose arithmetic does not hold", async () => {
      await inRollback(async (c) => {
        await expect(
          c.query(
            `insert into public.bookings
               (reference, guest_name, guest_phone, employee_id, start_time, end_time,
                status, subtotal_cents, discount_cents, total_cents)
             values ($1, 'Raw Guest', '+639170000000', $2, '2030-07-01T01:00:00Z', '2030-07-01T02:00:00Z',
                     'CONFIRMED', 100000, 50000, 999999)`,
            [crypto.randomUUID(), "22222222-0000-0000-0000-000000000001"]
          )
        ).rejects.toMatchObject({ code: "23514" });
      });
    });

    it("rejects a booking with neither a client nor a guest phone", async () => {
      await inRollback(async (c) => {
        await expect(
          c.query(
            `insert into public.bookings
               (reference, employee_id, start_time, end_time, status,
                subtotal_cents, discount_cents, total_cents)
             values ($1, $2, '2030-07-02T01:00:00Z', '2030-07-02T02:00:00Z', 'CONFIRMED', 0, 0, 0)`,
            [crypto.randomUUID(), "22222222-0000-0000-0000-000000000001"]
          )
        ).rejects.toMatchObject({ code: "23514" });
      });
    });

    it("requires cancelled_at to be set if and only if the status is CANCELLED", async () => {
      await inRollback(async (c) => {
        await expect(
          c.query(
            `insert into public.bookings
               (reference, guest_name, guest_phone, employee_id, start_time, end_time,
                status, subtotal_cents, discount_cents, total_cents)
             values ($1, 'Raw Guest', '+639170000000', $2, '2030-07-03T01:00:00Z', '2030-07-03T02:00:00Z',
                     'CANCELLED', 0, 0, 0)`,
            [crypto.randomUUID(), "22222222-0000-0000-0000-000000000001"]
          )
        ).rejects.toMatchObject({ code: "23514" });
      });
    });

    it("refuses a status transition out of a terminal state", async () => {
      await inRollback(async (c) => {
        const { rows } = await c.query(
          `insert into public.bookings
             (reference, guest_name, guest_phone, employee_id, start_time, end_time,
              status, subtotal_cents, discount_cents, total_cents)
           values ($1, 'Raw Guest', '+639170000000', $2, '2030-07-04T01:00:00Z', '2030-07-04T02:00:00Z',
                   'COMPLETED', 0, 0, 0)
           returning id`,
          [crypto.randomUUID(), "22222222-0000-0000-0000-000000000001"]
        );
        await expect(
          c.query(`update public.bookings set status = 'PENDING' where id = $1`, [rows[0].id])
        ).rejects.toMatchObject({ code: "P0007" });
      });
    });
  });
});
