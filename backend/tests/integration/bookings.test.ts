import request from "supertest";
import { api, as, createTestAdmin, createTestClient, createTestConcierge, deleteTestUsers, type TestUser } from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";
import { ISO, SLOT_BANDS, nextWorkingSlot, shiftHours, useSlotBand } from "../helpers/time";

/**
 * The booking lifecycle, end to end through HTTP.
 *
 * Requires the service-role key: creating a booking is a write, and writes go
 * through the service role by design (DESIGN.md §3).
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describeBookings = hasServiceRole ? describe : describe.skip;

// Claim this suite's day-offsets before any slot is computed, so it cannot
// collide with another suite's bookings. See tests/helpers/time.ts.
useSlotBand(SLOT_BANDS.bookings);

describeBookings("bookings", () => {
  const SVC_MASSAGE = "11111111-0000-0000-0000-000000000001";
  const SVC_FACIAL = "11111111-0000-0000-0000-000000000002";
  const SVC_HAIRCUT = "11111111-0000-0000-0000-000000000003";
  const EMP_ANA = "22222222-0000-0000-0000-000000000001";
  const EMP_BEA = "22222222-0000-0000-0000-000000000002";
  const EMP_CARA = "22222222-0000-0000-0000-000000000003";

  const created: TestUser[] = [];

  /**
   * Bookings inserted with raw SQL rather than through the API.
   *
   * Two of them - the cancellation-window case and the force-past-the-window
   * case - both have to sit about half an hour from now for the window rule to
   * be the thing under test, which puts them in the same slot for the same
   * stylist. Left in place, the second one dies on the EXCLUDE constraint with
   * a 23P01 that says nothing about cancellation. They are removed after each
   * test instead.
   */
  const rawBookings: string[] = [];

  beforeAll(async () => {
    await connectDb();
  });

  afterEach(async () => {
    if (rawBookings.length === 0) return;
    // booking_items, qr_tokens, checkins and promo_redemptions all cascade.
    await db().query(`delete from public.bookings where id = any($1::uuid[])`, [rawBookings]);
    rawBookings.length = 0;
  });

  afterAll(async () => {
    await deleteTestUsers(created);
    await disconnectDb();
  });

  describe("POST /api/v1/bookings", () => {
    it("creates a guest booking and returns a signed pass", async () => {
      const slot = nextWorkingSlot(4, 10);
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Guest One", phone: "+639170000001" },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.reference).toMatch(/^BA-\d{8}-\d{4}$/);
      // A self-service booking starts PENDING: nobody has confirmed it yet.
      expect(res.body.data.status).toBe("PENDING");
      expect(res.body.data.totalCents).toBe(250000);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.qr.pass).toMatch(/^BA1\./);
      expect(res.body.data.qr.url).toContain("?pass=");
    });

    it("computes end_time from the sum of service durations", async () => {
      const slot = nextWorkingSlot(4, 13);
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_FACIAL, SVC_MASSAGE], // 45 + 60 = 105 minutes
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Guest Two", phone: "+639170000002" },
        });

      expect(res.status).toBe(201);
      const start = new Date(res.body.data.startTime).getTime();
      const end = new Date(res.body.data.endTime).getTime();
      expect((end - start) / 60_000).toBe(105);
      expect(res.body.data.totalCents).toBe(180000 + 250000);
    });

    it("writes a price snapshot so a later reprice cannot change the total", async () => {
      const slot = nextWorkingSlot(5, 10);
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_HAIRCUT],
          employeeId: EMP_CARA,
          startTime: ISO(slot),
          guest: { name: "Guest Snapshot", phone: "+639170000003" },
        });
      expect(res.status).toBe(201);
      const bookingId = res.body.data.id;

      // Reprice the service underneath the booking.
      await db().query(`update public.services set price_cents = 999999 where id = $1`, [SVC_HAIRCUT]);
      try {
        const after = await request(api()).get(`/api/v1/bookings/${bookingId}`);
        expect(after.status).toBe(200);
        // The booking must still total what it did when it was made.
        expect(after.body.data.totalCents).toBe(120000);
        expect(after.body.data.items[0].priceCents).toBe(120000);
      } finally {
        await db().query(`update public.services set price_cents = 120000 where id = $1`, [SVC_HAIRCUT]);
      }
    });

    it("rejects an empty service list", async () => {
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({ serviceIds: [], startTime: ISO(nextWorkingSlot(4)), guest: { name: "X", phone: "+639170000009" } });
      expect(res.status).toBe(400);
    });

    it("rejects a booking with neither a client nor guest details", async () => {
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({ serviceIds: [SVC_MASSAGE], employeeId: EMP_ANA, startTime: ISO(nextWorkingSlot(4)) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CLIENT_REQUIRED");
    });

    it("rejects a start time in the past", async () => {
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: "2020-01-01T01:00:00Z",
          guest: { name: "Time Traveller", phone: "+639170000004" },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("START_TIME_IN_PAST");
    });

    it("rejects an unknown service id", async () => {
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: ["99999999-0000-0000-0000-000000000000"],
          employeeId: EMP_ANA,
          startTime: ISO(nextWorkingSlot(4)),
          guest: { name: "Ghost", phone: "+639170000005" },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("SERVICES_INVALID");
    });

    it("refuses a stylist who is not qualified for the service", async () => {
      // Cara does hair only.
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_CARA,
          startTime: ISO(nextWorkingSlot(4, 11)),
          guest: { name: "Wrong Stylist", phone: "+639170000006" },
        });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("EMPLOYEE_NOT_QUALIFIED");
    });

    it("refuses a time outside the stylist's working hours", async () => {
      // 23:00 Manila - the availability grid would never offer it, so the API
      // must not accept it either.
      const slot = nextWorkingSlot(4, 23);
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Night Owl", phone: "+639170000007" },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OUTSIDE_WORKING_HOURS");
    });

    it("refuses an appointment that would run past the end of the shift", async () => {
      // 17:30 + 60 minutes runs to 18:30, past the 18:00 close.
      const slot = nextWorkingSlot(4, 17);
      const shifted = new Date(slot.getTime() + 30 * 60_000);
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(shifted),
          guest: { name: "Late Finish", phone: "+639170000008" },
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OUTSIDE_WORKING_HOURS");
    });

    it("auto-assigns a qualified stylist when none is requested", async () => {
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_HAIRCUT],
          startTime: ISO(nextWorkingSlot(6, 10)),
          guest: { name: "Auto Assign", phone: "+639170000010" },
        });
      expect(res.status).toBe(201);
      // Only Cara does hair, so the choice is forced.
      expect(res.body.data.employee.id).toBe(EMP_CARA);
    });
  });

  /**
   * The desk's override.
   *
   * A self-service booking now arrives with a stylist already on it, chosen by
   * `create_booking` at random from the people who are qualified, rostered and
   * free. This is how the desk disagrees - and the rules have to hold here
   * too, or the override becomes a way around qualification and availability.
   */
  describe("PATCH /api/v1/bookings/:id/employee", () => {
    /** Facial, because both Ana and Bea are qualified for it. */
    async function facialFor(day: number, hour: number, guest: string) {
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_FACIAL],
          employeeId: EMP_ANA,
          startTime: ISO(nextWorkingSlot(day, hour)),
          guest: { name: guest, phone: "+639170000011" },
        });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    }

    it("moves a booking to another qualified stylist", async () => {
      const desk = await createTestConcierge("Desk Assigner");
      created.push(desk);

      const id = await facialFor(20, 11, "Reassign Me");

      const res = await request(api())
        .patch(`/api/v1/bookings/${id}/employee`)
        .set(...as(desk.token))
        .send({ employeeId: EMP_BEA });

      expect(res.status).toBe(200);
      expect(res.body.data.employee.id).toBe(EMP_BEA);
    });

    it("refuses a stylist who is not qualified for the treatment", async () => {
      const desk = await createTestConcierge("Desk Assigner");
      created.push(desk);

      const id = await facialFor(21, 11, "Wrong Stylist Again");

      // Cara does hair only.
      const res = await request(api())
        .patch(`/api/v1/bookings/${id}/employee`)
        .set(...as(desk.token))
        .send({ employeeId: EMP_CARA });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("EMPLOYEE_NOT_QUALIFIED");
    });

    it("is closed to a client", async () => {
      const client = await createTestClient("Not The Desk");
      created.push(client);

      const id = await facialFor(22, 11, "Client Picker");

      const res = await request(api())
        .patch(`/api/v1/bookings/${id}/employee`)
        .set(...as(client.token))
        .send({ employeeId: EMP_BEA });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });
  });

  describe("double-booking", () => {
    it("rejects an overlapping booking for the same stylist with 409 SLOT_TAKEN", async () => {
      const slot = nextWorkingSlot(7, 10);

      const first = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "First", phone: "+639170000011" },
        });
      expect(first.status).toBe(201);

      // 30 minutes later, overlapping the 60-minute booking above.
      const overlapping = shiftHours(slot, 0.5);
      const second = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(overlapping),
          guest: { name: "Second", phone: "+639170000012" },
        });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("SLOT_TAKEN");
    });

    it("allows a back-to-back booking at the exact boundary", async () => {
      const slot = nextWorkingSlot(8, 10);

      const first = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE], // 60 minutes
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Back A", phone: "+639170000013" },
        });
      expect(first.status).toBe(201);

      // Starts exactly when the previous one ends.
      const second = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(shiftHours(slot, 1)),
          guest: { name: "Back B", phone: "+639170000014" },
        });
      expect(second.status).toBe(201);
    });

    it("lets a different stylist take the same time slot", async () => {
      const slot = nextWorkingSlot(9, 10);

      const ana = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_FACIAL],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Ana Booking", phone: "+639170000015" },
        });
      expect(ana.status).toBe(201);

      const bea = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_FACIAL],
          employeeId: EMP_BEA,
          startTime: ISO(slot),
          guest: { name: "Bea Booking", phone: "+639170000016" },
        });
      expect(bea.status).toBe(201);
    });

    it("does not offer a taken slot in availability", async () => {
      const slot = nextWorkingSlot(10, 10);
      await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Blocker", phone: "+639170000017" },
        });

      const day = ISO(slot).slice(0, 10);
      const avail = await request(api()).get(
        `/api/v1/availability?serviceId=${SVC_MASSAGE}&date=${day}&employeeId=${EMP_ANA}&intervalMinutes=60`
      );
      expect(avail.status).toBe(200);
      const starts = avail.body.data.employees[0]?.slots.map((s: { start: string }) => s.start) ?? [];
      expect(starts).not.toContain(ISO(slot));
    });
  });

  describe("cancellation", () => {
    it("cancels a booking and revokes its pass", async () => {
      const slot = nextWorkingSlot(11, 10);
      const created = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Canceller", phone: "+639170000018" },
        });
      const bookingId = created.body.data.id;

      const cancelled = await request(api())
        .post(`/api/v1/bookings/${bookingId}/cancel`)
        .send({ reason: "changed my mind" });

      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.booking.status).toBe("CANCELLED");

      // The QR pass must be dead.
      const qr = await request(api()).get(`/api/v1/bookings/${bookingId}/qr`);
      expect(qr.status).toBe(400);
      expect(qr.body.error.code).toBe("QR_INVALID");
    });

    it("frees the slot for someone else immediately", async () => {
      const slot = nextWorkingSlot(12, 10);
      const first = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Frees", phone: "+639170000019" },
        });
      await request(api()).post(`/api/v1/bookings/${first.body.data.id}/cancel`).send({});

      const replacement = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Takes Over", phone: "+639170000020" },
        });
      expect(replacement.status).toBe(201);
    });

    it("refuses to cancel twice", async () => {
      const slot = nextWorkingSlot(13, 10);
      const created = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Double Cancel", phone: "+639170000021" },
        });

      await request(api()).post(`/api/v1/bookings/${created.body.data.id}/cancel`).send({});
      const again = await request(api())
        .post(`/api/v1/bookings/${created.body.data.id}/cancel`)
        .send({});

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ALREADY_CANCELLED");
    });

    it("enforces the cancellation window for a non-forced cancellation", async () => {
      // Placed directly, 30 minutes out, so it sits inside the 2-hour window.
      // Created via SQL because the API would (correctly) refuse to book at a
      // time outside working hours.
      //
      // Bea, not Ana: this slot cannot be banded (the whole point is that it is
      // nearly now), so it is the one place two suites can genuinely race. The
      // QR suite places its own near-now bookings for Ana, and the two would
      // collide on the exclusion constraint whenever the workers interleave.
      const emp = EMP_BEA;
      const start = new Date(Date.now() + 30 * 60_000);
      const end = new Date(start.getTime() + 60 * 60_000);
      const { rows } = await db().query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values ($1, 'Window Test', '+639170000022', $2, $3, $4, 'CONFIRMED', 0, 0, 0)
         returning id`,
        [`BA-WINDOW-${Date.now()}`, emp, start.toISOString(), end.toISOString()]
      );
      const bookingId = rows[0].id;
      rawBookings.push(bookingId);

      const res = await request(api())
        .post(`/api/v1/bookings/${bookingId}/cancel`)
        .send({ reason: "too late", force: false });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CANCELLATION_WINDOW_PASSED");
    });

    it("lets an admin force past the window", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      // Same near-now slot, same stylist as the test above - safe because the
      // previous one is deleted in `afterEach` and nothing outside this file
      // books Bea at a time this close to now.
      const start = new Date(Date.now() + 30 * 60_000);
      const end = new Date(start.getTime() + 60 * 60_000);
      const { rows } = await db().query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values ($1, 'Force Test', '+639170000023', $2, $3, $4, 'CONFIRMED', 0, 0, 0)
         returning id`,
        [`BA-FORCE-${Date.now()}`, EMP_BEA, start.toISOString(), end.toISOString()]
      );
      rawBookings.push(rows[0].id);

      const res = await request(api())
        .post(`/api/v1/bookings/${rows[0].id}/cancel`)
        .set(...as(admin.token))
        .send({ reason: "staff override", force: true });

      expect(res.status).toBe(200);
      expect(res.body.data.booking.status).toBe("CANCELLED");
    });
  });

  describe("rescheduling", () => {
    it("moves a booking and issues a fresh pass", async () => {
      const slot = nextWorkingSlot(14, 10);
      const created = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Rescheduler", phone: "+639170000024" },
        });
      const originalPass = created.body.data.qr.pass;

      const moved = await request(api())
        .post(`/api/v1/bookings/${created.body.data.id}/reschedule`)
        .send({ startTime: ISO(shiftHours(slot, 2)) });

      expect(moved.status).toBe(200);
      expect(moved.body.data.startTime).toBe(ISO(shiftHours(slot, 2)));
      // A new pass, so the old one cannot be replayed.
      expect(moved.body.data.qr.pass).not.toBe(originalPass);
    });

    it("refuses a reschedule into a taken slot", async () => {
      const a = nextWorkingSlot(15, 10);
      const b = nextWorkingSlot(15, 14);

      const first = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(a),
          guest: { name: "Occupant", phone: "+639170000025" },
        });
      const second = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(b),
          guest: { name: "Mover", phone: "+639170000026" },
        });

      const res = await request(api())
        .post(`/api/v1/bookings/${second.body.data.id}/reschedule`)
        .send({ startTime: ISO(shiftHours(a, 0.5)) });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("SLOT_TAKEN");
    });
  });

  describe("status transitions", () => {
    it("refuses to move a COMPLETED booking back to PENDING", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const start = new Date(Date.now() - 48 * 3_600_000);
      const end = new Date(start.getTime() + 3_600_000);
      const { rows } = await db().query(
        `insert into public.bookings
           (reference, guest_name, guest_phone, employee_id, start_time, end_time, status,
            subtotal_cents, discount_cents, total_cents)
         values ($1, 'Done', '+639170000027', $2, $3, $4, 'COMPLETED', 0, 0, 0)
         returning id`,
        [`BA-DONE-${Date.now()}`, EMP_ANA, start.toISOString(), end.toISOString()]
      );
      rawBookings.push(rows[0].id);

      const res = await request(api())
        .patch(`/api/v1/bookings/${rows[0].id}/status`)
        .set(...as(admin.token))
        .send({ status: "PENDING" });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_STATUS_TRANSITION");
    });

    it("refuses a status change from a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .patch(`/api/v1/bookings/${EMP_ANA}/status`)
        .set(...as(client.token))
        .send({ status: "COMPLETED" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });
  });

  describe("ownership", () => {
    it("shows a client their own bookings only", async () => {
      const client = await createTestClient("Owner Test");
      created.push(client);

      const slot = nextWorkingSlot(16, 10);
      await request(api())
        .post("/api/v1/bookings")
        .set(...as(client.token))
        .send({ serviceIds: [SVC_MASSAGE], employeeId: EMP_ANA, startTime: ISO(slot) });

      const mine = await request(api()).get("/api/v1/me/bookings").set(...as(client.token));
      expect(mine.status).toBe(200);
      expect(mine.body.meta.total).toBeGreaterThanOrEqual(1);
      expect(mine.body.data.every((b: { client: { id: string } }) => b.client.id === client.clientId)).toBe(
        true
      );
    });

    it("404s another client's booking rather than 403, to avoid confirming it exists", async () => {
      const owner = await createTestClient("Real Owner");
      const stranger = await createTestClient("Stranger");
      created.push(owner, stranger);

      const slot = nextWorkingSlot(17, 10);
      const booking = await request(api())
        .post("/api/v1/bookings")
        .set(...as(owner.token))
        .send({ serviceIds: [SVC_MASSAGE], employeeId: EMP_ANA, startTime: ISO(slot) });

      const res = await request(api())
        .get(`/api/v1/bookings/${booking.body.data.id}`)
        .set(...as(stranger.token));

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("BOOKING_NOT_FOUND");
    });

    it("ignores a clientId supplied by an anonymous caller", async () => {
      // A guest must not be able to attach a booking to someone's account.
      const victim = await createTestClient("Victim");
      created.push(victim);

      const slot = nextWorkingSlot(18, 10);
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_MASSAGE],
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          clientId: victim.clientId,
        });

      // With no guest details and an untrusted clientId, this must be refused
      // rather than silently booked against the victim.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("CLIENT_REQUIRED");
    });
  });

  describe("list payload", () => {
    /*
     * The list endpoints used to omit `items` entirely, so every row came back
     * with `items: []`. The console then showed "—" where the treatment goes
     * and the run sheet summed the durations to "0 min" for every booking on
     * it. A booking row that cannot say what it is for is not a record.
     *
     * Asserted against the detail endpoint rather than against service names,
     * so the test survives a catalogue edit.
     */
    it("carries the items on a list row, matching what the detail returns", async () => {
      const admin = await createTestAdmin("List Payload Admin");
      created.push(admin);

      const slot = nextWorkingSlot(19, 10);
      const made = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_FACIAL, SVC_MASSAGE], // 45 + 60 = 105 minutes
          employeeId: EMP_ANA,
          startTime: ISO(slot),
          guest: { name: "Guest List", phone: "+639170000019" },
        });
      expect(made.status).toBe(201);
      const id = made.body.data.id;

      const detail = await request(api()).get(`/api/v1/bookings/${id}`);
      expect(detail.status).toBe(200);

      const list = await request(api())
        .get("/api/v1/bookings?limit=100&sort=start_time&order=asc")
        .set(...as(admin.token));
      expect(list.status).toBe(200);

      const row = list.body.data.find((b: { id: string }) => b.id === id);
      expect(row).toBeDefined();
      expect(row.items).toHaveLength(2);
      expect(row.items).toEqual(detail.body.data.items);

      const minutes = row.items.reduce(
        (n: number, i: { durationMinutes: number }) => n + i.durationMinutes,
        0
      );
      expect(minutes).toBe(105);

      // The batch load must not cross-contaminate: every item row belongs to
      // exactly one booking, so no id may appear twice across the page.
      const itemIds = list.body.data.flatMap((b: { items: { id: string }[] }) =>
        b.items.map((i) => i.id)
      );
      expect(new Set(itemIds).size).toBe(itemIds.length);
    });
  });
});
