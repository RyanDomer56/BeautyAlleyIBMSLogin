import { signQrPass, verifyQrPass, toCheckInUrl, __testing } from "../../src/lib/qr";

/**
 * The QR pass is the only thing standing between a guessed string and a
 * check-in, so these tests are adversarial rather than happy-path: they try to
 * forge, tamper, truncate and replay.
 */
describe("QR pass signing", () => {
  const payload = {
    jti: "9f1d3a2e-4b6c-4d8e-9f0a-1b2c3d4e5f60",
    bid: "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  it("round-trips a valid pass", () => {
    const pass = signQrPass(payload);
    const result = verifyQrPass(pass);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toEqual(payload);
  });

  it("produces a three-part, prefixed token", () => {
    const parts = signQrPass(payload).split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(__testing.PREFIX);
  });

  it("rejects a token signed with a different secret", () => {
    // Hand-forge a payload with a plausible-looking but wrong signature.
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const forged = `${__testing.PREFIX}.${body}.${Buffer.from("not-the-real-hmac").toString("base64url")}`;
    const result = verifyQrPass(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("BAD_SIGNATURE");
  });

  it("rejects a payload tampered with after signing", () => {
    const pass = signQrPass(payload);
    const [prefix, , sig] = pass.split(".");
    // Swap the booking id while keeping the original signature.
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, bid: "ffffffff-ffff-ffff-ffff-ffffffffffff" })
    ).toString("base64url");

    const result = verifyQrPass(`${prefix}.${tampered}.${sig}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("BAD_SIGNATURE");
  });

  it("rejects a token whose expiry has passed", () => {
    const expired = { ...payload, exp: Math.floor(Date.now() / 1000) - 60 };
    const result = verifyQrPass(signQrPass(expired));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("EXPIRED");
  });

  it.each([
    ["empty string", ""],
    ["no separators", "BA1abcdef"],
    ["too many parts", "BA1.a.b.c"],
    ["wrong prefix", "XX9.a.b"],
    ["empty body", "BA1..sig"],
    ["empty signature", "BA1.body."],
  ])("rejects malformed input: %s", (_label, input) => {
    const result = verifyQrPass(input);
    expect(result.ok).toBe(false);
  });

  it("rejects a well-signed payload with the wrong shape", () => {
    // Signed correctly, but missing `bid` - the signature cannot save a
    // payload the verifier does not understand.
    const pass = signQrPass({ jti: payload.jti, exp: payload.exp } as never);
    const result = verifyQrPass(pass);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MALFORMED");
  });

  it("tolerates surrounding whitespace, as a scanner may add it", () => {
    const result = verifyQrPass(`  ${signQrPass(payload)}  `);
    expect(result.ok).toBe(true);
  });

  it("builds a check-in URL that carries the pass as a query parameter", () => {
    const pass = signQrPass(payload);
    const url = toCheckInUrl(pass);
    expect(url).toContain("?pass=");
    expect(new URL(url).searchParams.get("pass")).toBe(pass);
  });
});
