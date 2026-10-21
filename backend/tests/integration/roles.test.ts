import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  api,
  as,
  createTestAdmin,
  createTestClient,
  createTestConcierge,
  createTestStaff,
  deleteTestUsers,
  type TestUser,
} from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";

/**
 * The four-role model, asserted route by route.
 *
 * Why this file exists: after migration 24 the enum is
 * `ADMIN | CONCIERGE | EMPLOYEE | CLIENT`, and the interesting question is not
 * whether ADMIN still works - it is whether CONCIERGE is *exactly* the front
 * desk. A gate that is too wide and a gate that is too narrow are both bugs,
 * and each needs its own assertion, because a route that is broken outright
 * (a typo in the path, a middleware mounted in the wrong order) also "refuses"
 * the role you expected to be refused. So every case below checks both
 * directions: who is let in, and who is turned away.
 *
 * The fixtures are this suite's own. Linking a test account to a seeded
 * employee row would race the QR suite, which links a different account to the
 * same row - whichever ran second would silently take the row over.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeRoles = hasServiceRole ? describe : describe.skip;

describeRoles("role gates", () => {
  const created: TestUser[] = [];
  let employeeRowId = "";

  beforeAll(async () => {
    await connectDb();
    const { rows } = await db().query(
      `insert into public.employees (full_name, title) values ('__roles_test_employee', 'Therapist') returning id`
    );
    employeeRowId = rows[0].id;
  });

  afterAll(async () => {
    // Order matters: the auth user cascades to its profile, which clears
    // `employees.profile_id`; only then can the row be removed.
    await deleteTestUsers(created);
    if (employeeRowId) {
      await db().query(`delete from public.employees where id = $1`, [employeeRowId]);
    }
    await disconnectDb();
  });

  const employee = () => createTestStaff(employeeRowId);
  const concierge = () => createTestConcierge();

  describe("GET /api/v1/loyalty/clients — the desk's worklist", () => {
    it("lets the concierge read it", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/loyalty/clients?limit=1").set(...as(desk.token));
      expect(res.status).toBe(200);
    });

    it("lets an admin read it", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/loyalty/clients?limit=1").set(...as(admin.token));
      expect(res.status).toBe(200);
    });

    it("refuses an employee — a therapist does not grant a discount", async () => {
      const staff = await employee();
      created.push(staff);

      const res = await request(api()).get("/api/v1/loyalty/clients?limit=1").set(...as(staff.token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("refuses a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api()).get("/api/v1/loyalty/clients?limit=1").set(...as(client.token));
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/admin/dashboard — the owner's numbers", () => {
    const query = "?from=2026-01-01&to=2026-12-31";

    it("refuses the concierge even though they run the desk", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get(`/api/v1/admin/dashboard${query}`).set(...as(desk.token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("refuses an employee", async () => {
      const staff = await employee();
      created.push(staff);

      const res = await request(api()).get(`/api/v1/admin/dashboard${query}`).set(...as(staff.token));
      expect(res.status).toBe(403);
    });

    it("admits an admin", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get(`/api/v1/admin/dashboard${query}`).set(...as(admin.token));
      expect(res.status).toBe(200);
    });
  });

  describe("PATCH /api/v1/bookings/:id/room — a DESK decision", () => {
    /**
     * A booking id that does not exist. The gate runs before the handler, so
     * the response proves the gate's verdict without needing a fixture: a
     * caller who is refused never reaches the lookup and gets 403, and a
     * caller who is admitted gets the handler's own 404.
     */
    const unknownBooking = () => randomUUID();

    it("refuses an employee — they report a dirty room, they do not reassign it", async () => {
      const staff = await employee();
      created.push(staff);

      const res = await request(api())
        .patch(`/api/v1/bookings/${unknownBooking()}/room`)
        .set(...as(staff.token))
        .send({ roomId: randomUUID() });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("admits the concierge past the gate", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .patch(`/api/v1/bookings/${unknownBooking()}/room`)
        .set(...as(desk.token))
        .send({ roomId: randomUUID() });

      // Past the gate and into the handler, which reports the booking is not
      // there. 403 would mean the gate is still too narrow.
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/v1/qr/door — the permanent sticker", () => {
    it("is admin-only", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/qr/door").set(...as(desk.token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("admits an admin", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/qr/door").set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.authorises).toBe(false);
    });
  });

  describe("GET /api/v1/qr/branch — the scanner descriptor", () => {
    it("admits an employee: any staff device may read it", async () => {
      const staff = await employee();
      created.push(staff);

      const res = await request(api()).get("/api/v1/qr/branch").set(...as(staff.token));
      expect(res.status).toBe(200);
      // It is not a credential, and it says so.
      expect(res.body.data.authorises).toBe(false);
    });

    it("still refuses an anonymous caller", async () => {
      const res = await request(api()).get("/api/v1/qr/branch");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/employees/quotas — the desk's board", () => {
    it("admits the concierge, and reports a row per active stylist", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/employees/quotas").set(...as(desk.token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);

      const row = res.body.data[0];
      expect(row).toEqual(
        expect.objectContaining({
          employeeId: expect.any(String),
          employeeName: expect.any(String),
          quota: expect.any(Number),
          completed: expect.any(Number),
          scheduled: expect.any(Number),
          remaining: expect.any(Number),
          met: expect.any(Boolean),
        })
      );
    });

    /*
     * The literal path has to be declared before `/:id`, or Express reads
     * "quotas" as an id and the uuid check rejects it. A 400 here would mean
     * the ordering regressed; only a 200 proves the route was reached.
     */
    it("is reached as a literal path, not parsed as an :id", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api()).get("/api/v1/employees/quotas").set(...as(desk.token));
      expect(res.status).toBe(200);
      expect(res.body.error).toBeUndefined();
    });

    it("refuses an employee — the floor board is the desk's", async () => {
      const staff = await employee();
      created.push(staff);

      const res = await request(api()).get("/api/v1/employees/quotas").set(...as(staff.token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("refuses an anonymous caller", async () => {
      const res = await request(api()).get("/api/v1/employees/quotas");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/employees/:id/quota — one stylist", () => {
    it("lets an employee read their own progress", async () => {
      const staff = await employee();
      created.push(staff);

      const res = await request(api())
        .get(`/api/v1/employees/${employeeRowId}/quota`)
        .set(...as(staff.token));

      expect(res.status).toBe(200);
      expect(res.body.data.employeeId).toBe(employeeRowId);

      const q = res.body.data;
      expect(q.remaining).toBe(Math.max(q.quota - q.completed, 0));
      expect(q.met).toBe(q.completed >= q.quota);
      // A plain calendar day, resolved in the branch timezone - not an instant.
      expect(q.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("honours an explicit date and echoes it back", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .get(`/api/v1/employees/${employeeRowId}/quota?date=2026-01-02`)
        .set(...as(desk.token));

      expect(res.status).toBe(200);
      expect(res.body.data.date).toBe("2026-01-02");
      // Nothing was completed on an arbitrary past day.
      expect(res.body.data.completed).toBe(0);
      expect(res.body.data.met).toBe(false);
    });

    it("rejects a malformed date rather than guessing", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .get(`/api/v1/employees/${employeeRowId}/quota?date=02-01-2026`)
        .set(...as(desk.token));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("404s an unknown stylist rather than reporting a zero", async () => {
      const desk = await concierge();
      created.push(desk);

      const res = await request(api())
        .get(`/api/v1/employees/${randomUUID()}/quota`)
        .set(...as(desk.token));

      expect(res.status).toBe(404);
    });

    it("refuses a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .get(`/api/v1/employees/${employeeRowId}/quota`)
        .set(...as(client.token));

      expect(res.status).toBe(403);
    });
  });
});
