# Beauty Alley — Backend Design (Step 1)

> Status: **awaiting approval.** No backend code written yet.
> Scope: backend only. No frontend, no UI.

---

## 0. Environment reality (read this first)

The spec says tests must run against a **local** Supabase (`supabase start`).
That is not possible on this machine, and it is not something I can fix:

| Requirement | Status here |
|---|---|
| Docker (required by `supabase start`) | **Not installed** |
| Supabase CLI | **Not installed** (installable via npm; but it does not remove the Docker dependency) |

`supabase start` boots Postgres, GoTrue, PostgREST, Kong and Studio as Docker
containers. Without a Docker daemon there is no local stack.

**Consequence:** the Jest + Supertest suite will run against a **dedicated cloud
Supabase test project** instead of a local one. That is a real deviation from the
spec, recorded here rather than quietly absorbed. If you want strict local
parity, install Docker Desktop and I will switch the test target back.

---

## 1. Folder structure

```
backend/
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── jest.config.ts
├── README.md                     # setup, env vars, how to run tests
├── ASSUMPTIONS.md                # every judgement call, recorded
├── openapi.yaml                  # OpenAPI 3.1
│
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 20261009000001_extensions.sql
│   │   ├── 20261009000002_enums.sql
│   │   ├── 20261009000003_core_tables.sql          # profiles, clients, employees, services
│   │   ├── 20261009000004_scheduling_tables.sql    # working_hours, time_off, employee_services
│   │   ├── 20261009000005_booking_tables.sql       # bookings, booking_items
│   │   ├── 20261009000006_promo_qr_tables.sql      # promo_codes, promo_redemptions, qr_tokens, checkins
│   │   ├── 20261009000007_admin_tables.sql         # audit_logs, login_attempts
│   │   ├── 20261009000008_constraints_indexes.sql  # EXCLUDE, unique, indexes
│   │   ├── 20261009000009_rls_policies.sql
│   │   ├── 20261009000010_functions.sql            # PL/pgSQL business logic
│   │   ├── 20261009000011_triggers.sql             # status transitions, updated_at, auth hook
│   │   └── 20261009000012_views.sql                # dashboard / reporting views
│   ├── seed.sql                                    # 1 admin, 2 staff, 5 services, 3 employees, 2 promos
│   └── tests/                                      # SQL-level assertions (RLS + constraints)
│
├── src/
│   ├── index.ts                    # boot: config check → listen
│   ├── app.ts                      # express app: helmet, cors, json, routes, error handler
│   ├── config/
│   │   └── env.ts                  # zod-validated process.env
│   ├── db/
│   │   └── supabase.ts             # service-role client (server-only)
│   ├── types/
│   │   └── database.ts             # generated: supabase gen types typescript
│   │
│   ├── middleware/
│   │   ├── authenticate.ts         # verify Supabase access token → req.actor
│   │   ├── requireRole.ts          # requireRole('ADMIN') / ('STAFF','ADMIN')
│   │   ├── validate.ts             # zod body/query/params
│   │   ├── rateLimit.ts
│   │   └── errorHandler.ts         # { error: { code, message, details? } }
│   │
│   ├── modules/                    # each: *.routes.ts, *.controller.ts, *.service.ts, *.repository.ts, *.schema.ts
│   │   ├── auth/
│   │   ├── services/
│   │   ├── employees/
│   │   ├── availability/
│   │   ├── bookings/
│   │   ├── qr/
│   │   ├── promos/
│   │   └── admin/
│   │
│   ├── lib/
│   │   ├── errors.ts               # AppError + code constants
│   │   ├── logger.ts
│   │   ├── bookingReference.ts     # sequence-backed BA-YYYYMMDD-NNNN
│   │   ├── qr.ts                   # HMAC sign/verify with QR_SIGNING_SECRET
│   │   └── notifications/
│   │       ├── NotificationService.ts   # interface
│   │       └── ConsoleNotificationService.ts
│   └── utils/
│       ├── time.ts                 # branch timezone helpers
│       └── money.ts                # minor-unit helpers
│
└── tests/
    ├── setup.ts
    ├── helpers/{db.ts,auth.ts,factories.ts}
    ├── integration/
    │   ├── auth.test.ts
    │   ├── services.test.ts
    │   ├── employees.test.ts
    │   ├── availability.test.ts
    │   ├── bookings.test.ts
    │   ├── promo.test.ts
    │   ├── qr.test.ts
    │   ├── rbac.test.ts
    │   └── rls.test.ts             # anon key + client token → must NOT read others' data
    └── unit/
```

**Layering rule:** routes → controllers → services → repositories.
Controllers do HTTP only. All business logic lives in services. Repositories are
the only layer that touches `supabase-js`.

---

## 2. SQL schema

Conventions: `timestamptz` (UTC) everywhere; money as **integer minor units**
(centavos); `citext` for case-insensitive codes/emails; `updated_at` maintained
by trigger.

### Enums
| Enum | Values |
|---|---|
| `user_role` | `GUEST`, `CLIENT`, `STAFF`, `ADMIN` |
| `service_category` | `SPA`, `SALON`, `WELLNESS` |
| `booking_status` | `PENDING`, `CONFIRMED`, `CHECKED_IN`, `IN_SERVICE`, `COMPLETED`, `CANCELLED`, `NO_SHOW` |
| `promo_type` | `PERCENT`, `FIXED` |

### Core
| Table | Columns |
|---|---|
| `profiles` | `id uuid PK` (= `auth.users.id`), `role user_role NOT NULL`, `full_name text`, `phone text`, `is_active bool DEFAULT true`, `created_at`, `updated_at` |
| `clients` | `id uuid PK`, `profile_id uuid UNIQUE NULL REFERENCES profiles`, `full_name text NOT NULL`, `phone citext`, `email citext`, `notes text`, `is_active bool`, `created_at`, `updated_at` |
| `employees` | `id uuid PK`, `profile_id uuid UNIQUE NULL REFERENCES profiles`, `full_name text NOT NULL`, `title text`, `bio text`, `is_active bool`, `created_at`, `updated_at` |
| `services` | `id uuid PK`, `name text NOT NULL`, `category service_category NOT NULL`, `description text`, `price_cents int NOT NULL CHECK (>= 0)`, `duration_minutes int NOT NULL CHECK (> 0)`, `is_active bool DEFAULT true`, `created_at`, `updated_at` |

### Scheduling
| Table | Columns |
|---|---|
| `employee_services` | `employee_id`, `service_id`, PK `(employee_id, service_id)` |
| `working_hours` | `id`, `employee_id`, `weekday smallint CHECK (0..6)`, `start_time time`, `end_time time`, `CHECK (end_time > start_time)`, UNIQUE `(employee_id, weekday, start_time)` |
| `time_off` | `id`, `employee_id`, `starts_at timestamptz`, `ends_at timestamptz`, `reason text`, `CHECK (ends_at > starts_at)` |

### Bookings
| Table | Columns |
|---|---|
| `bookings` | `id uuid PK`, `reference text UNIQUE NOT NULL`, `client_id uuid NULL REFERENCES clients`, `guest_name text`, `guest_phone citext`, `employee_id uuid NOT NULL REFERENCES employees`, `start_time timestamptz NOT NULL`, `end_time timestamptz NOT NULL`, `status booking_status NOT NULL DEFAULT 'PENDING'`, `subtotal_cents int NOT NULL`, `discount_cents int NOT NULL DEFAULT 0`, `total_cents int NOT NULL CHECK (>= 0)`, `promo_code_id uuid NULL`, `notes text`, `cancelled_at`, `cancellation_reason`, `created_at`, `updated_at`; `CHECK (end_time > start_time)`; `CHECK (client_id IS NOT NULL OR guest_phone IS NOT NULL)` |
| `booking_items` | `id`, `booking_id` FK cascade, `service_id`, `name_snapshot text`, `price_cents_snapshot int`, `duration_minutes_snapshot int`, `employee_id` — the **price snapshot** that keeps old bookings stable when a service price changes |

### Promo / QR / check-in
| Table | Columns |
|---|---|
| `promo_codes` | `id`, `code citext UNIQUE NOT NULL`, `type promo_type`, `value int NOT NULL CHECK (> 0)`, `starts_at`, `ends_at`, `max_redemptions int`, `per_client_limit int`, `min_spend_cents int DEFAULT 0`, `applicable_service_ids uuid[] NULL`, `is_active bool DEFAULT true`, `created_at`, `updated_at`; `CHECK (ends_at > starts_at)` |
| `promo_redemptions` | `id`, `promo_code_id`, `booking_id`, `client_id NULL`, `guest_phone citext NULL`, `amount_cents int`, `created_at`, `released_at NULL` |
| `qr_tokens` | `id`, `booking_id`, `jti uuid UNIQUE NOT NULL`, `expires_at timestamptz`, `used_at NULL`, `revoked_at NULL`, `created_at` |
| `checkins` | `id`, `booking_id`, `staff_id uuid REFERENCES employees`, `checked_in_at timestamptz DEFAULT now()` |

### Admin
| Table | Columns |
|---|---|
| `audit_logs` | `id`, `actor_id uuid NULL`, `actor_role user_role NULL`, `action text`, `entity text`, `entity_id uuid NULL`, `metadata jsonb`, `created_at` |
| `login_attempts` | `id`, `email citext`, `succeeded bool`, `ip inet NULL`, `created_at` — index on `(email, created_at DESC)` for the 15-minute lockout |

### Sequence
`booking_reference_seq` → `BA-YYYYMMDD-NNNN` (per-day counter, zero-padded).

---

## 3. RLS policy list

RLS is enabled on **every** table. Default posture is deny — a table with no
policy grants nothing to `anon` / `authenticated`.

| Table | anon | authenticated (CLIENT) | STAFF / ADMIN |
|---|---|---|---|
| `profiles` | none | `SELECT`, `UPDATE` where `id = auth.uid()` | none (via backend) |
| `clients` | none | `SELECT`, `UPDATE` where `profile_id = auth.uid()` | none (via backend) |
| `services` | `SELECT` where `is_active` | same | same |
| `employees` | `SELECT` where `is_active` | same | same |
| `employee_services` | `SELECT` where employee active | same | same |
| `bookings` | none | `SELECT` where `client_id IN (SELECT id FROM clients WHERE profile_id = auth.uid())` | none (via backend) |
| `booking_items` | none | `SELECT` where parent booking is visible to them | none (via backend) |
| `working_hours`, `time_off` | none | none | none (backend only) |
| `promo_codes`, `promo_redemptions` | none | none | none (backend only) |
| `qr_tokens`, `checkins` | none | none | none (backend only) |
| `audit_logs`, `login_attempts` | none | none | none (backend only) |

Writes to `bookings`, `booking_items`, `qr_tokens`, `checkins` happen **only**
through the `SECURITY DEFINER` Postgres functions, called with the service-role
key. Clients never get direct write access to a booking row.

---

## 4. Postgres function list (PL/pgSQL, called via `rpc()`)

| Function | Purpose |
|---|---|
| `create_booking(p_service_ids uuid[], p_employee_id uuid, p_start_time timestamptz, p_client_id uuid, p_guest jsonb, p_promo_code citext, p_actor uuid)` | Availability check → auto-assign qualified employee if null → insert booking + items + price snapshot → `SELECT … FOR UPDATE` the promo row → redemption → QR token → audit log. **One transaction.** Returns `{ bookingId, reference, totalCents, qrToken }`. |
| `cancel_booking(p_booking_id uuid, p_actor uuid, p_reason text)` | Guard the ≥2h window → set `CANCELLED` → revoke QR token → release promo redemption → audit. |
| `reschedule_booking(p_booking_id uuid, p_new_start timestamptz, p_actor uuid)` | Re-validate availability → revoke old token → issue new → audit. |
| `check_in_booking(p_jti uuid, p_staff_id uuid)` | Mark token used → `CONFIRMED`→`CHECKED_IN` → insert `checkins` → audit. Atomic. |
| `get_available_slots(p_service_id uuid, p_date date, p_employee_id uuid, p_interval_minutes int)` | Free start times from working hours − time off − existing bookings − service duration; drops slots overrunning closing time. |
| `validate_promo(p_code citext, p_client_id uuid, p_guest_phone citext, p_service_ids uuid[], p_subtotal_cents int)` | Returns discount or reason: `EXPIRED`, `NOT_STARTED`, `LIMIT_REACHED`, `MIN_SPEND_NOT_MET`, `NOT_APPLICABLE`, `INACTIVE`. |
| `get_dashboard_summary(p_from date, p_to date)` | Today's bookings / check-ins / no-shows, revenue by day-week-month, top services. Set-based, no Node loops. |
| `get_employee_performance(p_employee_id uuid, p_from date, p_to date)` | Completed bookings + revenue. |
| `enforce_booking_status_transition()` | Trigger — rejects invalid transitions at the DB level, not just in Node. |
| `set_updated_at()` | Trigger helper. |
| `handle_new_auth_user()` | Trigger on `auth.users` → creates the `profiles` row. |

**Double-booking defence** (belt and braces, per the spec):
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status NOT IN ('CANCELLED','NO_SHOW'));
```
Violation (SQLSTATE `23P01`) is mapped to **409 `SLOT_TAKEN`**. This holds even
if the Node layer has a bug.

---

## 5. Endpoint list

Auth legend: 🌐 public · 👤 CLIENT · 🧑‍🔧 STAFF · 🛡️ ADMIN

### Auth
| Method | Path | Role |
|---|---|---|
| POST | `/auth/register` | 🌐 |
| POST | `/auth/login` | 🌐 (rate-limited, 5 fails → 15 min lock) |
| POST | `/auth/refresh` | 🌐 |
| POST | `/auth/logout` | 👤🧑‍🔧🛡️ |
| GET | `/auth/me` | 👤🧑‍🔧🛡️ |
| POST | `/admin/users/staff` | 🛡️ (Supabase admin API) |

### Services
| Method | Path | Role |
|---|---|---|
| GET | `/services` | 🌐 |
| GET | `/services/search?q=` | 🌐 |
| GET | `/services/:id` | 🌐 |
| POST | `/services` | 🛡️ |
| PATCH | `/services/:id` | 🛡️ |
| DELETE | `/services/:id` | 🛡️ (soft) |

### Employees & availability
| Method | Path | Role |
|---|---|---|
| GET | `/employees` | 🌐 |
| GET | `/employees/:id` | 🌐 |
| POST | `/employees` | 🛡️ |
| PATCH | `/employees/:id` | 🛡️ |
| DELETE | `/employees/:id` | 🛡️ (soft) |
| PUT | `/employees/:id/services` | 🛡️ |
| PUT | `/employees/:id/working-hours` | 🛡️ |
| POST | `/employees/:id/time-off` | 🛡️ |
| GET | `/employees/:id/performance` | 🛡️ |
| GET | `/availability?serviceId=&date=&employeeId=` | 🌐 |

### Bookings
| Method | Path | Role |
|---|---|---|
| POST | `/bookings` | 🌐 (guest) / 👤 |
| GET | `/bookings/:id` | owner / 🧑‍🔧🛡️ |
| GET | `/me/bookings` | 👤 |
| POST | `/bookings/:id/cancel` | owner / 🛡️ |
| POST | `/bookings/:id/reschedule` | owner / 🛡️ |
| PATCH | `/bookings/:id/status` | 🧑‍🔧🛡️ (409 on invalid transition) |
| GET | `/bookings/:id/qr` | owner / 🧑‍🔧🛡️ |

### QR
| Method | Path | Role |
|---|---|---|
| GET | `/qr/branch` | 🛡️ |
| POST | `/qr/check-in` | 🧑‍🔧🛡️ |

### Promos
| Method | Path | Role |
|---|---|---|
| POST | `/promos/validate` | 🌐 |
| GET | `/promos` | 🛡️ |
| POST | `/promos` | 🛡️ |
| PATCH | `/promos/:id` | 🛡️ |
| DELETE | `/promos/:id` | 🛡️ (soft) |

### Admin
| Method | Path | Role |
|---|---|---|
| GET | `/admin/bookings` | 🛡️ |
| GET | `/admin/clients` | 🛡️ |
| GET | `/admin/clients/:id` | 🛡️ |
| PATCH | `/admin/clients/:id` | 🛡️ |
| DELETE | `/admin/clients/:id` | 🛡️ |
| GET | `/admin/clients/export.csv` | 🛡️ |
| GET | `/admin/employees` | 🛡️ |
| GET | `/admin/promos` | 🛡️ |
| GET | `/admin/dashboard` | 🛡️ |
| GET | `/admin/audit-logs` | 🛡️ |
| GET | `/health` | 🌐 |

All list endpoints: paginated, filterable, sortable.

---

## 6. Assumptions recorded

1. **Test target is cloud, not local** — no Docker (see §0). Biggest deviation.
2. Express hosted separately; Supabase is database + auth only. No Edge Functions.
3. Email + password auth. No phone/SMS (needs an SMS provider).
4. Branch timezone `Asia/Manila`; all stored timestamps `timestamptz` UTC.
5. Money in minor units (centavos), never floats.
6. QR uses **HMAC-SHA256 over a compact payload**, not a JWT — smaller payload, no JWT library, and `QR_SIGNING_SECRET` is independent of any Supabase secret.
7. Guest bookings are identified by `guest_phone`; they can be claimed later by a registered client with the same phone.
8. `PENDING` is the initial status for guest bookings until confirmed; staff/admin bookings start `CONFIRMED`.
9. Cancellation window default 2 hours before start, configurable via env.
10. The existing React console in this repo models `stylists`/`appointments` — a **different** domain from this spec's `employees`/`bookings`. It is left untouched and **not** wired to this backend; the spec is backend-only.

---

## 7. What I need from you

1. **Approval of this design** (or corrections).
2. **Supabase credentials** for the cloud project:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - (plus a second free project to serve as the test target, or your blessing to run tests against the first with a wiped schema between runs)

Until those land I can write all migrations, functions, RLS, source, tests and
docs — but I cannot apply migrations or run a single test, so nothing would be
verified.

---

## 8. Honest gaps in this plan

- **`supabase gen types typescript`** needs the CLI. I can install it via npm; if
  that fails on this network I will hand-write `src/types/database.ts` from the
  migrations and mark it as such.
- **Local parity is gone.** Constraint behaviour (`btree_gist` exclusion, RLS)
  is identical on cloud, but the spec's "never test against production" rule is
  satisfied only by using a *separate* project, not by a local instance.
- **Concurrency tests** (simultaneous bookings, simultaneous promo redemption)
  need two real connections racing. That works against cloud but is inherently
  flakier than against a local instance; I will make the tests deterministic
  with explicit transaction interleaving rather than sleep-based timing.

---

## 9. Changes made after approval

Recorded here rather than edited into the sections above, so the approved
baseline stays readable. Each of these is a deviation from what was signed off.

### 9.1 The database password replaced `supabase start` — and then the CLI

The `postgres` connection string was supplied, so migrations are applied by
`scripts/migrate.js` over the wire. `supabase start` is still impossible (no
Docker), but it is no longer the only route.

### 9.2 Migration 14: two functions re-granted to `anon`

**Not in the approved plan.** Migration 13 revokes `EXECUTE` on every function
from `anon`/`authenticated`, which is correct — but it also breaks the booking
flow, because availability and promo preview are needed *before* sign-in.

`get_available_slots` and `validate_promo` are re-granted. Both are `stable`,
write nothing, and return no personal data. Migration 14 self-asserts in both
directions: those two are reachable, and the four write functions plus
`get_dashboard_summary` are not.

### 9.3 Public reads no longer use the service role

**Better than the approved design, not just different.** §3 said the backend
reads through `service_role` and enforces access in the service layer. That
works, but it means the RLS policies are never actually exercised by the
running system — they protect direct client access only.

Changed so that:

- public catalogue, availability and promo preview go through the **publishable
  key**, so `services_public_read` / `employees_public_read` are what enforce
  "active only", not a `WHERE` clause someone could forget;
- `authenticate` reads the caller's profile with **the caller's own token**, so
  `profiles_select_own` applies. If a policy is loosened, the API inherits the
  mistake rather than silently bypassing it.

Writes and admin reporting still use the service role. This also means the
public half of the API runs with only the publishable key.

### 9.4 `src/types/database.ts` is hand-written

`supabase gen types typescript` needs the CLI. Rather than leave the client
untyped — where every `.select()` returns `any` and a renamed column is a
runtime 500 — the schema was transcribed by hand. Two consequences worth
knowing:

- Select strings are declared `as const`. supabase-js parses them at the *type*
  level; a concatenated string widens to `string`, the parse fails, and every
  row comes back as `GenericStringError`.
- The file must be updated whenever the schema changes. That is a real cost,
  paid deliberately.

### 9.5 Three bugs the tests found

1. **Unmapped errors lost their cause.** `toAppError`'s fallback returned a
   bare 500, discarding the original message — so the `errorHandler` comment
   claiming "the internal `cause` is always logged" was false. Fixed; caught by
   `unit/errors`.
2. **A malformed JSON body became a 500.** `express.json()` throws a
   `SyntaxError` carrying `status: 400`, which fell through to the 500
   fallback. A client typo was reported as a server fault. Now mapped to 400,
   with `entity.too.large` → 413.
3. **Role never landed on the profile.** GoTrue writes `app_metadata` in an
   `UPDATE` *after* the `INSERT` on `auth.users`, so the INSERT-only
   `handle_new_auth_user` trigger saw `{}` and defaulted every account to
   `CLIENT`. Migration 15 adds `role_from_app_metadata()`, an
   `AFTER UPDATE OF raw_app_meta_data` trigger, a backfill, and a self-check.

### 9.6 Migration 16: a real acceptance bug in the working-hours check

**The most important change after approval.** `create_booking` guarded working
hours with:

```sql
and (v_local_start::time + make_interval(mins => v_duration)) <= wh.end_time
```

The accompanying comment claimed an appointment crossing midnight "simply does
not fit, because `time` cannot exceed 24:00". **That is false.** Postgres takes
`time + interval` modulo 24 hours:

```
time '23:00' + interval '1 hour'  ->  00:00:00
```

so the comparison became `00:00:00 <= 18:00:00` → true. A 23:00 appointment was
accepted by a stylist whose shift ends at 18:00, while `get_available_slots`
correctly refused to *offer* it — the exact "the API trusts the UI to validate"
bug the check exists to prevent.

Fixed by comparing offsets from the start of the shift, which stay `interval`s
and cannot wrap:

```sql
and (v_local_start::time - wh.start_time) + make_interval(mins => v_duration)
    <= (wh.end_time - wh.start_time)
```

Migration 16 restates the whole function (dumped from `pg_get_functiondef`, so
it matches what was deployed rather than what a file once said) and self-asserts
three ways: the offset form rejects 23:00 + 60 min, the old form is shown to
accept it, and 10:00 + 60 min is still accepted.

### 9.7 Guest bookings are authorised by their uuid

§5 lists `/bookings/:id` as "owner / staff" without saying how a guest — who has
no account — proves ownership. Implemented as: staff, or the owning client, or
**anyone holding the uuid when `client_id is null`**.

A booking id is a v4 uuid generated server-side and returned only to its
creator, so it is a bearer capability in the same sense as a password-reset
link. The alternative is forcing guests to register, which the guest-booking
flow exists to avoid. The gate is `client_id is null`, not "the caller is
anonymous" — a booking that belongs to an account must never be readable from
the id alone, or one leaked link would expose a customer's name and phone.

### 9.8 The suite had to be sized to the hosted auth rate limit

The API validates tokens by asking GoTrue (`auth.getUser`) rather than verifying
the signature locally, so every fixture needs a real session: two requests to
the hosted auth service. The first fully-credentialed run created ~90 fixtures,
tripped GoTrue's `over_request_rate_limit`, and failed 7 tests with "Request
rate limit reached" — nothing to do with the code under test.

Two changes: `createTestAdmin` / `createTestClient` / `createTestStaff` are now
cached per suite (Jest gives each test file its own module registry, so the
cache is naturally suite-scoped), which cut fixture requests by roughly 80%; and
the harness retries a 429 with widening backoff while failing immediately on any
other error. `scripts/probe-ratelimit.js` measures the budget.

### 9.9 Test isolation

Suites share one database. Three collisions had to be designed out:

- **Cross-suite.** Every suite computed "in 4 days at 10:00", so two suites
  booked the *same* physical slot and the second got a 409 that had nothing to
  do with what it was testing. `tests/helpers/time.ts` now hands out a day-offset
  band per suite (`SLOT_BANDS`), claimed with `useSlotBand()`.
- **Within a suite.** The QR suite placed 60-minute bookings for one stylist 5
  minutes apart, which violates the EXCLUDE constraint; and the two
  cancellation-window tests both needed a booking ~30 minutes out. Both now
  clean up after themselves.
- **Shared promo capacity.** The "cancelling releases a redemption" test reused
  a promo whose entire global cap another test had already spent, so it passed
  or failed on declaration order. It now creates a code of its own.

### 9.10 Resolved: the service-role key

`SUPABASE_SERVICE_ROLE_KEY` was supplied, so the `503 CONFIG_ERROR` blocker is
gone and all 195 tests run. The suite is **195 passed / 195 total**, repeatably.

### 9.11 Two spellings of the same instant, and why the Jest suite could not see it

**Found by**: `scripts/smoke.js` — a live test against the *built artefact*,
added because the Jest suite runs `createApp()` in-process through Supertest and
would not notice a broken entry point, an unbound port, or a route mounted only
in the harness.

The first run failed one check: `/availability` returned
`2027-04-30T01:00:00+00:00` while `/bookings` returned `...Z` for the same kind
of field. Both are valid ISO-8601 and denote the same instant, but a client
cannot compare them as strings, and the API had been quietly emitting whichever
spelling the producing code path happened to use:

- a plain column read goes through PostgREST, which renders `timestamptz` with
  a numeric offset (`+00:00`);
- a PL/pgSQL function returning `jsonb` produces a value supabase-js
  re-serialises as `Z`.

`get_available_slots()` returns `jsonb`, `bookings` is read as a table — hence
the split. The fix is `src/lib/dates.ts`: every DTO timestamp is passed through
`iso()`, so the wire format is `Z` everywhere. Applied across `bookings`,
`employees`, `promos`, `services` and `admin` services. `checkIn()`'s
`checkedInAt` needed it separately, because it comes back from
`check_in_booking()` rather than from a DTO row.

**Why the suite missed it**: in-process, both spellings are produced by the same
serialiser, so nothing ever compared the two. It only became visible when a real
HTTP client read two endpoints and put the strings side by side. This is the
argument for keeping the smoke test: it is not redundant with the suite, it
covers a different failure mode.

#### `audit_logs.metadata` is the one deliberate exception

Section 6b of the smoke test scans every payload for the offset pattern. The
only surface that legitimately carries it is `audit_logs.metadata`, and that is
a decision rather than an oversight:

- the field is an untyped `jsonb` snapshot the *database* wrote — our functions
  build it with `jsonb_build_object(...)`, and `to_jsonb()` of a `timestamptz`
  renders with an offset, so a `booking.rescheduled` entry carries
  `"startTime": "...T04:00:00+00:00"`;
- an audit record that the application layer rewrites is no longer evidence, and
  the API's view of the trail should stay diffable against the table;
- recursively rewriting every string in an untyped blob that *looks* like an ISO
  timestamp is a heuristic, and it would corrupt any legitimate string value
  that happens to match — a `reason`, a note, a reference.

So the invariant is scoped: **typed DTO fields are normalised**. The smoke test
asserts both halves — the audit row's own typed fields are `Z`-suffixed, *and*
the snapshot still arrives in its original database spelling. Exempting a field
without asserting the exemption is how an exemption rots into a bug.

The alternative — normalising metadata on the write side with a cast — was
rejected because it would change the stored record and would not fix the rows
already written.

### 9.12 Migration 16 exposed a latent flakiness bug in `verify.js`

Fixing the `time ± interval` wrap in migration 16 made the working-hours check
*correct*, which immediately broke `npm run db:verify` — an uncaught
`OUTSIDE_WORKING_HOURS` in section 4. The harness was at fault, not the schema,
and the reason is worth recording because it is the same trap migration 16 was
about.

`verify.js` opens every employee 00:00–23:59 on all seven days and then derives
later slots by adding offsets to one base time:

```js
const START = date_trunc('hour', now()) + interval '2 days';
const cancelStart = START + 12h;   // section 4
// …+4h, +5h, +8h, +10h, +20h elsewhere
```

Anchoring on `now()` makes every derived slot depend on **what time of day the
harness runs**. Run at 03:00 UTC, `START` is 11:00 Manila and `cancelStart` is
23:00 Manila — and the section-4 service is 90 minutes, so the booking ends at
00:30, past the 23:59 close of the shift. Verified directly against the
database: `cancelStart local: 23:00:00`, naive end `00:00:00`.

Before migration 16 that was silently *accepted*, because `time + interval`
wraps: `23:00 + 1h = 00:00`, and `00:00 <= 23:59`. The buggy check was the only
reason the buggy harness passed. Six of the twenty-four UTC hours failed this
way — roughly a one-in-four flake, which is exactly the kind of thing that gets
dismissed as "the database was slow" instead of diagnosed.

The fix is to anchor the base at a fixed local hour rather than the current one:

```sql
(date_trunc('day', now() at time zone 'Asia/Manila')
   + interval '2 days' + interval '1 hour') at time zone 'Asia/Manila'
```

That is always 01:00 Manila. The largest offset in the harness is +20h, giving
21:00, and +90min is 22:30 — clear of 23:59 with room to spare, and no slot
crosses midnight. Proved by simulation rather than assumed: all 25 hour-marks in
a day were fed through the expression and every one anchored to 01:00.

The general lesson, and the reason this belongs next to §9.6: **a test harness
that depends on the wall clock is a harness that fails at 03:00 and passes at
09:00.** The full-width 00:00–23:59 window looked like it made the harness
time-of-day independent, but a window is only half of it — the other half is
where you start inside it.

### 9.13 The root was a dead end; it now serves a service index

Reported by the user, with a screenshot of a browser at `127.0.0.1:4000/`:

```
{"error":{"code":"NOT_FOUND","message":"No route matches GET /"}}
```

Nothing was broken. This is a backend-only service with no HTML surface, so
`/` had no route and fell through to `notFoundHandler`. But a bare `NOT_FOUND`
in a browser reads as "the service is broken", and that is a real usability
defect regardless of whose fault the misreading is — the person looking at it
has no way to tell a healthy API from a dead one.

Two candidate fixes were considered and one rejected:

- **Rejected: serve an HTML landing page.** The brief is explicit — no
  frontend, no UI. A landing page would put a browser-facing surface on a
  service that is not meant to have one, and would misrepresent it as a
  website. It also invites the next request to be "add a form here".
- **Chosen: serve a JSON index** at both `/` and `/api/v1`. Service discovery
  is a backend concern; it simply happens to be legible in a browser. It
  answers the three questions a caller actually has — is it up, where is the
  API, what can I call — with no source reading required.

The index (`src/lib/apiIndex.ts`) lists all 50 endpoints grouped by module,
each with its method, its auth requirement (`public` / `optional` /
`authenticated` / `STAFF/ADMIN` / `ADMIN`) and a one-line description, plus
where `/health` lives, the error envelope, and an explicit sentence saying
there is no HTML page at any address.

#### The trade-off, and how it is held

The list is hand-written rather than derived from the Express router stack.
Deriving it would make drift impossible, but it would also produce a bare list
of paths — it could not say *what each endpoint needs*, which is the question
the index exists to answer. Descriptions and auth annotations are worth more
than derivation.

The cost is drift, so drift is tested instead. `tests/unit/apiIndex.test.ts`
calls every documented path and fails if the response is the router-level
`No route matches …`. The discriminator matters: a 400, a 401, a 403, or a
*resource-level* 404 (`SERVICE_NOT_FOUND`) all prove the route is mounted,
because only `notFoundHandler` emits that particular message. So the check
needs no credentials and does not care whether the call succeeds.

The test was verified to actually fail — a phantom route was temporarily added
and the suite went red with
`No route matches GET /api/v1/definitely-not-a-real-route` — because a guard
that cannot fail is not a guard.

**Add a route without adding it to the index and the index is merely
incomplete. Add one to the index that does not exist and the test fails.**

