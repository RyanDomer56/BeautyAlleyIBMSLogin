#!/usr/bin/env node
/**
 * Measure the project's GoTrue rate limit.
 *
 * The integration suite creates a real auth user per fixture and signs it in,
 * because the API validates tokens by asking GoTrue (`auth.getUser`) rather
 * than by verifying the signature locally. That means every fixture costs two
 * requests to the hosted auth service, and the hosted service rate-limits.
 *
 * This script finds the budget empirically so the suite can be sized to fit
 * inside it instead of failing with "Request rate limit reached".
 *
 *   node scripts/probe-ratelimit.js [n]
 */

require("./_load-env");
const { createClient } = require("@supabase/supabase-js");

const attempts = Number(process.argv[2] ?? 60);
const email = () => `probe.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@beautyalley.ph`;
const PASSWORD = "TestPass123!";

async function main() {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let created = 0;
  let signedIn = 0;

  for (let i = 0; i < attempts; i++) {
    const e = email();
    const c = await admin.auth.admin.createUser({
      email: e,
      password: PASSWORD,
      email_confirm: true,
      app_metadata: { role: "CLIENT" },
      user_metadata: { full_name: "Probe" },
    });
    if (c.error) {
      console.log(`createUser #${i} refused: ${c.error.status} ${c.error.code} - ${c.error.message}`);
      break;
    }
    created++;

    const s = await admin.auth.signInWithPassword({ email: e, password: PASSWORD });
    if (s.error) {
      console.log(`signIn #${i} refused: ${s.error.status} ${s.error.code} - ${s.error.message}`);
      break;
    }
    signedIn++;

    await admin.auth.admin.deleteUser(c.data.user.id);
  }

  console.log(`\ncreateUser succeeded ${created}x, signInWithPassword succeeded ${signedIn}x`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
