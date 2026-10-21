import request from "supertest";
import {
  api,
  as,
  createTestAdmin,
  createTestClient,
  createTestConcierge,
  deleteTestUsers,
  type TestUser,
} from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";

/**
 * Authentication, roles and the brute-force lockout.
 *
 * The lockout is the interesting one. It is counted in `public.login_attempts`
 * rather than in process memory, specifically so it survives a restart and
 * cannot be evaded by rotating IPs. These tests prove that by checking the
 * *database* counter, not just the response code.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeAuth = hasServiceRole ? describe : describe.skip;

describeAuth("auth", () => {
  const created: TestUser[] = [];

  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await deleteTestUsers(created);
  });

  describe("POST /api/v1/auth/register", () => {
    it("creates an account and a profile with the CLIENT role", async () => {
      const email = `register.${Date.now()}@beautyalley.ph`;
      const res = await request(api())
        .post("/api/v1/auth/register")
        .send({ email, password: "RegisterPass123!", fullName: "Registered User" });

      // 201 when it works; the project's mailer is rate-limited, so a 429 is a
      // legitimate environment outcome rather than a code failure.
      if (res.status === 429) return;

      expect(res.status).toBe(201);

      // The trigger must have mirrored the auth user into profiles.
      const { rows } = await db().query(
        `select role, full_name from public.profiles where id = $1`,
        [res.body.data.user.id]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe("CLIENT");
      expect(rows[0].full_name).toBe("Registered User");

      // Clean up the account this test created.
      await db().query(`delete from auth.users where id = $1`, [res.body.data.user.id]);
    });

    it("ignores a role supplied in the sign-up payload", async () => {
      const email = `escalate.${Date.now()}@beautyalley.ph`;
      const res = await request(api())
        .post("/api/v1/auth/register")
        .send({ email, password: "Escalate123!", fullName: "Escalator", role: "ADMIN" });

      if (res.status === 429) return;
      expect(res.status).toBe(201);

      // The trigger reads the role from `app_metadata`, which a sign-up cannot
      // write - so a self-declared ADMIN must come out as CLIENT.
      const { rows } = await db().query(`select role from public.profiles where id = $1`, [
        res.body.data.user.id,
      ]);
      expect(rows[0].role).toBe("CLIENT");

      await db().query(`delete from auth.users where id = $1`, [res.body.data.user.id]);
    });

    it("rejects a short password", async () => {
      const res = await request(api())
        .post("/api/v1/auth/register")
        .send({ email: `short.${Date.now()}@beautyalley.ph`, password: "abc", fullName: "Short" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("rejects a malformed email", async () => {
      const res = await request(api())
        .post("/api/v1/auth/register")
        .send({ email: "not-an-email", password: "ValidPass123!", fullName: "Bad Email" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/auth/login", () => {
    it("issues a session for valid credentials", async () => {
      const user = await createTestClient("Login User");
      created.push(user);

      const res = await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: user.password });

      expect(res.status).toBe(200);
      expect(res.body.data.session.accessToken).toBeTruthy();
      expect(res.body.data.session.refreshToken).toBeTruthy();
      expect(res.body.data.user.role).toBe("CLIENT");
    });

    it("refuses a wrong password without revealing whether the account exists", async () => {
      const user = await createTestClient("Wrong Pass");
      created.push(user);

      const res = await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: "DefinitelyWrong123!" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("gives the same answer for an unknown account", async () => {
      const res = await request(api())
        .post("/api/v1/auth/login")
        .send({ email: `nobody.${Date.now()}@beautyalley.ph`, password: "Whatever123!" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("records a failed attempt in the database", async () => {
      const user = await createTestClient("Audit Login");
      created.push(user);

      await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: "WrongAgain123!" });

      const { rows } = await db().query(
        `select count(*)::int as n from public.login_attempts
          where email = $1 and succeeded = false`,
        [user.email]
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("locks the account after too many failures", async () => {
      const user = await createTestClient("Locked Out");
      created.push(user);

      // Five failures is the configured maximum.
      for (let i = 0; i < 5; i++) {
        await request(api())
          .post("/api/v1/auth/login")
          .send({ email: user.email, password: "WrongPassword123!" });
      }

      // The correct password must now also be refused.
      const res = await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: user.password });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_LOCKED");
    });

    it("clears the failure count after a successful sign-in", async () => {
      const user = await createTestClient("Clears Failures");
      created.push(user);

      await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: "WrongOnce123!" });

      await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: user.password });

      const { rows } = await db().query(
        `select count(*)::int as n from public.login_attempts
          where email = $1 and succeeded = false`,
        [user.email]
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("exchanges a refresh token for a new session", async () => {
      const user = await createTestClient("Refresher");
      created.push(user);

      const login = await request(api())
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: user.password });

      const res = await request(api())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: login.body.data.session.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.session.accessToken).toBeTruthy();
    });

    it("rejects a bogus refresh token", async () => {
      const res = await request(api())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: "not-a-real-refresh-token" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("returns the caller's identity and role", async () => {
      const user = await createTestClient("Me Endpoint");
      created.push(user);

      const res = await request(api()).get("/api/v1/auth/me").set(...as(user.token));
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(user.id);
      expect(res.body.data.role).toBe("CLIENT");
      expect(res.body.data.clientId).toBe(user.clientId);
    });

    it("reports the staff role and linked employee row", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api()).get("/api/v1/auth/me").set(...as(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe("ADMIN");
    });
  });

  describe("POST /api/v1/auth/logout", () => {
    it("revokes the session so the token stops working", async () => {
      const user = await createTestClient("Logout User");
      created.push(user);

      const before = await request(api()).get("/api/v1/auth/me").set(...as(user.token));
      expect(before.status).toBe(200);

      const out = await request(api()).post("/api/v1/auth/logout").set(...as(user.token));
      expect([200, 204]).toContain(out.status);

      // A revoked session must be rejected immediately, not at token expiry.
      const after = await request(api()).get("/api/v1/auth/me").set(...as(user.token));
      expect(after.status).toBe(401);
    });
  });

  describe("role-based access control", () => {
    it("refuses staff-creation from a non-admin", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .post("/api/v1/admin/users/staff")
        .set(...as(client.token))
        .send({
          email: `staff.${Date.now()}@beautyalley.ph`,
          password: "StaffPass123!",
          fullName: "New Employee",
          role: "EMPLOYEE",
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("refuses staff-creation from a concierge", async () => {
      // The desk runs reception; it does not hire. This is the whole point of
      // splitting CONCIERGE out of the old catch-all STAFF role.
      const concierge = await createTestConcierge();
      created.push(concierge);

      const res = await request(api())
        .post("/api/v1/admin/users/staff")
        .set(...as(concierge.token))
        .send({
          email: `staff.${Date.now()}@beautyalley.ph`,
          password: "StaffPass123!",
          fullName: "New Employee",
          role: "EMPLOYEE",
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });

    it("lets an admin create an EMPLOYEE account whose role sticks", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const email = `newstaff.${Date.now()}@beautyalley.ph`;
      const res = await request(api())
        .post("/api/v1/admin/users/staff")
        .set(...as(admin.token))
        .send({ email, password: "StaffPass123!", fullName: "New Employee", role: "EMPLOYEE" });

      expect(res.status).toBe(201);

      const { rows } = await db().query(`select role from public.profiles where id = $1`, [
        res.body.data.id,
      ]);
      expect(rows[0].role).toBe("EMPLOYEE");

      await db().query(`delete from auth.users where id = $1`, [res.body.data.id]);
    });

    it("lets an admin create a CONCIERGE account whose role sticks", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const email = `newconcierge.${Date.now()}@beautyalley.ph`;
      const res = await request(api())
        .post("/api/v1/admin/users/staff")
        .set(...as(admin.token))
        .send({ email, password: "StaffPass123!", fullName: "New Concierge", role: "CONCIERGE" });

      expect(res.status).toBe(201);

      const { rows } = await db().query(`select role from public.profiles where id = $1`, [
        res.body.data.id,
      ]);
      expect(rows[0].role).toBe("CONCIERGE");

      await db().query(`delete from auth.users where id = $1`, [res.body.data.id]);
    });

    it("refuses the retired STAFF label when creating an account", async () => {
      // `role_from_app_metadata` still maps a legacy 'STAFF' for auth users
      // that already carry it, but nothing should be able to mint a *new*
      // account under a label the enum no longer has.
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .post("/api/v1/admin/users/staff")
        .set(...as(admin.token))
        .send({
          email: `legacy.${Date.now()}@beautyalley.ph`,
          password: "StaffPass123!",
          fullName: "Legacy Staff",
          role: "STAFF",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("refuses service creation from a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .post("/api/v1/services")
        .set(...as(client.token))
        .send({ name: "Sneaky", category: "SPA", priceCents: 100, durationMinutes: 30 });
      expect(res.status).toBe(403);
    });

    it("refuses employee management from a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .post("/api/v1/employees")
        .set(...as(client.token))
        .send({ fullName: "Sneaky Stylist" });
      expect(res.status).toBe(403);
    });
  });
});
