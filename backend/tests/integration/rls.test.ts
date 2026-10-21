import {
  connectDb,
  createAuthUser,
  db,
  disconnectDb,
  expectQueryError,
  inRollback,
} from "../helpers/db";

/**
 * RLS isolation.
 *
 * These run as the `authenticated` role with a forged `request.jwt.claims`,
 * which is exactly what PostgREST does when a browser calls it with a user's
 * token. If a policy is wrong, this is the test that catches it - a client
 * reading another client's bookings is the kind of bug that ends a salon's
 * relationship with its customers.
 *
 * Everything happens inside a transaction that rolls back, so no fixtures
 * leak and `set local role` cannot escape into the next test.
 */
describe("RLS isolation", () => {
  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  /** Impersonate a signed-in user for the remainder of the transaction. */
  async function actAs(c: import("pg").Client, userId: string) {
    await c.query(`set local role authenticated`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }

  async function actAsAnon(c: import("pg").Client) {
    await c.query(`set local role anon`);
    await c.query(`select set_config('request.jwt.claims', '', true)`);
  }

  const EMP_ANA = "22222222-0000-0000-0000-000000000001";

  it("shows a client only their own bookings", async () => {
    await inRollback(async (c) => {
      const a = await createAuthUser(c, { fullName: "RLS A" });
      const b = await createAuthUser(c, { fullName: "RLS B" });

      const { rows: clients } = await c.query(
        `insert into public.clients (profile_id, full_name)
         values ($1, 'RLS Client A'), ($2, 'RLS Client B')
         returning id`,
        [a, b]
      );
      const [clientA, clientB] = clients.map((x) => x.id);

      await c.query(
        `insert into public.bookings
           (reference, client_id, employee_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values
           ($1, $2, $4, '2031-01-01T01:00:00Z', '2031-01-01T02:00:00Z', 'CONFIRMED', 0, 0, 0),
           ($3, $5, $4, '2031-01-02T01:00:00Z', '2031-01-02T02:00:00Z', 'CONFIRMED', 0, 0, 0)`,
        [crypto.randomUUID(), clientA, crypto.randomUUID(), EMP_ANA, clientB]
      );

      await actAs(c, a);
      const { rows: visible } = await c.query(`select client_id from public.bookings order by start_time`);

      expect(visible).toHaveLength(1);
      expect(visible[0].client_id).toBe(clientA);
    });
  });

  it("hides guest bookings from every signed-in client", async () => {
    await inRollback(async (c) => {
      const userId = await createAuthUser(c, { fullName: "Guest Viewer" });
      await c.query(`insert into public.clients (profile_id, full_name) values ($1, 'Viewer')`, [userId]);

      // A guest booking has client_id IS NULL, so no policy can match it.
      await c.query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values ($1, 'Anonymous', '+639179999999', $2, '2031-02-01T01:00:00Z', '2031-02-01T02:00:00Z',
                 'CONFIRMED', 0, 0, 0)`,
        [crypto.randomUUID(), EMP_ANA]
      );

      await actAs(c, userId);
      const { rows } = await c.query(
        `select count(*)::int as n from public.bookings where guest_phone is not null`
      );
      expect(rows[0].n).toBe(0);
    });
  });

  it("lets a client read their own profile but not another's", async () => {
    await inRollback(async (c) => {
      const self = await createAuthUser(c, { fullName: "Self" });
      await createAuthUser(c, { fullName: "Other" });

      await actAs(c, self);
      const { rows: seen } = await c.query(`select full_name from public.profiles`);
      expect(seen).toHaveLength(1);
      expect(seen[0].full_name).toBe("Self");
    });
  });

  it("stops a client from promoting themselves to ADMIN", async () => {
    await inRollback(async (c) => {
      const userId = await createAuthUser(c, { fullName: "Escalator" });

      await actAs(c, userId);
      // The column-scoped GRANT is what stops this, not the policy.
      await expectQueryError(
        c,
        `update public.profiles set role = 'ADMIN' where id = $1`,
        [userId],
        "42501"
      );

      // And the role really is unchanged.
      await c.query(`reset role`);
      const { rows } = await c.query(`select role from public.profiles where id = $1`, [userId]);
      expect(rows[0].role).toBe("CLIENT");
    });
  });

  it("lets a client edit their own name", async () => {
    await inRollback(async (c) => {
      const userId = await createAuthUser(c, { fullName: "Before" });
      await actAs(c, userId);
      await expect(
        c.query(`update public.profiles set full_name = 'After' where id = $1`, [userId])
      ).resolves.toBeDefined();
    });
  });

  it("lets anon read the active service catalogue", async () => {
    await inRollback(async (c) => {
      await actAsAnon(c);
      const { rows } = await c.query(`select name from public.services where is_active`);
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it("hides inactive services from anon", async () => {
    await inRollback(async (c) => {
      await c.query(`update public.services set is_active = false where name = 'Cut & Style'`);
      await actAsAnon(c);
      const { rows } = await c.query(`select name from public.services`);
      expect(rows.map((r) => r.name)).not.toContain("Cut & Style");
    });
  });

  it("blocks anon from reading private tables", async () => {
    await inRollback(async (c) => {
      for (const table of [
        "bookings",
        "booking_items",
        "clients",
        "profiles",
        "promo_codes",
        "promo_redemptions",
        "qr_tokens",
        "checkins",
        "audit_logs",
        "login_attempts",
        "working_hours",
        "time_off",
      ]) {
        await actAsAnon(c);
        // Either a missing GRANT (42501) or RLS filtering to zero rows is an
        // acceptable denial; leaking a single row is not.
        await c.query("savepoint probe");
        try {
          const { rows } = await c.query(`select count(*)::int as n from public.${table}`);
          expect(rows[0].n).toBe(0);
        } catch (err) {
          expect((err as { code?: string }).code).toBe("42501");
        }
        await c.query("rollback to savepoint probe");
      }
    });
  });

  it("blocks anon from writing to any table", async () => {
    await inRollback(async (c) => {
      await actAsAnon(c);
      await expectQueryError(
        c,
        `insert into public.services (name, category, price_cents, duration_minutes)
         values ('Anon Injection', 'SPA', 0, 30)`,
        [],
        "42501"
      );
    });
  });

  it("blocks anon from calling the write functions", async () => {
    await inRollback(async (c) => {
      await actAsAnon(c);
      await expectQueryError(
        c,
        `select public.create_booking(
           p_service_ids => array['11111111-0000-0000-0000-000000000001'::uuid],
           p_employee_id => $1::uuid,
           p_start_time => '2031-05-05T01:00:00Z'::timestamptz,
           p_guest => '{"name":"Anon","phone":"+639170000000"}'::jsonb)`,
        [EMP_ANA],
        "42501"
      );
    });
  });

  it("allows anon to call get_available_slots", async () => {
    await inRollback(async (c) => {
      await actAsAnon(c);
      await expect(
        c.query(
          `select * from public.get_available_slots(
             p_service_id => '11111111-0000-0000-0000-000000000001'::uuid,
             p_date => '2031-06-02'::date)`
        )
      ).resolves.toBeDefined();
    });
  });
});
