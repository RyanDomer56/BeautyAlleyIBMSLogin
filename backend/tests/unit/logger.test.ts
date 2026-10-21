import { __testing } from "../../src/lib/logger";

/**
 * The logger is the one place a service-role key could escape into a log
 * aggregator. These tests exist because that failure is silent and permanent:
 * by the time you notice, the secret is in a search index.
 */
describe("log redaction", () => {
  const { sanitise, maskString } = __testing;

  it("redacts a publishable key embedded in a string", () => {
    const out = maskString("apikey=sb_publishable_EXAMPLE000000000000000000000000");
    expect(out).not.toContain("sb_publishable_");
    expect(out).toContain("[redacted]");
  });

  it("redacts a secret key", () => {
    expect(maskString("sb_secret_abc123DEF456ghi789")).toBe("[redacted]");
  });

  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLWhlcmU";
    expect(maskString(`token ${jwt}`)).not.toContain("eyJhbGciOiJIUzI1NiIs");
  });

  it("redacts a Postgres connection string, password and all", () => {
    const out = maskString("postgresql://postgres:EXAMPLEpassword123@db.example.co:5432/postgres");
    expect(out).not.toContain("EXAMPLEpassword123");
  });

  it("redacts values under a sensitive key, whatever they contain", () => {
    const out = sanitise({ authorization: "Bearer abc", apikey: "xyz", password: "hunter2" }) as Record<
      string,
      unknown
    >;
    expect(out.authorization).toBe("[redacted]");
    expect(out.apikey).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
  });

  it("redacts nested secrets, not just top-level ones", () => {
    const out = sanitise({ req: { headers: { cookie: "session=abc" } } }) as never as {
      req: { headers: { cookie: string } };
    };
    expect(out.req.headers.cookie).toBe("[redacted]");
  });

  it("keeps ordinary fields intact", () => {
    const out = sanitise({ method: "POST", status: 201, ok: true }) as Record<string, unknown>;
    expect(out).toEqual({ method: "POST", status: 201, ok: true });
  });

  it("stops recursing rather than blowing the stack on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => sanitise(cyclic)).not.toThrow();
  });
});
