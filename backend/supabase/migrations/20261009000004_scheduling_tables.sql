-- ===========================================================================
-- 04_scheduling_tables.sql
-- employee_services, working_hours, time_off
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- employee_services - which employee is qualified to deliver which service.
-- Drives auto-assignment and slot availability.
-- ---------------------------------------------------------------------------
create table if not exists public.employee_services (
  employee_id uuid not null references public.employees (id) on delete cascade,
  service_id  uuid not null references public.services (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (employee_id, service_id)
);

create index if not exists employee_services_service_idx
  on public.employee_services (service_id);

-- ---------------------------------------------------------------------------
-- working_hours - recurring weekly availability, expressed in BRANCH LOCAL
-- TIME. These are wall-clock times, not instants, so `time` (not timestamptz)
-- is correct: the 09:00 shift does not shift when DST does.
-- weekday: 0 = Sunday ... 6 = Saturday (matches Postgres extract(dow)).
-- ---------------------------------------------------------------------------
create table if not exists public.working_hours (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  start_time  time not null,
  end_time    time not null,
  created_at  timestamptz not null default now(),
  constraint working_hours_order check (end_time > start_time),
  constraint working_hours_unique unique (employee_id, weekday, start_time)
);

create index if not exists working_hours_employee_idx
  on public.working_hours (employee_id, weekday);

-- ---------------------------------------------------------------------------
-- time_off - one-off absences (leave, training, sick). These ARE instants, so
-- timestamptz. A booking that overlaps one of these ranges is invalid.
-- ---------------------------------------------------------------------------
create table if not exists public.time_off (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text,
  created_at  timestamptz not null default now(),
  constraint time_off_order check (ends_at > starts_at)
);

create index if not exists time_off_employee_range_idx
  on public.time_off using gist (employee_id, tstzrange(starts_at, ends_at));
