import { env, envError, assertEnv } from "../../src/config/env";

/**
 * A broken environment must be *recorded*, not thrown at import time.
 *
 * The Vercel entry wraps `createApp()` in a try/catch so a misconfigured
 * deployment answers with a JSON 500 that names the missing variable instead of
 * Vercel's opaque FUNCTION_INVOCATION_FAILED. That contract only holds if
 * importing `config/env.ts` is itself harmless: a bundler may hoist its
 * top-level code into the bundle prologue, outside that try/catch, and then the
 * throw becomes the very crash the catch exists to prevent.
 *
 * This is asserted because the failure is invisible in normal use - with a
 * filled-in `.env.local` the module parses cleanly and the branch never runs.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

function loadWith(patch: Record<string, string>): typeof import("../../src/config/env") {
  Object.assign(process.env, patch);
  let mod!: typeof import("../../src/config/env");
  expect(() => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require("../../src/config/env");
    });
  }).not.toThrow();
  return mod;
}

describe("config/env", () => {
  it("parses the real environment", () => {
    expect(envError).toBeNull();
    expect(() => assertEnv()).not.toThrow();
    expect(env.supabaseUrl).toMatch(/^https?:\/\//);
  });

  it("records a malformed value instead of throwing at import", () => {
    const mod = loadWith({ SUPABASE_URL: "not-a-url" });

    expect(mod.envError).toBeInstanceOf(Error);
    expect(mod.envError?.message).toContain("SUPABASE_URL");
    expect(() => mod.assertEnv()).toThrow(/SUPABASE_URL/);
  });

  it("records a missing key instead of throwing at import", () => {
    // dotenv does not overwrite keys that already exist, so an empty value
    // stays empty and fails `min(32)` rather than being refilled from .env.
    const mod = loadWith({ QR_SIGNING_SECRET: "" });

    expect(mod.envError?.message).toContain("QR_SIGNING_SECRET");
  });

  it("refuses a production boot with no origin allow-list", () => {
    const mod = loadWith({ NODE_ENV: "production", ALLOWED_ORIGINS: "" });

    expect(mod.envError?.message).toContain("ALLOWED_ORIGINS");
    expect(() => mod.assertEnv()).toThrow(/ALLOWED_ORIGINS/);
  });

  it("accepts a production boot that names its origins", () => {
    const mod = loadWith({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://beautyalleyibms.vercel.app",
    });

    expect(mod.envError).toBeNull();
    expect(mod.env.allowedOrigins).toEqual(["https://beautyalleyibms.vercel.app"]);
  });
});
