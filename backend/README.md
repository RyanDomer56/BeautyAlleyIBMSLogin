# Beauty Alley — Backend

Express + TypeScript API over Supabase (Postgres, Auth, RLS) for the Beauty  
Alley booking system. Backend only — no frontend, no UI.

Design rationale lives in [`DESIGN.md`](./DESIGN.md). Read that first.

---

## Current status

| Layer | State |
| --- | --- |
| Database schema, constraints, RLS, functions, triggers, views | **Applied and verified against the live project** |
| `scripts/migrate.js` | Working — **16 migrations applied** |
| `scripts/verify.js` | Working — **51 behavioural checks, all passing** |
| `scripts/seed.js` | Working — deterministic fixtures for tests and demos |
| `scripts/smoke.js` | Working — **43 end-to-end checks against a live server** |
| Express API (`src/`) | **Written and building clean** — 8 modules |
| `GET /` and `GET /api/v1` | Serve a **50-endpoint service index**, not a bare 404 |
| Jest + Supertest suite | **251 tests — 251 passing, 0 skipped** |

The whole API is live and verified against the real Supabase project. The  
**public half runs on the publishable key alone**:

- `GET /services`, `/services/search`, `/services/:id` — RLS-enforced catalogue
- `GET /employees`, `/employees/:id` — public "meet the team" profiles
- `GET /availability` — the slot grid, via a `security definer` function
- `POST /promos/validate` — the cart's promo preview
- validation errors, auth gates and 404s all return the documented shapes

The **authenticated and write paths** — booking lifecycle, QR check-in, promo  
redemption, admin reporting — run end to end against the live database, with  
real GoTrue sessions and real JWTs.

Nothing is skipped. The suite previously reported 93 skips because  
`SUPABASE_SERVICE_ROLE_KEY` was missing; the key is now supplied, so every test  
runs. It has been run twice back to back at 195/195 to confirm the fixtures  
leave no state behind.

The three harnesses answer different questions and all three are green:

```bash
npm test          # 251/251   — the rules, in-process
npm run db:verify #  51/51    — the schema guarantees, direct SQL, rolled back
npm run smoke     #  43/43    — the built artefact, over real HTTP
```

`npm run smoke` needs a server running (`npm run dev`). It is the only one of
the three that can see a broken entry point or a wire-format inconsistency
between two endpoints, which is how the `+00:00` leak was found.

---

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
```

### Environment

| Variable                    | Where to get it                                                                  | Needed for                                  |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `SUPABASE_URL`              | Settings → Data API                                                              | everything                                  |
| `SUPABASE_ANON_KEY`         | Settings → API → Project API keys → publishable                                  | public reads                                |
| `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → Project API keys → secret                                       | **all writes, auth admin, admin reporting** |
| `DATABASE_URL`              | `postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres`         | migrations, seed, tests                     |
| `QR_SIGNING_SECRET`         | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` | signing passes                              |

`.env` is gitignored. `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security  
entirely — it must never reach a browser, a log line, or a commit. The logger  
redacts anything matching `sb_secret_*`, `sb_publishable_*`, a JWT, or a  
`postgres://` URL before it is written.

### A note on the hosted auth rate limit

The API validates bearer tokens by asking GoTrue (`auth.getUser`) rather than  
verifying the signature locally, so each test fixture costs two requests to the  
hosted auth service. That service rate-limits `/token`, and a suite that creates  
a fixture per test trips it. The harness caches fixtures per suite and retries a  
429 with backoff; `node scripts/probe-ratelimit.js` measures the budget if a run  
ever starts reporting `over_request_rate_limit`.

---

## Running

```bash
npm run dev           # build and start on :4000
npm run db:status     # what is applied, what is pending, and any drift
npm run db:migrate    # apply pending migrations
npm run db:seed       # wipe and reseed deterministic fixtures
npm run db:verify     # 51 behavioural checks against the live database
npm run typecheck     # source
npm test              # the full Jest + Supertest suite
npm run smoke         # 43 end-to-end checks against a *running* server
```

`db:verify` runs entirely inside one transaction that is rolled back at the  
end, so it is safe to point at a live project — no fixtures survive.

It reads the database as it finds it, which means every expectation has to be  
stated as an invariant rather than a fixed number. Two checks used to assert  
`count(*) = 0` and a booking reference ending in `-0001`, which only held  
against a blank database; they now assert that *this harness's* fixtures are  
gone and that the reference matches `BA-YYYYMMDD-NNNN`. Both were reporting  
failures caused by the seed and by earlier test runs, not by the schema.

It is also anchored to a fixed local hour rather than to `now()`. The harness
opens every employee 00:00–23:59 and derives later slots by adding up to 20
hours to one base time, so anchoring on the current hour made the derived slots
depend on when you ran it — at 03:00 UTC a slot landed on 23:00 Manila and a
90-minute service ran past the 23:59 close. The base is now pinned to 01:00
Manila, which puts the worst case at 22:30. See DESIGN.md §9.12.

### `npm run smoke`

The Jest suite runs `createApp()` in-process through Supertest, which is the
right way to prove the rules — but it would not notice a broken entry point, a
port that never binds, or a route mounted only in the test harness. The smoke
test boots against an already-running server (`npm run dev`) and walks the
documented surface in the order a real client would: browse the catalogue,
check availability, book as a guest, read the booking back with nothing but its
uuid, take the pass to the desk, then look at the staff and admin views.

```bash
npm run dev          # terminal 1
npm run smoke        # terminal 2
BASE=http://host:port npm run smoke   # or point it elsewhere
```

It creates its own STAFF and ADMIN accounts, and deletes every booking and auth
user it made in a `finally`, so it is safe to point at the live project. It is
the harness that caught the `+00:00` leak above — the Jest suite could not,
because both spellings round-trip through the same in-process serialiser.

### Destructive

```bash
node scripts/migrate.js --reset --yes
```

Drops `schema public` cascade and reapplies every migration. Deletes all data.  
`npm run db:seed` also truncates every data table before inserting.

---

## Why there is no Supabase CLI here

The usual flow is `supabase start` (a local Docker stack) and  
`supabase db push`. Neither is available on this machine: `supabase start`  
boots Postgres, GoTrue, PostgREST and Kong as Docker containers, and there is  
no Docker daemon.

`scripts/migrate.js` therefore talks to Postgres directly over the wire, which  
is why `DATABASE_URL` is the only thing it needs. The trade-off is recorded in  
`DESIGN.md` §0: tests run against the cloud project rather than a local one.

---

## Migrations

Files are immutable once applied. The runner stores a SHA-256 checksum of each  
file in `supabase_migrations.schema_migrations` and refuses to run if a file  
has changed since it was applied — add a new migration instead.

| #  | File                     | Contents                                                        |
| -- | ------------------------ | --------------------------------------------------------------- |
| 01 | `extensions`             | `btree_gist`, `citext`                                          |
| 02 | `enums`                  | `user_role`, `service_category`, `booking_status`, `promo_type` |
| 03 | `core_tables`            | `profiles`, `clients`, `employees`, `services`                  |
| 04 | `scheduling_tables`      | `employee_services`, `working_hours`, `time_off`                |
| 05 | `booking_tables`         | `booking_counters`, `bookings`, `booking_items`                 |
| 06 | `promo_qr_tables`        | `promo_codes`, `promo_redemptions`, `qr_tokens`, `checkins`     |
| 07 | `admin_tables`           | `audit_logs`, `login_attempts`                                  |
| 08 | `constraints_indexes`    | the `EXCLUDE` double-booking guard, indexes                     |
| 09 | `rls_policies`           | RLS on every table, grants, column-scoped writes                |
| 10 | `functions`              | `create_booking`, `cancel_booking`, `check_in_booking`, …       |
| 11 | `triggers`               | `updated_at`, status transitions, `auth.users` → `profiles`     |
| 12 | `views`                  | reporting views, all `security_invoker`                         |
| 13 | `function_grants`        | revokes EXECUTE from `anon`/`authenticated`                     |
| 14 | `public_function_grants` | re-grants EXECUTE on the two read-only public functions         |
| 15 | `sync_profile_role`      | fixes role drift: `app_metadata` lands after the INSERT         |
| 16 | `fix_working_hours_wrap` | fixes a real acceptance bug in the working-hours check          |

Migrations 09 and 13 are separate on purpose: a `REVOKE` only affects objects  
that already exist, so revoking function execution has to happen *after*  
migration 10 creates the functions.

Migration 14 then re-grants `EXECUTE` on exactly two functions, because the  
booking flow cannot work without them:

| Function              | Why it is public                                     |
| --------------------- | ---------------------------------------------------- |
| `get_available_slots` | the "pick a time" grid, shown to signed-out visitors |
| `validate_promo`      | the cart's "apply code" preview, before sign-in      |

Both are `stable`, write nothing, and return no personal data — availability  
returns employee ids and free time ranges, and promo validation returns a  
discount for a code the caller already supplied. Everything else stays  
`service_role`-only, and migration 14 asserts both directions: the two are  
reachable, and `create_booking` / `cancel_booking` / `reschedule_booking` /  
`check_in_booking` / `get_dashboard_summary` are not.

### Migration 16 — worth knowing about

`create_booking` checked working hours with  
`v_local_start::time + make_interval(mins => v_duration) <= wh.end_time`.  
Postgres takes `time + interval` **modulo 24 hours**, so `time '23:00' + interval
'1 hour'` is `00:00:00`, not `24:00:00` — and `00:00:00 <= 18:00:00` is true. A  
23:00 appointment was therefore accepted by a stylist whose shift ends at 18:00.

Migration 16 compares offsets from the start of the shift instead  
(`(start - shift_start) + duration <= (shift_end - shift_start)`), which stays in  
the `interval` domain and cannot wrap. It self-asserts three ways, including that  
the old expression *does* accept the bad input — so the reason for the change is  
recorded in the migration, not only in a comment. See `DESIGN.md` §9.6.

---

## The API

```
src/
├── config/env.ts          zod-validated environment, fails loudly at boot
├── db/supabase.ts         three clients: public, service-role, and as-the-user
├── lib/                   errors, logger, pagination, dates, QR signing, async wrapper
├── lib/apiIndex.ts        the service index served at / and /api/v1
├── middleware/            authenticate, requireRole, validate, errorHandler, rateLimit
├── modules/
│   ├── auth/              register, login (+ DB-backed lockout), refresh, me
│   ├── services/          catalogue CRUD
│   ├── employees/         staff, qualifications, hours, time off, availability
│   ├── bookings/          create, cancel, reschedule, status, QR pass
│   ├── qr/                desk code, check-in
│   ├── promos/            validate, CRUD, redemption counting
│   └── admin/             dashboard, clients, CSV export, audit log
├── routes.ts              the whole API surface, mounted under /api/v1
├── app.ts                 middleware stack, /health and the root index
└── index.ts               bootstrap and graceful shutdown
```

Layering is strict: `routes → controller → service → repository`. Only  
repositories touch Supabase; only services hold business rules.

### The root is not a dead end

`GET /` and `GET /api/v1` both return a JSON index of the whole surface — every
endpoint with its method, its auth requirement and a one-line description,
plus where `/health` lives and what the error envelope looks like:

```bash
curl http://127.0.0.1:4000/
```

Before this existed, pointing a browser at the port returned
`{"error":{"code":"NOT_FOUND","message":"No route matches GET /"}}`, which
reads as "the service is broken" when the service is healthy and simply has no
page at that address.

It is **JSON, not a page**. The brief for this service is backend-only, and a
landing page would put a browser-facing surface on something that is not meant
to have one — the index is service discovery, which is a backend concern; it
just happens to be legible in a browser.

The list is hand-written so each entry can carry a description and an auth
requirement, which a list derived from the router stack could not.
`tests/unit/apiIndex.test.ts` is the guard against it drifting: it calls every
documented path and fails if the response is the router-level `No route
matches …`. A 400, 401, 403 or a resource-level 404 all prove the route exists;
only that one message proves it does not.

### Three database clients, on purpose

| Client                 | Credential           | Used for                                                  |
| ---------------------- | -------------------- | --------------------------------------------------------- |
| `supabasePublic`       | publishable key      | public catalogue, availability, promo preview, sign-in/up |
| `supabaseAs(token)`    | the caller's own JWT | resolving the caller's profile — so RLS enforces it       |
| `requireServiceRole()` | secret key           | writes, admin reporting, `auth.admin.*`                   |

The middle one matters. `authenticate` reads the caller's profile with *their  
own token*, so the read is subject to `profiles_select_own` — the same policy a  
browser faces. If a policy is ever loosened, the API inherits the mistake  
instead of quietly papering over it with `BYPASSRLS`.

### Response shapes

```jsonc
// success
{ "data": { … } }
{ "data": [ … ], "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3,
                           "hasNext": true, "hasPrev": false } }

// failure — always, for every status
{ "error": { "code": "SLOT_TAKEN", "message": "That time slot has just been taken…",
             "details": { … } } }
```

A 5xx never carries a raw upstream message. Postgres errors name tables,  
columns and constraints and can echo row values; those go to the log on  
`cause`, not to the wire.

### Timestamps are always `Z`-suffixed UTC

Two layers render `timestamptz` and they disagree on the spelling of the same
instant. PostgREST (a plain column read) produces `2026-10-26T04:00:00+00:00`;
a PL/pgSQL function returning `jsonb` produces a value supabase-js
re-serialises as `2026-10-26T04:00:00.000Z`. Both are valid ISO-8601 and denote
the same moment, but a client cannot compare them as strings — and before this
was pinned, `/availability` said `+00:00` while `/bookings` said `Z` for the
same kind of field.

Every typed DTO field is therefore passed through `iso()` in
`src/lib/dates.ts`, so the wire format is `Z` everywhere. This is a
representation change only; the instant never moves.

One field is deliberately exempt: `audit_logs.metadata`. It is an untyped
`jsonb` snapshot the database wrote itself, and it is passed through verbatim
because an audit record the application layer rewrites is no longer evidence,
and because recursively rewriting strings in an untyped blob would corrupt any
legitimate value that happens to look like a timestamp. `npm run smoke`
section 6b asserts both halves — typed fields normalised, snapshot intact.

## Tests

251 tests across 13 files. `npm test` runs the whole thing.

| Suite | Needs the secret key? | Covers |
| --- | --- | --- |
| `unit/qr` | no | forging, tampering, expiry, malformed input |
| `unit/csv` | no | structural escaping and formula injection |
| `unit/errors` | no | SQLSTATE → HTTP mapping, no raw message leakage |
| `unit/logger` | no | credential redaction |
| `unit/apiIndex` | no | every path in the service index is actually mounted |
| `integration/schema` | no | the constraint, RLS coverage, function grants |
| `integration/rls` | no | cross-client isolation, privilege escalation |
| `integration/public` | no | catalogue, availability, promo preview, auth gates |
| `integration/auth` | **yes** | register, login, lockout, refresh, logout, RBAC |
| `integration/bookings` | **yes** | create, 409 double-book, window, reschedule |
| `integration/promos` | **yes** | caps, per-customer limits, release on cancel |
| `integration/qr` | **yes** | window, replay, revocation, forgery |
| `integration/admin` | **yes** | dashboard, clients, CSV, audit log |

The suites that need the secret key are gated with `describe.skip` rather than a
soft assertion, so if the key is ever missing they report as **skipped** — a
green test that never ran is worse than a visible gap. With the key present,
none of them skip.

The `schema` and `rls` suites assert against Postgres directly rather than
through the API, because the whole point of putting those rules in the database
is that they hold even when the API is not the one doing the writing. A test
that only proved "the service layer checks for conflicts" would pass against a
schema with no constraint at all.

### Test isolation

All suites share one database, so slots and capacity have to be reserved rather
than assumed. Three mechanisms:

- `useSlotBand(SLOT_BANDS.<suite>)` at the top of a suite claims a band of
  day-offsets, so two suites asking for "in 4 days at 10:00" get different
  physical slots instead of fighting over one.
- Fixtures that must be placed by raw SQL — a booking 30 minutes out, which the
  API would correctly refuse — are tracked and deleted in `afterEach`.
- A test that needs a promo code with capacity creates its own, rather than
  spending a shared fixture's global cap and leaving the outcome
  dependent on declaration order.

### Why `get_available_slots` is tested for an unqualified stylist

The seed deliberately leaves gaps in qualifications — Ana does everything but
hair, Cara does only hair. Those gaps are what make
`EMPLOYEE_NOT_QUALIFIED` and "availability does not offer the wrong person"
meaningful tests rather than assertions that happen to be true.

## The guarantees this schema enforces

These are enforced by the database, not by application code, so they hold even  
if a future code path forgets to check.

**No double-booking.** A GiST exclusion constraint on  
`(employee_id, tstzrange(start_time, end_time))`, filtered to live statuses.  
Two overlapping bookings for the same employee are impossible. Violations raise  
SQLSTATE `23P01`, mapped to HTTP `409 SLOT_TAKEN`. Cancelled and no-show  
bookings are excluded, so the slot frees up immediately.

**Promo caps cannot be exceeded.** `create_booking` takes  
`SELECT ... FOR UPDATE` on the promo row before counting redemptions, so two  
simultaneous requests serialise instead of both reading a stale count.

**The status machine is closed.** `COMPLETED` is terminal; you cannot walk a  
finished booking back to `PENDING`.

**Privilege escalation is closed.** `authenticated` holds `UPDATE` on  
`profiles(full_name, phone)` only — not `role`. Without column-scoped grants,  
`update profiles set role = 'ADMIN' where id = auth.uid()` would be a one-line  
escalation available to every logged-in user.

**Reporting views do not leak.** Postgres 15+ views default to the *owner's*  
privileges and therefore bypass the RLS of their underlying tables. Every view  
here sets `security_invoker = true` and is revoked from `anon`/`authenticated`.

**The anon key cannot call business logic.** `CREATE FUNCTION` grants `EXECUTE`  
to `PUBLIC` by default. Left alone, anyone with the publishable key — which is  
shipped to browsers by design — could `POST /rest/v1/rpc/get_dashboard_summary`  
and read the salon's revenue. Migration 13 revokes it and asserts the result.

---

## Error codes

Functions raise `raise exception 'CODE' using errcode = '<class>'`. The API  
maps the message to an HTTP status.

| Code                                         | Meaning                                    | HTTP |
| -------------------------------------------- | ------------------------------------------ | ---- |
| `SLOT_TAKEN`                                 | Overlaps an existing booking               | 409  |
| `SERVICES_INVALID` / `SERVICES_REQUIRED`     | Bad service list                           | 400  |
| `CLIENT_REQUIRED`                            | No client id and no guest phone            | 400  |
| `START_TIME_REQUIRED` / `START_TIME_IN_PAST` | Bad start time                             | 400  |
| `OUTSIDE_WORKING_HOURS`                      | Not inside a shift                         | 400  |
| `EMPLOYEE_NOT_QUALIFIED`                     | Employee does not deliver that service     | 403  |
| `CANCELLATION_WINDOW_PASSED`                 | Inside the cancellation window             | 400  |
| `PROMO_*`                                    | `NOT_FOUND`, `EXPIRED`, `LIMIT_REACHED`, … | 400  |
| `QR_INVALID` / `QR_EXPIRED` / `QR_REVOKED`   | Bad pass                                   | 400  |
| `QR_TOO_EARLY` / `QR_TOO_LATE`               | Outside the check-in window                | 400  |
| `ALREADY_CHECKED_IN`                         | Pass already redeemed                      | 409  |
| `INVALID_STATUS_TRANSITION`                  | Illegal lifecycle move                     | 409  |
