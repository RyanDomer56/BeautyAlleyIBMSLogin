#!/usr/bin/env node
/**
 * Deterministic seed data.
 *
 * Wipes the transactional tables and inserts a fixed dataset: the full
 * fourteen-service catalogue, three stylists with qualifications and weekly
 * hours, two promo codes and two registered clients.
 *
 * ## Why the whole catalogue lives here, not just the four salon services
 *
 * This script TRUNCATES `public.services` and rebuilds it. For a long time it
 * rebuilt only the four original salon services, which meant that every
 * `npm test` silently deleted the ten wellness services (IV drips, beauty
 * shots, add-ons) that migrations 22 and 23 had put there. The tests passed and
 * the catalogue quietly shrank, and the loss only surfaced when the public
 * menu was opened by hand.
 *
 * A seed that rebuilds a table has to rebuild *all* of it. So the catalogue is
 * defined once, below, with fixed uuids, and migration 28 inserts the same ten
 * wellness rows into databases this script never touches (production, and any
 * environment where the tests do not run).
 *
 * Idempotent by construction - it truncates first - so running it twice gives
 * the same database. That matters because the test suite asserts against these
 * exact rows, and "it passed on my machine" is usually just leftover state.
 *
 *   node scripts/seed.js          # seed
 *   node scripts/seed.js --quiet  # seed, no output (used by the tests)
 */

require("./_load-env");
const path = require("path");
const { Client } = require("pg");

/**
 * Where DATABASE_URL actually points, for error messages. Never includes the
 * password - `URL.host` is host and port only.
 */
function databaseHost(env = process.env) {
  try {
    return new URL(env.DATABASE_URL).host || "(no host)";
  } catch {
    return "(DATABASE_URL missing or unparseable)";
  }
}

/**
 * Destructive-operation guard.
 *
 * `seed()` TRUNCATEs seventeen tables. That is correct for a disposable
 * database and catastrophic for a real one, so the caller has to declare which
 * it is. Three ways to declare it, in decreasing order of convenience:
 *
 *   ALLOW_DESTRUCTIVE_SEED=1   backend/.env.local - a per-machine statement
 *                              that this database is safe to wipe
 *   --force                    one-off, visible in the command line
 *   { confirmed: true }        programmatic callers (Jest globalSetup)
 *
 * `NODE_ENV=production` is refused outright: no flag makes truncating
 * production correct, and the person who runs `npm test` with a production
 * DATABASE_URL is exactly who this protects.
 */
function assertDestructiveAllowed({
  confirmed = false,
  argv = process.argv,
  env = process.env,
} = {}) {
  const host = databaseHost(env);

  if (env.NODE_ENV === "production") {
    throw new Error(
      `seed.js TRUNCATEs 17 tables and refuses to run with NODE_ENV=production.\n` +
        `Target: ${host}\n` +
        `Restore a backup, or point DATABASE_URL at a disposable database.`
    );
  }

  if (confirmed || argv.includes("--force")) return;

  if (env.ALLOW_DESTRUCTIVE_SEED === "1") return;

  throw new Error(
    `seed.js TRUNCATEs 17 tables in the database at ${host}.\n\n` +
      `If that database is disposable, either:\n` +
      `  - set ALLOW_DESTRUCTIVE_SEED=1 in backend/.env.local, or\n` +
      `  - re-run with --force (e.g. npm run db:seed -- --force).\n\n` +
      `If it is not disposable, stop here - this script has no undo.`
  );
}

const c = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/** Fixed uuids so tests can reference them without a lookup. */
const IDS = {
  svcMassage: "11111111-0000-0000-0000-000000000001",
  svcFacial: "11111111-0000-0000-0000-000000000002",
  svcHaircut: "11111111-0000-0000-0000-000000000003",
  svcManiPedi: "11111111-0000-0000-0000-000000000004",

  // Wellness catalogue - the ten services from the business's own price list.
  // The suffix mirrors the subcategory so the mapping is readable at a glance.
  svcGlassSkin: "11111111-0000-0000-0000-000000000011",
  svcYouthful: "11111111-0000-0000-0000-000000000012",
  svcLuminous: "11111111-0000-0000-0000-000000000013",
  svcImmune: "11111111-0000-0000-0000-000000000014",
  svcShotAntiAging: "11111111-0000-0000-0000-000000000015",
  svcShotRejuvenating: "11111111-0000-0000-0000-000000000016",
  svcAddonPlacenta: "11111111-0000-0000-0000-000000000017",
  svcAddonCollagen: "11111111-0000-0000-0000-000000000018",
  svcAddonVitaminC: "11111111-0000-0000-0000-000000000019",
  svcAddonMultivitamins: "11111111-0000-0000-0000-000000000020",

  empAna: "22222222-0000-0000-0000-000000000001",
  empBea: "22222222-0000-0000-0000-000000000002",
  empCara: "22222222-0000-0000-0000-000000000003",

  clientAda: "33333333-0000-0000-0000-000000000001",
  clientBen: "33333333-0000-0000-0000-000000000002",

  promoPercent: "44444444-0000-0000-0000-000000000001",
  promoFixed: "44444444-0000-0000-0000-000000000002",
};

/**
 * The second catalogue level. Migration 22 owns these in production; they are
 * re-stated here (idempotently, matched on the unique slug) so a database that
 * this script has just cleared is still self-sufficient.
 */
const SUBCATEGORIES = [
  { category: "WELLNESS", name: "IV Drips", slug: "iv-drips", sortOrder: 10 },
  { category: "WELLNESS", name: "Beauty Shots", slug: "beauty-shots", sortOrder: 20 },
  { category: "WELLNESS", name: "Add-ons", slug: "add-ons", sortOrder: 30 },
];

/**
 * The whole menu. Prices are the business's own and are never invented here.
 *
 * `durationMinutes` for the wellness rows is a PLACEHOLDER (60/30/15) pending
 * confirmation - the brief supplied prices but not durations, and the column is
 * NOT NULL, so something has to be written. Each description says so, so the
 * number is never mistaken for a confirmed figure. The four salon rows keep the
 * prices already in the database.
 *
 * `requiredRoomType` is OTHER for the drips (they need a private treatment
 * room) and null for shots and add-ons, which are quick in-chair procedures.
 *
 * `loyaltyEligible` is false for every wellness row: the brief is explicit that
 * wellness treatments must not count toward haircut loyalty.
 */
const SERVICES = [
  // --- haircut and salon services ----------------------------------------
  // `requiredRoomType` stays null for all four, exactly as it was before this
  // list moved into the seed. Setting it would make every existing booking
  // test start demanding a room of a type the demo floor does not have.
  {
    id: IDS.svcMassage,
    name: "Signature Massage",
    category: "SPA",
    description: "Deep tissue, 60 minutes.",
    priceCents: 250000,
    durationMinutes: 60,
    requiredRoomType: null,
  },
  {
    id: IDS.svcFacial,
    name: "Radiance Facial",
    category: "SALON",
    description: "Brightening treatment.",
    priceCents: 180000,
    durationMinutes: 45,
    requiredRoomType: null,
  },
  {
    id: IDS.svcHaircut,
    name: "Cut & Style",
    category: "SALON",
    description: "Consultation, cut and finish.",
    priceCents: 120000,
    durationMinutes: 45,
    requiredRoomType: null,
  },
  {
    id: IDS.svcManiPedi,
    name: "Manicure & Pedicure",
    category: "WELLNESS",
    description: "Classic hands and feet.",
    priceCents: 95000,
    durationMinutes: 60,
    requiredRoomType: null,
  },

  // --- IV drips -----------------------------------------------------------
  {
    id: IDS.svcGlassSkin,
    name: "Korean Glass Skin Drip",
    category: "WELLNESS",
    subcategory: "iv-drips",
    description:
      "Korean-style glutathione drip. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Glutathione, Lipotocin (Thioctic Acid), Korean Vitamin C",
    ingredientsVerified: true,
    priceCents: 180000,
    durationMinutes: 60,
    requiredRoomType: "OTHER",
  },
  {
    id: IDS.svcYouthful,
    name: "Korean Youthful Glowing Skin Drip",
    category: "WELLNESS",
    subcategory: "iv-drips",
    description:
      "Also known as the Cinderella or Baby Face Drip. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Glutathione, Vitamin C, Alpha Lipoic Acid",
    ingredientsVerified: true,
    priceCents: 160000,
    durationMinutes: 60,
    requiredRoomType: "OTHER",
  },
  {
    id: IDS.svcLuminous,
    name: "Luminous Drip",
    category: "WELLNESS",
    subcategory: "iv-drips",
    description:
      "Also known as Miracle White with Melanin Inhibitor. INGREDIENTS NOT SUPPLIED by the business - confirm before publishing. Duration is also a placeholder.",
    // The brief did not supply this ingredient list. Left null and flagged, so
    // the API presents it as "requires verification" rather than inventing it.
    ingredients: null,
    ingredientsVerified: false,
    priceCents: 140000,
    durationMinutes: 60,
    requiredRoomType: "OTHER",
  },
  {
    id: IDS.svcImmune,
    name: "Immune Booster Drip",
    category: "WELLNESS",
    subcategory: "iv-drips",
    description:
      "Vitamin and mineral drip. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Vitamin C, Zinc, Vitamin B12, Collagen",
    ingredientsVerified: true,
    priceCents: 150000,
    durationMinutes: 60,
    requiredRoomType: "OTHER",
  },

  // --- beauty shots -------------------------------------------------------
  {
    id: IDS.svcShotAntiAging,
    name: "Anti-Aging Shot (Placenta)",
    category: "WELLNESS",
    subcategory: "beauty-shots",
    description:
      "A beauty treatment marketed for skin rejuvenation and anti-aging. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Placenta",
    ingredientsVerified: true,
    priceCents: 120000,
    durationMinutes: 30,
    requiredRoomType: null,
  },
  {
    id: IDS.svcShotRejuvenating,
    name: "Rejuvenating Shot (Collagen)",
    category: "WELLNESS",
    subcategory: "beauty-shots",
    description:
      "A beauty treatment marketed to support skin elasticity and improve the appearance of fine lines and wrinkles. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Collagen",
    ingredientsVerified: true,
    priceCents: 120000,
    durationMinutes: 30,
    requiredRoomType: null,
  },

  // --- add-ons ------------------------------------------------------------
  {
    id: IDS.svcAddonPlacenta,
    name: "Placenta Add-on",
    category: "WELLNESS",
    subcategory: "add-ons",
    description: "Optional add-on. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Placenta",
    ingredientsVerified: true,
    priceCents: 50000,
    durationMinutes: 15,
    requiredRoomType: null,
  },
  {
    id: IDS.svcAddonCollagen,
    name: "Collagen Add-on",
    category: "WELLNESS",
    subcategory: "add-ons",
    description: "Optional add-on. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Collagen",
    ingredientsVerified: true,
    priceCents: 50000,
    durationMinutes: 15,
    requiredRoomType: null,
  },
  {
    id: IDS.svcAddonVitaminC,
    name: "Vitamin C Add-on",
    category: "WELLNESS",
    subcategory: "add-ons",
    description: "Optional add-on. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Vitamin C",
    ingredientsVerified: true,
    priceCents: 30000,
    durationMinutes: 15,
    requiredRoomType: null,
  },
  {
    id: IDS.svcAddonMultivitamins,
    name: "Multivitamins Add-on (Vitamin B12)",
    category: "WELLNESS",
    subcategory: "add-ons",
    description: "Optional add-on. Duration is a placeholder pending confirmation from the business.",
    ingredients: "Vitamin B12",
    ingredientsVerified: true,
    priceCents: 30000,
    durationMinutes: 15,
    requiredRoomType: null,
  },
];

/**
 * Truncation order matters: `cascade` handles the foreign keys, but listing
 * the tables explicitly documents what is considered "data" rather than
 * reference configuration.
 */
async function clear(client) {
  await client.query(`
    truncate table
      public.checkins,
      public.qr_tokens,
      public.promo_redemptions,
      public.booking_items,
      public.bookings,
      public.booking_counters,
      public.attendance,
      public.tasks,
      public.time_off,
      public.working_hours,
      public.employee_services,
      public.promo_codes,
      public.audit_logs,
      public.login_attempts,
      public.clients,
      public.employees,
      public.services
    restart identity cascade
  `);
}

async function seed(client, { quiet = false, confirmed = false } = {}) {
  // Before anything else: is this database allowed to be wiped? See
  // assertDestructiveAllowed above for the three ways to say yes.
  assertDestructiveAllowed({ confirmed });

  const log = (msg) => {
    if (!quiet) process.stdout.write(msg + "\n");
  };

  log(`${c.yellow}seeding ${databaseHost()}${c.reset}`);

  await clear(client);
  log(`${c.cyan}cleared existing data${c.reset}`);

  // --- second-level catalogue ---------------------------------------------
  // Matched on the unique slug, so re-running against a database where
  // migration 22 already inserted them changes nothing.
  for (const sub of SUBCATEGORIES) {
    await client.query(
      `insert into public.service_subcategories (category, name, slug, sort_order)
       values ($1, $2, $3, $4)
       on conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order`,
      [sub.category, sub.name, sub.slug, sub.sortOrder]
    );
  }
  const subRows = await client.query("select id, slug from public.service_subcategories");
  const subIdBySlug = Object.fromEntries(subRows.rows.map((r) => [r.slug, r.id]));
  log(`${c.green}${SUBCATEGORIES.length} subcategories${c.reset}`);

  // --- services ------------------------------------------------------------
  // One statement per row rather than a single multi-row VALUES: the column
  // list is long and the optional fields (subcategory, ingredients, room type)
  // differ per row, so a positional VALUES list would be a wall of `$n` that
  // silently shifts the moment a column is added.
  for (const svc of SERVICES) {
    await client.query(
      `insert into public.services
         (id, name, category, description, price_cents, duration_minutes, is_active,
          subcategory_id, required_room_type, ingredients, ingredients_verified,
          loyalty_eligible, needs_pricing)
       values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, false, false)`,
      [
        svc.id,
        svc.name,
        svc.category,
        svc.description,
        svc.priceCents,
        svc.durationMinutes,
        svc.subcategory ? (subIdBySlug[svc.subcategory] ?? null) : null,
        svc.requiredRoomType,
        svc.ingredients ?? null,
        svc.ingredientsVerified ?? true,
      ]
    );
  }
  log(`${c.green}${SERVICES.length} services${c.reset}`);

  // --- employees -----------------------------------------------------------
  await client.query(
    `insert into public.employees (id, full_name, title, bio, is_active)
     values
       ($1, 'Ana Reyes',   'Senior Therapist', 'Fifteen years in therapeutic massage.', true),
       ($2, 'Bea Santos',  'Beauty Specialist','Facials, skin and nail care.',          true),
       ($3, 'Cara Lim',    'Hair Stylist',     'Precision cutting and colour.',         true)`,
    [IDS.empAna, IDS.empBea, IDS.empCara]
  );
  log(`${c.green}3 employees${c.reset}`);

  // --- qualifications ------------------------------------------------------
  // Ana does everything except hair; Bea does facial, nails, and the wellness
  // shots and add-ons; Cara does cut only. The gaps are deliberate: they let
  // the tests prove EMPLOYEE_NOT_QUALIFIED is enforced rather than incidentally
  // true, and they keep Cara as the "hair only" stylist those tests rely on.
  //
  // The wellness rows need at least one qualified stylist each, or the ten new
  // catalogue services would be unbookable and would fail the availability
  // check for every day of the week.
  const WELLNESS_DRIPS = [IDS.svcGlassSkin, IDS.svcYouthful, IDS.svcLuminous, IDS.svcImmune];
  const WELLNESS_SHOTS = [IDS.svcShotAntiAging, IDS.svcShotRejuvenating];
  const WELLNESS_ADDONS = [
    IDS.svcAddonPlacenta,
    IDS.svcAddonCollagen,
    IDS.svcAddonVitaminC,
    IDS.svcAddonMultivitamins,
  ];

  const quals = [
    [IDS.empAna, IDS.svcMassage],
    [IDS.empAna, IDS.svcFacial],
    [IDS.empAna, IDS.svcManiPedi],
    [IDS.empBea, IDS.svcFacial],
    [IDS.empBea, IDS.svcManiPedi],
    [IDS.empCara, IDS.svcHaircut],
    // Ana takes the whole wellness menu; Bea takes the in-chair procedures.
    ...WELLNESS_DRIPS.map((svc) => [IDS.empAna, svc]),
    ...WELLNESS_SHOTS.map((svc) => [IDS.empAna, svc]),
    ...WELLNESS_ADDONS.map((svc) => [IDS.empAna, svc]),
    ...WELLNESS_SHOTS.map((svc) => [IDS.empBea, svc]),
    ...WELLNESS_ADDONS.map((svc) => [IDS.empBea, svc]),
  ];
  const qualParams = [];
  const qualValues = quals.map(([emp, svc]) => {
    qualParams.push(emp, svc);
    const n = qualParams.length;
    return `($${n - 1}, $${n})`;
  });
  await client.query(
    `insert into public.employee_services (employee_id, service_id) values ${qualValues.join(",")}`,
    qualParams
  );
  log(`${c.green}${quals.length} qualifications${c.reset}`);

  // --- working hours -------------------------------------------------------
  // Monday(1) to Saturday(6), 09:00-18:00 branch local time. Sunday closed.
  // An empty working_hours row set is a meaningful state too - it means the
  // employee is bookable nowhere - so the tests cover both.
  const days = [1, 2, 3, 4, 5, 6];
  const hoursValues = [];
  const hoursParams = [];
  for (const emp of [IDS.empAna, IDS.empBea, IDS.empCara]) {
    for (const d of days) {
      hoursParams.push(emp, d);
      hoursValues.push(`($${hoursParams.length - 1}, $${hoursParams.length}, '09:00', '18:00')`);
    }
  }
  await client.query(
    `insert into public.working_hours (employee_id, weekday, start_time, end_time) values ${hoursValues.join(",")}`,
    hoursParams
  );
  log(`${c.green}18 working-hour rows${c.reset}`);

  // --- promo codes ---------------------------------------------------------
  await client.query(
    `insert into public.promo_codes
       (id, code, type, value, starts_at, ends_at, max_redemptions, per_client_limit, min_spend_cents, is_active)
     values
       ($1, 'SAVE10', 'PERCENT', 10, now() - interval '1 day', now() + interval '365 days', 100, 1, 0,     true),
       ($2, 'FLAT500','FIXED',  50000, now() - interval '1 day', now() + interval '365 days', 2, 1, 100000, true)`,
    [IDS.promoPercent, IDS.promoFixed]
  );
  log(`${c.green}2 promo codes${c.reset}`);

  // --- clients -------------------------------------------------------------
  await client.query(
    `insert into public.clients (id, full_name, phone, email, is_active)
     values
       ($1, 'Ada Cruz',  '+639171111111', 'ada@example.com',  true),
       ($2, 'Ben Ocampo','+639172222222', 'ben@example.com',  true)`,
    [IDS.clientAda, IDS.clientBen]
  );
  log(`${c.green}2 clients${c.reset}`);

  // --- put the demo logins back -------------------------------------------
  await relinkDemoProfiles(client, log);

  log(`\n${c.bold}${c.green}seed complete${c.reset}`);
  return IDS;
}

/**
 * Re-attach the demo auth accounts to the rows this seed just rebuilt.
 *
 * ## Why this exists
 *
 * The truncate above takes out `public.employees` and `public.clients`, and
 * with them the `profile_id` pointers that make a demo login *be* a stylist or
 * a customer. The auth users in `auth.users` survive (the seed never touches
 * them), so the symptom is nasty and quiet: every demo account still signs in
 * perfectly, and every one of them comes back with `employeeId: null`.
 *
 * The visible failures were a stylist seeing "This account is not linked to an
 * employee record" on their own attendance page, and `/tasks/mine`,
 * `/tasks/counts` and `/attendance/summary` answering 403 — because the
 * service layer refuses to guess whose records an unlinked employee means.
 * Running `npm test` was enough to cause it, since the Jest global setup runs
 * this seed.
 *
 * So the seed now repairs what it broke. It reads the same
 * `demo-accounts.json` the login page reads, so the ids cannot drift, and it is
 * entirely best-effort: if the auth users have never been created (a fresh
 * clone, before `npm run demo:accounts`), it quietly does nothing.
 *
 * @param {import("pg").Client} client
 * @param {(msg: string) => void} [log]
 */
async function relinkDemoProfiles(client, log = () => {}) {
  let demo;
  try {
    const file = path.resolve(__dirname, "..", "..", "demo-accounts.json");
    demo = JSON.parse(require("fs").readFileSync(file, "utf8"));
  } catch {
    return; // no demo file — nothing to relink, and not an error
  }

  let linked = 0;

  for (const account of demo.accounts ?? []) {
    if (!account.employeeId && !account.clientId) continue;

    // The profile id is the auth user's id; `profiles` cascades from `auth.users`.
    const { rows } = await client.query(
      `select p.id from public.profiles p
         join auth.users u on u.id = p.id
        where lower(u.email) = lower($1)`,
      [account.email]
    );
    const profileId = rows[0]?.id;
    if (!profileId) continue; // account not created yet

    if (account.employeeId) {
      await client.query(`update public.employees set profile_id = $1 where id = $2`, [
        profileId,
        account.employeeId,
      ]);
      linked += 1;
    }

    if (account.clientId) {
      /*
       * Detach first. `clients.profile_id` is UNIQUE, and a demo client who has
       * ever signed in through the app has a second clients row auto-created
       * for them — so setting the pointer on the canonical row while the stale
       * one still holds it raises 23505 and aborts the whole seed.
       */
      await client.query(
        `update public.clients set profile_id = null where profile_id = $1 and id <> $2`,
        [profileId, account.clientId]
      );
      await client.query(
        `update public.clients set profile_id = $1, email = $2 where id = $3`,
        [profileId, account.email, account.clientId]
      );
      linked += 1;
    }
  }

  if (linked > 0) {
    log(`${c.green}${linked} demo account link(s) restored${c.reset}`);
  }
}

async function main() {
  const quiet = process.argv.includes("--quiet");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await seed(client, { quiet });
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`\nseed failed: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { seed, IDS, clear, relinkDemoProfiles, assertDestructiveAllowed, databaseHost };
