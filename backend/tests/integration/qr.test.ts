import request from "supertest";
import { api, as, createTestStaff, deleteTestUsers, type TestUser } from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";

/**
 * QR check-in.
 *
 * The pass has two independent gates and both are tested: the HMAC signature
 * (proved in the unit suite) and the database row, which is the authority on
 * revoked / used / too-early / too-late. A test that only covered the happy
 * path would not notice if the revocation check were dropped.
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeQr = hasServiceRole ? describe : describe.skip;

describeQr("QR check-in", () => {
  const EMP_ANA = "22222222-0000-0000-0000-000000000001";

  const created: TestUser[] = [];
  /**
   * Every booking this suite places is for the same stylist, and the seed gives
   * that stylist one shift a day - so two 60-minute bookings starting 5 minutes
   * apart violate the EXCLUDE constraint and the insert fails with 23P01. Since
   * each test only needs its booking for the duration of that test, they are
   * deleted afterwards rather than left to accumulate.
   */
  const placedBookings: string[] = [];

  /**
   * Active stylists, EMP_ANA first.
   *
   * `placeBooking` rotates through these when the requested slot is taken. The
   * pass, the check-in window and the booking's status are what authorise a
   * check-in - not whose chair it is - so moving to a free stylist keeps every
   * time-based assertion (inside the window, too early, too late, replayed)
   * exactly as intended while removing a collision that has nothing to do with
   * what is being tested.
   */
  let candidateEmployees: string[] = [];

  beforeAll(async () => {
    await connectDb();
    const { rows } = await db().query(
      `select id from public.employees where is_active order by (id = $1) desc, id`,
      [EMP_ANA]
    );
    candidateEmployees = rows.map((r: { id: string }) => r.id);
  });

  afterEach(async () => {
    if (placedBookings.length === 0) return;
    // Children (booking_items, qr_tokens, checkins, promo_redemptions) all
    // cascade from bookings, so one statement is enough.
    await db().query(`delete from public.bookings where id = any($1::uuid[])`, [placedBookings]);
    placedBookings.length = 0;
  });

  afterAll(async () => {
    await deleteTestUsers(created);
    await disconnectDb();
  });

  /**
   * Place a booking directly at a controlled offset from now.
   *
   * The API cannot be used here: `create_booking` correctly refuses a start
   * time outside the stylist's shift, and the check-in window cases all need a
   * booking that starts in minutes rather than days.
   *
   * Two details the direct INSERT has to reproduce, because `create_booking`
   * does them and the endpoint under test depends on them:
   *
   *   * every booking gets a `qr_tokens` row - `GET /bookings/:id/qr` signs a
   *     pass for that row rather than minting one on demand, so a booking
   *     without it 400s for a reason no test is trying to check;
   *   * the booking is placed CONFIRMED and only then moved to the status the
   *     test asked for. A pass cannot be minted for a CANCELLED booking, so
   *     asking for one up front would leave the test holding `undefined`
   *     instead of the pass it means to replay. Cancelling afterwards - status
   *     plus token revocation, exactly as `cancel_booking` does it - gives the
   *     test a genuine, revoked pass.
   *
   * The insert is retried on the next stylist if the slot is taken. Guest
   * bookings have no `client_id`, so they do not cascade away when a suite
   * deletes its test users - which means a booking left behind by an earlier
   * suite (or a demo grid covering today) can occupy the exact window this
   * suite asks for. That is a collision with someone else's fixture, not a
   * property of check-in, so it is resolved by moving rather than by failing.
   */
  async function placeBooking(opts: { startInMinutes: number; durationMinutes?: number; status?: string }) {
    const start = new Date(Date.now() + opts.startInMinutes * 60_000);
    const end = new Date(start.getTime() + (opts.durationMinutes ?? 60) * 60_000);

    let bookingId: string | undefined;
    let lastError: unknown;

    for (const employeeId of candidateEmployees.length ? candidateEmployees : [EMP_ANA]) {
      try {
        const { rows } = await db().query(
          `insert into public.bookings
             (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
              subtotal_cents, discount_cents, total_cents)
           values ($1, 'QR Guest', '+639190000001', $2, $3, $4, 'CONFIRMED', 250000, 0, 250000)
           returning id`,
          [
            `BA-QR-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            employeeId,
            start.toISOString(),
            end.toISOString(),
          ]
        );
        bookingId = rows[0].id as string;
        break;
      } catch (err) {
        // 23P01: every stylist is busy in this exact window.
        if ((err as { code?: string }).code === "23P01") {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    if (!bookingId) throw lastError ?? new Error("placeBooking found no free stylist");

    placedBookings.push(bookingId);

    await db().query(
      `insert into public.qr_tokens (booking_id, expires_at)
       values ($1, $2::timestamptz + interval '1 day')`,
      [bookingId, end.toISOString()]
    );

    // Mint the pass through the public endpoint so the signed token is the one
    // the API actually issues, not a hand-built one.
    const qr = await request(api()).get(`/api/v1/bookings/${bookingId}/qr`);
    const pass = qr.body.data?.pass as string | undefined;

    // A missing pass means the fixture is broken, not that the test passed.
    // Returning `undefined` would let a later assertion fail somewhere far away
    // from the cause.
    if (typeof pass !== "string") {
      throw new Error(
        `placeBooking could not mint a pass: GET /bookings/${bookingId}/qr -> ${qr.status} ${JSON.stringify(qr.body)}`
      );
    }

    const status = opts.status ?? "CONFIRMED";
    if (status !== "CONFIRMED") {
      const cancelledAt = status === "CANCELLED" ? new Date().toISOString() : null;
      await db().query(
        `update public.bookings set status = $2::public.booking_status, cancelled_at = $3 where id = $1`,
        [bookingId, status, cancelledAt]
      );
      if (status === "CANCELLED" || status === "NO_SHOW") {
        await db().query(
          `update public.qr_tokens set revoked_at = now() where booking_id = $1 and revoked_at is null`,
          [bookingId]
        );
      }
    }

    return { bookingId, pass, qrStatus: qr.status };
  }

  describe("GET /api/v1/qr/branch", () => {
    it("returns the desk code and states that it authorises nothing", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const res = await request(api()).get("/api/v1/qr/branch").set(...as(staff.token));
      expect(res.status).toBe(200);
      expect(res.body.data.url).toBeTruthy();
      // A static image cannot be revoked, so it must never be a credential.
      expect(res.body.data.authorises).toBe(false);
    });
  });

  describe("POST /api/v1/qr/check-in", () => {
    it("checks in a booking inside its window", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass, bookingId } = await placeBooking({ startInMinutes: 20 });
      expect(pass).toMatch(/^BA1\./);

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("CHECKED_IN");

      const { rows } = await db().query(`select status from public.bookings where id = $1`, [bookingId]);
      expect(rows[0].status).toBe("CHECKED_IN");
    });

    it("records a checkins row and marks the token used", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass, bookingId } = await placeBooking({ startInMinutes: 25 });
      await request(api()).post("/api/v1/qr/check-in").set(...as(staff.token)).send({ pass });

      const { rows } = await db().query(
        `select c.id, q.used_at from public.checkins c
           join public.qr_tokens q on q.booking_id = c.booking_id
          where c.booking_id = $1`,
        [bookingId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].used_at).not.toBeNull();
    });

    it("refuses a pass scanned more than the window before the appointment", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      // Three hours out; the window is 60 minutes.
      const { pass } = await placeBooking({ startInMinutes: 180 });

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("QR_TOO_EARLY");
    });

    it("refuses a pass scanned after the appointment has ended", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass } = await placeBooking({ startInMinutes: -180, durationMinutes: 60 });

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("QR_TOO_LATE");
    });

    it("refuses a replayed pass", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass } = await placeBooking({ startInMinutes: 30 });

      const first = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });
      expect(first.status).toBe(200);

      const replay = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });

      expect(replay.status).toBe(409);
      expect(replay.body.error.code).toBe("ALREADY_CHECKED_IN");
    });

    it("refuses a revoked pass", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      // Revoked by cancelling the booking, which is what `cancel_booking` does
      // to the token row. The cancellation cannot go through the API here: the
      // appointment is 35 minutes out, well inside the two-hour window, so the
      // API would (correctly) refuse it and leave the token live.
      const { pass } = await placeBooking({ startInMinutes: 35, status: "CANCELLED" });

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("QR_INVALID");
    });

    it("refuses a forged pass", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const forged = `BA1.${Buffer.from(
        JSON.stringify({ jti: crypto.randomUUID(), bid: crypto.randomUUID(), exp: 9999999999 })
      ).toString("base64url")}.${Buffer.from("forged-signature").toString("base64url")}`;

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass: forged });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("QR_INVALID");
    });

    it("accepts a full check-in URL as well as a bare token", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass } = await placeBooking({ startInMinutes: 40 });
      const url = `https://beautyalley.app/check-in?pass=${encodeURIComponent(pass)}`;

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass: url });

      expect(res.status).toBe(200);
    });

    it("refuses a pass for a cancelled booking", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass } = await placeBooking({ startInMinutes: 45, status: "CANCELLED" });

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({ pass });

      expect(res.status).toBe(400);
      // Specifically the revocation, not a status-transition refusal: the
      // fixture cancels the booking the way `cancel_booking` does, so the
      // token is revoked before the check-in is ever considered.
      expect(res.body.error.code).toBe("QR_INVALID");
    });
  });

  describe("authorisation", () => {
    it("refuses check-in from an unauthenticated caller", async () => {
      const { pass } = await placeBooking({ startInMinutes: 50 });
      const res = await request(api()).post("/api/v1/qr/check-in").send({ pass });
      expect(res.status).toBe(401);
    });

    it("refuses check-in from a client, so nobody marks themselves arrived", async () => {
      const { pass } = await placeBooking({ startInMinutes: 55 });
      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set("Authorization", "Bearer not-a-real-token")
        .send({ pass });
      expect(res.status).toBe(401);
    });

    it("requires a pass in the body", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const res = await request(api())
        .post("/api/v1/qr/check-in")
        .set(...as(staff.token))
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("pass retrieval", () => {
    it("marks a pass as used once it has been redeemed", async () => {
      const staff = await createTestStaff(EMP_ANA);
      created.push(staff);

      const { pass, bookingId } = await placeBooking({ startInMinutes: 58 });
      await request(api()).post("/api/v1/qr/check-in").set(...as(staff.token)).send({ pass });

      const res = await request(api()).get(`/api/v1/bookings/${bookingId}/qr`);
      expect(res.status).toBe(200);
      expect(res.body.data.used).toBe(true);
      expect(res.body.data.pass).toBeNull();
    });
  });
});
