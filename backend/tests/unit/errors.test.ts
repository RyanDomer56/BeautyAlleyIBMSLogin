import { AppError, CODES, toAppError } from "../../src/lib/errors";

/**
 * The error translation layer is the boundary between Postgres and HTTP. If it
 * gets a mapping wrong, the consequence is either a 500 where a 409 belonged,
 * or - worse - a raw Postgres message leaking table and column names.
 */
describe("error translation", () => {
  it("maps an exclusion violation to 409 SLOT_TAKEN", () => {
    // 23P01 is what the btree_gist constraint raises on a double-booking.
    const err = Object.assign(new Error("conflicting key value violates exclusion constraint"), {
      code: "23P01",
    });
    const mapped = toAppError(err);
    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe(CODES.SLOT_TAKEN);
  });

  it("maps a function-raised code to its status", () => {
    const mapped = toAppError(new Error("OUTSIDE_WORKING_HOURS"));
    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe(CODES.OUTSIDE_WORKING_HOURS);
  });

  it("maps EMPLOYEE_NOT_QUALIFIED to 403, not 400", () => {
    // It is an authorisation-style refusal: the request is well-formed but
    // the chosen stylist cannot do the job.
    expect(toAppError(new Error("EMPLOYEE_NOT_QUALIFIED")).status).toBe(403);
  });

  it("maps every PROMO_* reason to 400 with the reason preserved as the code", () => {
    for (const reason of [
      "PROMO_NOT_FOUND",
      "PROMO_EXPIRED",
      "PROMO_LIMIT_REACHED",
      "PROMO_MIN_SPEND_NOT_MET",
      "PROMO_NOT_APPLICABLE",
    ]) {
      const mapped = toAppError(new Error(reason));
      expect(mapped.status).toBe(400);
      expect(mapped.code).toBe(reason);
    }
  });

  it("maps a QR revocation to 400 QR_INVALID", () => {
    expect(toAppError(new Error("QR_REVOKED")).code).toBe(CODES.QR_INVALID);
  });

  it("passes an AppError through untouched", () => {
    const original = AppError.notFound(CODES.BOOKING_NOT_FOUND, "No such booking");
    expect(toAppError(original)).toBe(original);
  });

  it("maps an unknown error to 500 and never echoes the raw message", () => {
    const mapped = toAppError(new Error('relation "public.secret_table" does not exist'));
    expect(mapped.status).toBe(500);
    expect(mapped.message).toBe("Something went wrong");
    expect(mapped.message).not.toContain("secret_table");
    // The original is retained for the log, but on `cause`, not on `message`.
    expect(mapped.cause).toContain("secret_table");
  });

  it("recognises Supabase Auth's invalid-credentials message", () => {
    const mapped = toAppError(new Error("Invalid login credentials"));
    expect(mapped.status).toBe(401);
    expect(mapped.code).toBe(CODES.INVALID_CREDENTIALS);
  });

  it("recognises an already-registered account as a conflict", () => {
    expect(toAppError(new Error("User already registered")).status).toBe(409);
  });

  it("treats an insufficient-privilege SQLSTATE as 403", () => {
    const err = Object.assign(new Error("permission denied for table bookings"), { code: "42501" });
    expect(toAppError(err).status).toBe(403);
  });
});
