import request from "supertest";
import { api } from "../helpers/api";

/**
 * The public surface.
 *
 * Everything here works with only the publishable key, which is the whole
 * point: a visitor who has not signed in can browse the catalogue, check
 * availability and preview a promo code. These are also the endpoints with the
 * widest exposure, so the input handling is tested adversarially.
 */
describe("public API", () => {
  const SVC_MASSAGE = "11111111-0000-0000-0000-000000000001";
  const SVC_HAIRCUT = "11111111-0000-0000-0000-000000000003";

  describe("GET /health", () => {
    it("reports status and the environment", async () => {
      const res = await request(api()).get("/health");
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty("status");
      expect(res.body.checks).toHaveProperty("timezone", "Asia/Manila");
    });
  });

  describe("GET /api/v1/services", () => {
    it("returns the seeded catalogue", async () => {
      const res = await request(api()).get("/api/v1/services");
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeGreaterThanOrEqual(4);
      const names = res.body.data.map((s: { name: string }) => s.name);
      expect(names).toContain("Signature Massage");
    });

    it("exposes prices in integer minor units, never a float", async () => {
      const res = await request(api()).get("/api/v1/services");
      for (const s of res.body.data) {
        expect(Number.isInteger(s.priceCents)).toBe(true);
        expect(Number.isInteger(s.durationMinutes)).toBe(true);
      }
    });

    it("filters by category", async () => {
      const res = await request(api()).get("/api/v1/services?category=SPA");
      expect(res.status).toBe(200);
      expect(res.body.data.every((s: { category: string }) => s.category === "SPA")).toBe(true);
    });

    it("rejects an unknown category with a 400 and a structured issue list", async () => {
      const res = await request(api()).get("/api/v1/services?category=BOGUS");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
      expect(res.body.error.details.issues[0].path).toBe("category");
    });

    it("caps `limit` rather than trusting it", async () => {
      const res = await request(api()).get("/api/v1/services?limit=999999");
      expect(res.status).toBe(400);
    });

    it("searches by name", async () => {
      const res = await request(api()).get("/api/v1/services/search?q=massage");
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("treats a LIKE wildcard as a literal, not a match-everything", async () => {
      const res = await request(api()).get("/api/v1/services/search?q=%25");
      expect(res.status).toBe(200);
      // `%` escaped means "a service whose name contains a percent sign" -
      // there are none, so this must be empty rather than the whole catalogue.
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe("GET /api/v1/services/:id", () => {
    it("returns one service", async () => {
      const res = await request(api()).get(`/api/v1/services/${SVC_MASSAGE}`);
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Signature Massage");
    });

    it("404s an unknown id", async () => {
      const res = await request(api()).get(
        "/api/v1/services/99999999-0000-0000-0000-000000000000"
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SERVICE_NOT_FOUND");
    });

    it("rejects a non-uuid id before it reaches the database", async () => {
      const res = await request(api()).get("/api/v1/services/not-a-uuid");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("GET /api/v1/employees", () => {
    it("lists active staff", async () => {
      const res = await request(api()).get("/api/v1/employees");
      expect(res.status).toBe(200);
      expect(res.body.data.map((e: { fullName: string }) => e.fullName)).toEqual(
        expect.arrayContaining(["Ana Reyes", "Bea Santos", "Cara Lim"])
      );
    });

    it("does not expose working hours on the public profile", async () => {
      const res = await request(api()).get(
        "/api/v1/employees/22222222-0000-0000-0000-000000000001"
      );
      expect(res.status).toBe(200);
      // Working hours are an internal scheduling detail with no anon policy.
      expect(res.body.data.workingHours).toBeUndefined();
      expect(Array.isArray(res.body.data.serviceIds)).toBe(true);
    });
  });

  describe("GET /api/v1/availability", () => {
    it("returns slots for a qualified stylist", async () => {
      // A Monday far enough out that nothing is booked.
      const res = await request(api()).get(
        `/api/v1/availability?serviceId=${SVC_MASSAGE}&date=2031-03-03&intervalMinutes=60`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.totalSlots).toBeGreaterThan(0);
      expect(res.body.data.employees[0].employeeId).toBe(
        "22222222-0000-0000-0000-000000000001"
      );
    });

    it("does not offer a stylist who is not qualified for the service", async () => {
      // Cara is the only stylist qualified for Cut & Style.
      const res = await request(api()).get(
        `/api/v1/availability?serviceId=${SVC_HAIRCUT}&date=2031-03-03&intervalMinutes=60`
      );
      expect(res.status).toBe(200);
      const ids = res.body.data.employees.map((e: { employeeId: string }) => e.employeeId);
      expect(ids).toEqual(["22222222-0000-0000-0000-000000000003"]);
    });

    it("offers nothing on a day the stylist does not work", async () => {
      // Sunday. The seed gives nobody Sunday hours.
      const res = await request(api()).get(
        `/api/v1/availability?serviceId=${SVC_MASSAGE}&date=2031-03-02&intervalMinutes=60`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.totalSlots).toBe(0);
    });

    it("returns no slots for an inactive or unknown service rather than erroring", async () => {
      const res = await request(api()).get(
        `/api/v1/availability?serviceId=99999999-0000-0000-0000-000000000000&date=2031-03-03`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.totalSlots).toBe(0);
    });

    it("requires serviceId and date", async () => {
      const res = await request(api()).get("/api/v1/availability?date=2031-03-03");
      expect(res.status).toBe(400);
    });

    it("rejects a malformed date", async () => {
      const res = await request(api()).get(
        `/api/v1/availability?serviceId=${SVC_MASSAGE}&date=03-03-2031`
      );
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/promos/validate", () => {
    it("accepts a valid code and reports the discount", async () => {
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "SAVE10", serviceIds: [SVC_MASSAGE], subtotalCents: 250000 });
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.discountCents).toBe(25000);
    });

    it("matches the code case-insensitively", async () => {
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "save10", serviceIds: [SVC_MASSAGE], subtotalCents: 250000 });
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(true);
    });

    it("answers 200 with valid:false for an unknown code, not a 4xx", async () => {
      // A wrong code is a normal answer to a question, not an exception the
      // client has to catch.
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "DOESNOTEXIST" });
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.reason).toBe("NOT_FOUND");
    });

    it("enforces the minimum spend", async () => {
      // FLAT500 requires 100000 minor units.
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .send({ code: "FLAT500", serviceIds: [SVC_HAIRCUT], subtotalCents: 50000 });
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.reason).toBe("MIN_SPEND_NOT_MET");
    });

    it("requires a code", async () => {
      const res = await request(api()).post("/api/v1/promos/validate").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("authentication gates", () => {
    it.each([
      ["GET", "/api/v1/bookings"],
      ["GET", "/api/v1/me/bookings"],
      ["GET", "/api/v1/qr/branch"],
      ["GET", "/api/v1/admin/dashboard?from=2031-01-01&to=2031-01-31"],
      ["GET", "/api/v1/admin/clients"],
      ["GET", "/api/v1/admin/audit-logs"],
    ])("returns 401 for %s %s without a token", async (method, path) => {
      const res = await request(api()).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("returns 401 for a malformed bearer token", async () => {
      const res = await request(api())
        .get("/api/v1/me/bookings")
        .set("Authorization", "Bearer not-a-real-jwt");
      expect(res.status).toBe(401);
    });

    it("returns 401 when the Authorization header has no scheme", async () => {
      const res = await request(api()).get("/api/v1/me/bookings").set("Authorization", "abc123");
      expect(res.status).toBe(401);
    });
  });

  describe("routing", () => {
    it("404s an unknown route with the standard error shape", async () => {
      const res = await request(api()).get("/api/v1/definitely-not-a-route");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("rejects a malformed JSON body with a 4xx, not a 500", async () => {
      const res = await request(api())
        .post("/api/v1/promos/validate")
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });
});
