import request from "supertest";
import { api, as, createTestAdmin, createTestClient, deleteTestUsers, type TestUser } from "../helpers/api";
import { connectDb, db, disconnectDb } from "../helpers/db";
import { ISO, SLOT_BANDS, nextWorkingSlot, useSlotBand } from "../helpers/time";

/**
 * Promo validation and redemption.
 *
 * The interesting cases are all about *counting*: a code with a global cap, a
 * code with a per-customer cap, and the rule that cancelling a booking gives
 * the redemption back. Getting that last one wrong means a cancelled booking
 * burns a redemption permanently, which is invisible until a customer
 * complains that a code "stopped working".
 */
const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
const describePromos = hasServiceRole ? describe : describe.skip;

// Claim this suite's day-offsets before any slot is computed, so it cannot
// collide with another suite's bookings. See tests/helpers/time.ts.
useSlotBand(SLOT_BANDS.promos);

describePromos("promos", () => {
  const SVC_MASSAGE = "11111111-0000-0000-0000-000000000001";
  const SVC_HAIRCUT = "11111111-0000-0000-0000-000000000003";
  const EMP_ANA = "22222222-0000-0000-0000-000000000001";
  const EMP_CARA = "22222222-0000-0000-0000-000000000003";

  const created: TestUser[] = [];

  beforeAll(async () => {
    await connectDb();
  });

  afterAll(async () => {
    await deleteTestUsers(created);
    await disconnectDb();
  });

  /**
   * `manilaHour` exists so two bookings that must both succeed can be placed on
   * the same day without fighting over one slot - the stylist's day is 09:00 to
   * 18:00, so there is room for several non-overlapping appointments.
   */
  async function redeem(promoCode: string, guestPhone: string, slotOffset = 4, manilaHour = 10) {
    return request(api())
      .post("/api/v1/bookings")
      .send({
        serviceIds: [SVC_MASSAGE],
        employeeId: EMP_ANA,
        startTime: ISO(nextWorkingSlot(slotOffset, manilaHour)),
        guest: { name: "Promo Guest", phone: guestPhone },
        promoCode,
      });
  }

  describe("validation", () => {
    it("applies a percentage discount to the subtotal", async () => {
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "SAVE10", serviceIds: [SVC_MASSAGE], subtotalCents: 250000 });
      expect(res.body.data.discountCents).toBe(25000);
    });

    it("applies a fixed discount", async () => {
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "FLAT500", serviceIds: [SVC_MASSAGE], subtotalCents: 250000 });
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.discountCents).toBe(50000);
    });

    it("never discounts more than the amount being discounted", async () => {
      // A fixed 500.00 discount against a 300.00 cart must clamp to 300.00,
      // never produce a negative total.
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "FLAT500", serviceIds: [SVC_MASSAGE], subtotalCents: 30000 });
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.reason).toBe("MIN_SPEND_NOT_MET");
    });
  });

  describe("application at booking time", () => {
    it("records the discount and the redemption on the booking", async () => {
      const res = await redeem("SAVE10", "+639180000001", 4);
      expect(res.status).toBe(201);
      expect(res.body.data.discountCents).toBe(25000);
      expect(res.body.data.totalCents).toBe(225000);

      const { rows } = await db().query(
        `select released_at from public.promo_redemptions where booking_id = $1`,
        [res.body.data.id]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].released_at).toBeNull();
    });

    it("refuses a code that does not exist", async () => {
      const res = await redeem("NOPE404", "+639180000002", 4);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PROMO_NOT_FOUND");
    });

    it("refuses a booking below the minimum spend", async () => {
      // FLAT500 needs 100000 minor units; a haircut is 120000 so it passes,
      // but a 95000 manicure would not.
      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: ["11111111-0000-0000-0000-000000000004"], // 95000
          employeeId: "22222222-0000-0000-0000-000000000002",
          startTime: ISO(nextWorkingSlot(4, 15)),
          guest: { name: "Too Cheap", phone: "+639180000003" },
          promoCode: "FLAT500",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PROMO_MIN_SPEND_NOT_MET");
    });

    it("refuses a code that does not apply to the selected services", async () => {
      // A promo restricted to massage, used against a haircut.
      const { rows } = await db().query(
        `insert into public.promo_codes
           (code, type, value, applicable_service_ids, is_active)
         values ($1, 'PERCENT', 20, array[$2::uuid], true)
         returning id`,
        [`MASSAGEONLY${Date.now()}`, SVC_MASSAGE]
      );
      const code = (await db().query(`select code from public.promo_codes where id = $1`, [rows[0].id]))
        .rows[0].code;

      const res = await request(api())
        .post("/api/v1/bookings")
        .send({
          serviceIds: [SVC_HAIRCUT],
          employeeId: EMP_CARA,
          startTime: ISO(nextWorkingSlot(4, 16)),
          guest: { name: "Wrong Service", phone: "+639180000004" },
          promoCode: code,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PROMO_NOT_APPLICABLE");
    });
  });

  describe("redemption limits", () => {
    it("enforces the per-customer limit", async () => {
      const phone = "+639180000010";
      const first = await redeem("SAVE10", phone, 5);
      expect(first.status).toBe(201);

      // SAVE10 has per_client_limit = 1.
      const second = await redeem("SAVE10", phone, 5);
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe("PROMO_LIMIT_REACHED");
    });

    it("counts the per-customer limit per phone, not globally", async () => {
      const first = await redeem("SAVE10", "+639180000011", 6, 10);
      expect(first.status).toBe(201);
      const other = await redeem("SAVE10", "+639180000012", 6, 11);
      expect(other.status).toBe(201);
    });

    it("enforces the global redemption cap", async () => {
      // FLAT500 has max_redemptions = 2.
      const a = await redeem("FLAT500", "+639180000020", 7, 10);
      expect(a.status).toBe(201);
      const b = await redeem("FLAT500", "+639180000021", 7, 11);
      expect(b.status).toBe(201);

      const c = await redeem("FLAT500", "+639180000022", 7, 12);
      expect(c.status).toBe(400);
      expect(c.body.error.code).toBe("PROMO_LIMIT_REACHED");
    });

    it("releases the redemption when the booking is cancelled, so the code works again", async () => {
      // A code of this test's own, with a cap of one, rather than the shared
      // FLAT500 fixture. Reusing a fixture whose whole capacity another test
      // has already spent would make this test pass or fail purely on
      // declaration order - and it would leave the suite unable to run twice
      // against the same database.
      const { rows: promoRows } = await db().query(
        `insert into public.promo_codes
           (code, type, value, min_spend_cents, max_redemptions, per_client_limit, is_active)
         values ($1, 'FIXED', 10000, 0, 1, null, true)
         returning id`,
        [`RELEASE${Date.now() % 100000}`]
      );
      const promoId = promoRows[0].id as string;
      const code = (
        await db().query(`select code from public.promo_codes where id = $1`, [promoId])
      ).rows[0].code as string;

      const booking = await redeem(code, "+639180000030", 8, 10);
      expect(booking.status).toBe(201);

      // With a cap of one, the code is now exhausted.
      const blocked = await redeem(code, "+639180000031", 8, 11);
      expect(blocked.status).toBe(400);
      expect(blocked.body.error.code).toBe("PROMO_LIMIT_REACHED");

      const { rows: before } = await db().query(
        `select count(*)::int as n from public.promo_redemptions
          where promo_code_id = $1 and released_at is null`,
        [promoId]
      );
      expect(before[0].n).toBe(1);

      await request(api())
        .post(`/api/v1/bookings/${booking.body.data.id}/cancel`)
        .send({ reason: "released" });

      const { rows: after } = await db().query(
        `select count(*)::int as n from public.promo_redemptions
          where promo_code_id = $1 and released_at is null`,
        [promoId]
      );
      expect(after[0].n).toBe(0);

      // And the audit trail survives: the row is released, not deleted.
      const { rows: released } = await db().query(
        `select released_at from public.promo_redemptions where booking_id = $1`,
        [booking.body.data.id]
      );
      expect(released).toHaveLength(1);
      expect(released[0].released_at).not.toBeNull();

      // The freed capacity is real: the code can be used again.
      const again = await redeem(code, "+639180000032", 8, 12);
      expect(again.status).toBe(201);
    });
  });

  describe("admin management", () => {
    it("lets an admin create and deactivate a code", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const created2 = await request(api())
        .post("/api/v1/promos")
        .set(...as(admin.token))
        .send({ code: `WELCOME${Date.now() % 100000}`, type: "PERCENT", value: 15, isActive: true });
      expect(created2.status).toBe(201);
      expect(created2.body.data.isActive).toBe(true);

      const off = await request(api())
        .delete(`/api/v1/promos/${created2.body.data.id}`)
        .set(...as(admin.token));
      expect(off.status).toBe(200);
      expect(off.body.data.isActive).toBe(false);

      // A deactivated code must no longer validate.
      const check = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: created2.body.data.code, serviceIds: [SVC_MASSAGE], subtotalCents: 250000 });
      expect(check.body.data.valid).toBe(false);
      expect(check.body.data.reason).toBe("INACTIVE");
    });

    it("rejects a percentage above 100", async () => {
      const admin = await createTestAdmin();
      created.push(admin);

      const res = await request(api())
        .post("/api/v1/promos")
        .set(...as(admin.token))
        .send({ code: `BAD${Date.now() % 100000}`, type: "PERCENT", value: 150 });
      expect(res.status).toBe(400);
    });

    it("refuses promo management from a client", async () => {
      const client = await createTestClient();
      created.push(client);

      const res = await request(api())
        .get("/api/v1/promos")
        .set(...as(client.token));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("INSUFFICIENT_ROLE");
    });
  });
});
