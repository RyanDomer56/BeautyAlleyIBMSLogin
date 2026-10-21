import request from "supertest";
import { api, as, createTestAdmin, createTestClient, deleteTestUsers, type TestUser } from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";
import { ISO, SLOT_BANDS, nextWorkingSlot, useSlotBand } from "../helpers/time";

/**
 * Admin reporting and client management.
 *
 * The reporting endpoints are where a permissions mistake is most expensive:
 * /admin/dashboard exposes revenue, /admin/clients/export.csv exposes the whole
 * customer list. Both are tested for the negative case as well as the positive.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeAdmin = hasServiceRole ? describe : describe.skip;

// Claim this suite's day-offsets before any slot is computed, so it cannot
// collide with another suite's bookings. See tests/helpers/time.ts.
useSlotBand(SLOT_BANDS.admin);

describeAdmin("admin", () => {
  const created: TestUser[] = [];

  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await deleteTestUsers(created);
    await disconnectDb();
  });

  describe("GET /api/v1/admin/dashboard", () => {
    it("returns totals for a date range", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .get("/api/v1/admin/dashboard?from=2030-01-01&to=2030-12-31")
        .set(...as(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("totals");
      expect(res.body.data.totals).toHaveProperty("bookings");
      expect(res.body.data.totals).toHaveProperty("revenueCents");
      expect(Array.isArray(res.body.data.byDay)).toBe(true);
      expect(Array.isArray(res.body.data.topServices)).toBe(true);
    });

    it("counts only completed bookings toward revenue", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const from = "2030-02-01";
      const to = "2030-02-28";

      // One completed, one cancelled - same day, same amount.
      //
      // `cancelled_at` is set on the cancelled row because the
      // `bookings_cancel_stamp` CHECK requires it to be present exactly when
      // the status is CANCELLED. A raw INSERT bypasses the service layer, so it
      // has to satisfy that itself.
      await db().query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
            cancelled_at, subtotal_cents, discount_cents, total_cents)
         values
           ($1, 'Done',  '+639200000001', $3, '2030-02-10T01:00:00Z', '2030-02-10T02:00:00Z', 'COMPLETED', null,  100000, 0, 100000),
           ($2, 'Gone',  '+639200000002', $3, '2030-02-11T01:00:00Z', '2030-02-11T02:00:00Z', 'CANCELLED', now(), 100000, 0, 100000)`,
        [`BA-ADM-${Date.now()}-a`, `BA-ADM-${Date.now()}-b`, "22222222-0000-0000-0000-000000000001"]
      );

      const res = await request(api())
        .get(`/api/v1/admin/dashboard?from=${from}&to=${to}`)
        .set(...as(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.totals.revenueCents).toBe(100000);
      expect(res.body.data.totals.cancelled).toBeGreaterThanOrEqual(1);
    });

    it("rejects a range where `to` precedes `from`", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .get("/api/v1/admin/dashboard?from=2030-12-31&to=2030-01-01")
        .set(...as(admin.token));
      expect(res.status).toBe(400);
    });

    it("requires both dates", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/dashboard").set(...as(admin.token));
      expect(res.status).toBe(400);
    });

    it("refuses a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .get("/api/v1/admin/dashboard?from=2030-01-01&to=2030-12-31")
        .set(...as(client.token));
      expect(res.status).toBe(403);
    });
  });

  describe("clients", () => {
    it("lists clients with lifetime value", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/clients").set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0]).toHaveProperty("lifetimeValueCents");
      expect(Number.isInteger(res.body.data[0].lifetimeValueCents)).toBe(true);
    });

    it("searches by name", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/clients?q=Ada").set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.every((c: { fullName: string }) => /ada/i.test(c.fullName))).toBe(true);
    });

    it("returns one client with recent bookings", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const list = await request(api()).get("/api/v1/admin/clients").set(...as(admin.token));
      const id = list.body.data[0].id;

      const res = await request(api()).get(`/api/v1/admin/clients/${id}`).set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(Array.isArray(res.body.data.recentBookings)).toBe(true);
    });

    it("updates a client", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const list = await request(api()).get("/api/v1/admin/clients").set(...as(admin.token));
      const id = list.body.data[0].id;

      const res = await request(api())
        .patch(`/api/v1/admin/clients/${id}`)
        .set(...as(admin.token))
        .send({ notes: "VIP - prefers Ana" });

      expect(res.status).toBe(200);
    });

    it("soft-deletes a client rather than removing the row", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const list = await request(api()).get("/api/v1/admin/clients").set(...as(admin.token));
      const id = list.body.data[0].id;

      const res = await request(api()).delete(`/api/v1/admin/clients/${id}`).set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);

      // The row must still exist - deleting it would orphan the booking history.
      const { rows } = await db().query(`select is_active from public.clients where id = $1`, [id]);
      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(false);

      // Restore for other suites.
      await db().query(`update public.clients set is_active = true where id = $1`, [id]);
    });

    it("404s an unknown client", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .get("/api/v1/admin/clients/99999999-0000-0000-0000-000000000000")
        .set(...as(admin.token));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CLIENT_NOT_FOUND");
    });
  });

  describe("GET /api/v1/admin/clients/export.csv", () => {
    it("returns a CSV attachment", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/clients/export.csv").set(...as(admin.token));

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      expect(res.text).toContain("full_name");
      expect(res.text).toContain("Ada Cruz");
    });

    it("routes the literal path before the :id parameter", async () => {
      // If `/clients/:id` were declared first, `export.csv` would be captured
      // by it and fail uuid validation with a 400.
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/clients/export.csv").set(...as(admin.token));
      expect(res.status).not.toBe(400);
    });

    it("refuses a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api()).get("/api/v1/admin/clients/export.csv").set(...as(client.token));
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/admin/audit-logs", () => {
    it("returns audit entries with a paginated envelope", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/audit-logs").set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("meta");
    });

    it("records a booking creation in the audit trail", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: ["11111111-0000-0000-0000-000000000001"],
          employeeId: "22222222-0000-0000-0000-000000000001",
          // A real in-shift slot: "now + 5 days" lands outside the stylist's
          // 09:00-18:00 shift for most of the day, so the booking would be
          // refused and the audit assertion would pass vacuously.
          startTime: ISO(nextWorkingSlot(5, 10)),
          guest: { name: "Audited", phone: "+639200000009" },
        })
        .set(...as(admin.token));
      expect(res.status).toBe(201);

      /*
       * Ask about THIS booking, not about a global count.
       *
       * The original assertion was "one more booking.created row than before",
       * which is a statement about the whole database - and four suites share
       * it, running in parallel workers. A booking created by another suite
       * between the two counts moved the number by two and failed a test that
       * had done nothing wrong. Naming the booking makes the assertion about
       * the thing under test, and it is stronger: it proves the audit row is
       * attributed to this booking and this actor, which a count never did.
       */
      const after = await db().query(
        `select count(*)::int as n
           from public.audit_logs
          where action = 'booking.created'
            and entity_id = $1
            and actor_id = $2`,
        [res.body.data.id, admin.id]
      );
      expect(after.rows[0].n).toBe(1);
    });

    it("filters by action", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .get("/api/v1/admin/audit-logs?action=booking.created")
        .set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.every((r: { action: string }) => r.action === "booking.created")).toBe(true);
    });
  });

  describe("GET /api/v1/admin/bookings", () => {
    it("lists bookings for staff review", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/admin/bookings").set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("meta");
    });

    it("filters by status", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .get("/api/v1/admin/bookings?status=COMPLETED")
        .set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.every((b: { status: string }) => b.status === "COMPLETED")).toBe(true);
    });
  });
});
