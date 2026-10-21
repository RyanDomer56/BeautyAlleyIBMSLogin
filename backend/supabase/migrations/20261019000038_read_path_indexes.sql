-- ---------------------------------------------------------------------------
-- Migration 38: indexes for the filters and sorts the API actually issues.
--
-- The plan for this pass named six: clients(phone), clients(email),
-- audit_logs(action), audit_logs(actor_id), attendance(work_date) and
-- employees(full_name). Five are added here. `clients(email)` is deliberately
-- **not**, and the reason is the point of this header.
--
-- ## Why clients(email) is not here
--
-- A btree index can serve `col = 'x'` and `col LIKE 'x%'`. It cannot serve
-- `col LIKE '%x%'`, because there is no prefix to seek to - the planner would
-- have to read every row anyway, so it correctly ignores the index. The only
-- query that touches `clients.email` is the admin search:
--
--     email.ilike.%<term>%
--
-- so an index on it would be write cost and disk for zero reads. The tool that
-- *would* accelerate it is a trigram GIN index (`pg_trgm` is available on this
-- database), and that is not added either: the clients table is a few hundred
-- rows, a sequential scan is already the cheaper plan, and adding a GIN index
-- now would be a guess about a future size. It is worth adding when the desk
-- search becomes slow, not before.
--
-- `clients.phone` is a different case and *is* added: `loyaltyRepository.byPhone`
-- looks a client up by exact phone at the desk, and `phone` is `citext`, so an
-- equality lookup is exactly what a btree is for.
--
-- ## Why audit_logs gets composite indexes
--
-- `listAuditLogs` filters on `action` or `actor_id` and always orders by
-- `created_at desc`. A single-column index would find the matching rows and
-- then sort them; `(action, created_at desc)` finds them already in order. The
-- difference matters because the endpoint is paginated - the sort is bounded by
-- the page, but the scan is not.
--
-- ## Why attendance(work_date) is needed at all
--
-- Both existing indexes lead with `employee_id`, so a date-only filter (the
-- admin view of everybody's attendance) cannot use either of them. The summary
-- now aggregates in SQL over exactly that filter, which makes it hotter.
-- ---------------------------------------------------------------------------

-- The desk's phone lookup. `citext` compares case-insensitively, so this also
-- serves a phone typed with different spacing only if the caller normalises -
-- which `byPhone` does by trimming.
create index if not exists clients_phone_idx
  on public.clients (phone);

-- Audit filtering, each matching the page's ORDER BY so no sort is needed.
create index if not exists audit_logs_action_created_idx
  on public.audit_logs (action, created_at desc);

create index if not exists audit_logs_actor_created_idx
  on public.audit_logs (actor_id, created_at desc);

-- A date-only range, which neither existing index can serve.
create index if not exists attendance_work_date_idx
  on public.attendance (work_date);

-- The default sort of the employee list, so the page does not sort every time.
create index if not exists employees_full_name_idx
  on public.employees (full_name);

comment on index public.clients_phone_idx is
  'Equality lookup by phone at the desk (loyaltyRepository.byPhone). Not a trigram index: phone is never searched infix.';
comment on index public.audit_logs_action_created_idx is
  'Audit log filtered by action, ordered newest first - the composite avoids a sort.';
comment on index public.audit_logs_actor_created_idx is
  'Audit log filtered by actor, ordered newest first.';
comment on index public.attendance_work_date_idx is
  'Date-only attendance ranges. The other indexes lead with employee_id and cannot serve these.';
comment on index public.employees_full_name_idx is
  'The employee list sorts by full_name by default.';

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  select string_agg(want, ', ') into missing
  from unnest(array[
    'clients_phone_idx',
    'audit_logs_action_created_idx',
    'audit_logs_actor_created_idx',
    'attendance_work_date_idx',
    'employees_full_name_idx'
  ]) as want
  where not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = want
  );

  if missing is not null then
    raise exception 'SELF_CHECK_FAILED: index(es) not created: %', missing;
  end if;

  -- The trigram index is absent on purpose; if someone adds it later this
  -- notice is a reminder that the comment above is now out of date.
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexdef ilike '%gin_trgm_ops%') then
    raise notice 'NOTE: a trigram index now exists - the header of migration 38 is stale.';
  end if;

  raise notice 'SELF_CHECK_OK: five indexes present, clients(email) intentionally omitted';
end $$;
