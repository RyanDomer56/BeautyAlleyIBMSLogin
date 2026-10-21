# Operations runbook

For a staff pilot: one salon, one database, a handful of users. This is the
minimum needed to run it without surprises, not a corporate SRE manual.

---

## Environments

| Environment | API | Frontend | Database |
|---|---|---|---|
| Local development | `localhost:4000` | `localhost:5173` (Vite) | Supabase project |
| Pilot | Vercel service, `/api/*` | Vercel service, same project | same Supabase project |

There is no staging environment. For a pilot that is a deliberate trade: a
second Supabase project costs money and drifts. The consequence is that **the
database is the production database**, which is why the backup section below is
not optional.

---

## Deploying

One Vercel project. [`vercel.json`](../vercel.json) keeps the Vite frontend at
the repository root and exposes the Express API as one function,
[`api/index.js`](../api/index.js), which loads the app compiled to
`backend/dist`; `/api/*` and both health endpoints are rewritten to it. The
browser sees one origin, so `VITE_API_URL` is never set and CORS never fires in
the browser.

The API is not built by a framework preset: the project's build command compiles
both halves (`npm run build && cd backend && npm ci && npm run build`). It was
two **services** in this project until every `/api/*` request started answering
a bare `FUNCTION_INVOCATION_FAILED` — the service built, but never produced an
invocable function, whatever the entry exported.

Two variables decide which shape you are running:

| Variable | Vercel | Single container |
|---|---|---|
| `SERVE_APP` | **unset** — the frontend is served by the same project | `true` |
| `ALLOWED_ORIGINS` | **required** — the production boot guard | optional |

The API refuses to boot in production with neither, so on Vercel
`ALLOWED_ORIGINS` is not decoration: set it to `https://<project>.vercel.app`
(plus any preview hostnames you actually use).

The container is the alternative for a self-hosted API:

```bash
docker build -t beauty-alley .
docker run --env-file backend/.env.local -e SERVE_APP=true -p 4000:4000 beauty-alley
```

On Fly.io or Railway, point the platform at this `Dockerfile`, expose port
**4000**, set the health check to **`/health/live`**, and provide the
environment variables below as platform secrets.

### First deploy, in order

1. `cd backend && npm run db:migrate` against the pilot database.
   **Never `db:seed`** here: it truncates 17 tables and is blocked under
   `NODE_ENV=production`.
2. Set the environment variables, then deploy.
3. `GET /health` must return 200, not 503.
4. `/` renders the public site.
5. `/login` signs in, and `/app` renders for that role.
6. Book one appointment end to end and scan its pass, before handing the URL to
   the salon.

### Required environment variables

| Variable | Secret? | Notes |
|---|---|---|
| `SUPABASE_URL` | no | project URL |
| `SUPABASE_ANON_KEY` | no | public by design; shipped to browsers |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | bypasses RLS — treat as a master key |
| `QR_SIGNING_SECRET` | **yes** | rotating it invalidates every outstanding pass |
| `DATABASE_URL` | **yes** | contains the database password |
| `ALLOWED_ORIGINS` | no | required on Vercel; not needed when `SERVE_APP=true` |
| `SERVE_APP` | no | `true` for the container; leave unset on Vercel |
| `BRANCH_TIMEZONE` | no | `Asia/Manila` |

The API **refuses to boot** in production with an empty `ALLOWED_ORIGINS` and
`SERVE_APP` off. That is intentional: the alternative is reflecting any origin
with credentials.

### When every API path answers 500

`/` can render perfectly while `/health` and `/api/*` both fail: the frontend
is static files, the API is a function, and only the function can be broken.
Two failures look alike in a browser and mean different things:

| Response body | Meaning | Fix |
|---|---|---|
| `{"error":{"code":"BACKEND_INIT_FAILED","message":"…"}}` | the function started and named the problem — a missing variable, or `api/index.js` could not load the compiled app | read the message; it names the variable or the missing file |
| plain text `FUNCTION_INVOCATION_FAILED`, `x-vercel-error` header | the function died before it could answer: a module-scope throw, or no invocable function at all | Runtime Logs; the first stack frame names the module |

The `x-request-id` response header is the tell between the two: the app sets it
before any route runs, so its absence means the app never started. If the body
is the platform's own 500 *and* that header is missing on every path, the
function is not running this code at all — check that the deployment's build
command finished (a failed build keeps the previous, equally broken deployment
live), then the Runtime Logs.

This deployment spent a day in exactly that state while the API was declared as
a second **service**: the service built, the entry exported the app correctly,
and every request still answered the platform's 500. Moving the API to a plain
function at `api/index.js` — which loads `backend/dist` and reports why if it
cannot — is what made the API reachable.

`npx vercel env ls production` lists what the project actually has, which is
the fastest way to spot a key that was added to `.env` locally but never to
Vercel.

---

## Health

| Endpoint | Meaning | Use for |
|---|---|---|
| `/health/live` | process is up; no I/O | container health check / restart policy |
| `/health` | database + GoTrue reachable, plus version | routing decision, dashboards |

`/health` returns `503` when either dependency is down. Do not point a restart
policy at it — a slow database would cause a restart loop that fixes nothing.

Every response carries `x-request-id`, and every log line includes it. When
someone reports a failure, ask for that id.

---

## Backups

```bash
cd backend
npm run db:backup            # writes backend/backups/<db>-<timestamp>.<ext>
```

`pg_dump` is used when it is installed; otherwise the script falls back to a JSON
snapshot (all rows in `public`, with row counts). **The JSON fallback is a safety
net, not a substitute** — install the PostgreSQL client and set `PG_DUMP` for a
real dump before relying on this.

Copy backups off the machine. A backup on the same disk as the database is not a
backup.

### Restore drill

```bash
cd backend
npm run db:restore -- backups/<file>.json --yes
```

Refuses without `--yes`. For a JSON snapshot it truncates and refills every table
in the file, inside one transaction, with FK triggers suspended and sequences
re-synced afterwards; then it compares row counts to the snapshot.

**Measured on 2026-10-19:** 21 tables, 417 rows, restored in **6 seconds**, counts
verified, demo logins still working afterwards. Re-run this drill quarterly —
a backup that has never been restored is a guess.

---

## Migrations

```bash
cd backend
npm run db:status     # applied / pending / changed
npm run db:plan       # validate + list what WOULD apply, change nothing
npm run db:migrate    # apply
```

- Each file runs in its own transaction.
- Applied migrations are **immutable**: editing one is detected by checksum and
  blocks the run.
- A session advisory lock prevents two runners from interleaving.
- **Rollback is forward-only.** There are no down-migrations. The recovery path
  is: restore the latest backup, then fix forward.

`--reset --yes` drops schema `public` entirely. It exists for local rebuilds and
should never be run against the pilot database.

---

## Destructive scripts

`npm run db:seed` TRUNCATEs 17 tables. It refuses unless one of these is true:

- `ALLOW_DESTRUCTIVE_SEED=1` is set in `backend/.env.local`, or
- the run passes `--force`, or
- the caller is a program that passes `confirmed: true`.

It refuses outright under `NODE_ENV=production`. `npm test` calls the same seed,
so this guard covers the test suite too.

---

## Incidents

1. **Get the request id** from the user or the response header.
2. **Check `/health`** — it separates database from auth failure.
3. **Read the logs** — one JSON object per line. Failures are `warn`/`error` and
   always logged; successful requests are `info` in production.
4. **If data is wrong**, stop writes before restoring. A restore taken during
   active writes loses the writes after the snapshot.

Process crashes are logged as `process.uncaughtException` /
`process.unhandledRejection` before the process exits non-zero. If you see those,
the cause is in the preceding log lines, not the crash itself.

---

## Secret rotation

Rotate in this order:

1. `SUPABASE_SERVICE_ROLE_KEY`, database password, `SUPABASE_ANON_KEY` — in the
   Supabase dashboard.
2. Redeploy with the new values.
3. `QR_SIGNING_SECRET` **last**, and deliberately: it invalidates every
   outstanding arrival pass, so guests holding a printed pass will need a new one.

Rotating the Supabase JWT secret additionally invalidates every signed-in session.
