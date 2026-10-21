-- ---------------------------------------------------------------------------
-- Migration 29: employee attendance.
--
-- Replaces the "CR" placeholder on the employee dashboard with a real
-- time-in / time-out record. Three things the brief asks for shape the design:
--
--   * "Record the current date and time automatically." The server writes the
--     timestamps, never the client. A browser clock is not evidence, and a
--     time-in the employee can choose is not a time-in.
--
--   * "Prevent duplicate time-in records for the same active work session."
--     Enforced by a UNIQUE constraint rather than by a read-then-write check,
--     because two taps on a slow connection are exactly the case a check in
--     application code loses. The constraint is the arbiter; the API turns
--     23505 into a 409.
--
--   * "Calculate total hours worked." Derived on read from the two timestamps.
--     A stored total would be a third source of truth that can disagree with
--     the two it is computed from, and would need correcting every time a
--     time-out is amended. It is computed in the view below, once.
--
-- ## Why `work_date` is a column and not `time_in::date`
--
-- "Today" is the branch's local day. At 09:00 in Manila it is still the
-- previous day in UTC, so a UTC-derived date would file the morning shift
-- under yesterday - the same trap migration 26 documents for the quota. The
-- column is filled from the branch timezone and is what the unique constraint
-- keys on, so one shift per local day is the rule everywhere.
--
-- ## Late and absent are NOT inferred
--
-- The brief is explicit: do not automatically mark employees late or absent.
-- So `status` defaults to PRESENT when someone clocks in and is otherwise set
-- by a human. `minutes_late` is *reported* when the employee has a shift
-- configured for that weekday, and is NULL when they do not - it is an
-- observation against a configured rule, never a verdict invented from nothing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Status.
--
-- A fresh type, so `create type` is fine inside this migration's transaction.
-- (It is `alter type ... add value` that cannot be *used* in the transaction
-- that adds it, which is why nothing here needs splitting into two files.)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'attendance_status') then
    create type public.attendance_status as enum ('PRESENT', 'HALF_DAY', 'LEAVE', 'ABSENT');
  end if;
end $$;

comment on type public.attendance_status is
  'How a work day was spent. PRESENT is the default on clock-in; the others are set by a human, never inferred.';

-- ---------------------------------------------------------------------------
-- 2. The table.
-- ---------------------------------------------------------------------------
create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  work_date   date not null default ((now() at time zone public.branch_timezone())::date),
  time_in     timestamptz not null default now(),
  time_out    timestamptz,
  status      public.attendance_status not null default 'PRESENT',
  remarks     text,
  -- Who wrote it down. Equal to the employee's own profile for a self-service
  -- clock-in; different when the desk back-fills a shift.
  recorded_by uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One work session per local day. This is the constraint that makes a double
  -- tap a 409 instead of a second row.
  constraint attendance_one_session_per_day unique (employee_id, work_date),
  -- A time-out before its time-in is not a short shift, it is a bug.
  constraint attendance_time_order check (time_out is null or time_out > time_in),
  constraint attendance_remarks_len check (remarks is null or length(remarks) <= 1000)
);

comment on table public.attendance is
  'One row per employee per local work day. time_in is written by the server; time_out closes the session. Total hours are derived, never stored.';

create index if not exists attendance_employee_day_idx
  on public.attendance (employee_id, work_date desc);

drop trigger if exists trg_attendance_updated_at on public.attendance;
create trigger trg_attendance_updated_at
  before update on public.attendance
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. The read view.
--
-- Everything the attendance table cannot say on its own: the employee's name,
-- the shift they were rostered for that weekday, the hours actually worked and
-- how far past the rostered start they clocked in. Computed once, here, so the
-- employee's own page and the admin's report cannot disagree.
-- ---------------------------------------------------------------------------
create or replace view public.v_attendance_detail as
select
  a.id,
  a.employee_id,
  e.full_name                                            as employee_name,
  a.work_date,
  a.time_in,
  a.time_out,
  a.status,
  a.remarks,
  a.recorded_by,
  wh.start_time                                          as scheduled_start,
  wh.end_time                                            as scheduled_end,
  -- NULL until the session is closed: "0.0 hours so far" and "not finished"
  -- are different answers and the UI renders them differently.
  case
    when a.time_out is not null
      then round((extract(epoch from (a.time_out - a.time_in)) / 60.0)::numeric, 2)
  end                                                    as minutes_worked,
  case
    when a.time_in is not null and wh.start_time is not null
      then greatest(
             floor(
               extract(epoch from (
                 (a.time_in at time zone public.branch_timezone())::time - wh.start_time
               )) / 60.0
             ),
             0
           )::integer
  end                                                    as minutes_late,
  a.created_at,
  a.updated_at
from public.attendance a
join public.employees e on e.id = a.employee_id
-- `extract(dow ...)` is 0=Sunday..6=Saturday, which is what working_hours.weekday
-- uses. A left join, so a day with no rota still returns the record.
left join public.working_hours wh
  on wh.employee_id = a.employee_id
 and wh.weekday = extract(dow from a.work_date)::smallint;

comment on view public.v_attendance_detail is
  'Attendance joined to the employee and that weekday''s shift, with hours worked and minutes late derived.';

-- ---------------------------------------------------------------------------
-- 4. Locking it down.
--
-- RLS on, and NO grants to anon or authenticated. Attendance is read through
-- the API, which applies the role rules; a browser holding the publishable key
-- has no business reading the roster's clock-in times. Same posture as
-- `audit_logs` and `booking_counters`.
-- ---------------------------------------------------------------------------
alter table public.attendance enable row level security;

revoke all on public.attendance from anon, authenticated;
grant all on public.attendance to service_role;

-- The view runs with the definer's rights unless `security_invoker` is set, so
-- it is explicitly made invoker-safe: it must not become a hole through which
-- anon reads a table it has no grant on.
alter view public.v_attendance_detail set (security_invoker = on);
revoke all on public.v_attendance_detail from anon, authenticated;
grant select on public.v_attendance_detail to service_role;

-- ---------------------------------------------------------------------------
-- 5. Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  if not exists (select 1 from pg_type where typname = 'attendance_status') then
    raise exception 'migration 29: attendance_status type was not created';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.attendance'::regclass
       and conname = 'attendance_one_session_per_day'
  ) then
    raise exception 'migration 29: the one-session-per-day constraint is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.attendance'::regclass
       and conname = 'attendance_time_order'
  ) then
    raise exception 'migration 29: the time-order constraint is missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.attendance'::regclass) then
    raise exception 'migration 29: RLS is not enabled on attendance';
  end if;

  -- The whole point of the posture above: a browser cannot read the roster.
  if has_table_privilege('anon', 'public.attendance', 'SELECT')
     or has_table_privilege('authenticated', 'public.attendance', 'SELECT') then
    raise exception 'migration 29: attendance is readable by anon/authenticated';
  end if;

  -- And the view must not be a way around that.
  if has_table_privilege('anon', 'public.v_attendance_detail', 'SELECT')
     or has_table_privilege('authenticated', 'public.v_attendance_detail', 'SELECT') then
    raise exception 'migration 29: v_attendance_detail is readable by anon/authenticated';
  end if;

  if not exists (select 1 from pg_views where schemaname = 'public' and viewname = 'v_attendance_detail') then
    raise exception 'migration 29: v_attendance_detail was not created';
  end if;
end $$;

-- Behavioural check: the unique constraint must actually refuse a second
-- clock-in for the same employee and day. Rolled back, so nothing is left
-- behind even though it writes.
do $$
declare
  v_employee uuid;
  v_day      date := date '2020-01-06';  -- a Monday, long past, in nobody's way
  v_first    uuid;
begin
  select id into v_employee from public.employees where is_active order by id limit 1;
  if v_employee is null then
    raise notice 'migration 29: no active employees - skipping the behavioural check';
    return;
  end if;

  begin
    insert into public.attendance (employee_id, work_date, time_in)
    values (v_employee, v_day, now() - interval '8 hours')
    returning id into v_first;

    -- Same employee, same day: must be refused.
    begin
      insert into public.attendance (employee_id, work_date, time_in)
      values (v_employee, v_day, now());
      raise exception 'migration 29: a duplicate clock-in was accepted';
    exception
      when unique_violation then null;  -- the expected outcome
    end;

    -- A time-out before the time-in must be refused too.
    begin
      update public.attendance set time_out = time_in - interval '1 minute' where id = v_first;
      raise exception 'migration 29: a time-out before the time-in was accepted';
    exception
      when check_violation then null;  -- the expected outcome
    end;

    -- The view must derive the hours from the two stamps.
    update public.attendance
       set time_out = time_in + interval '7 hours 30 minutes'
     where id = v_first;

    if (select minutes_worked from public.v_attendance_detail where id = v_first) <> 450 then
      raise exception 'migration 29: the view reported % minutes, expected 450',
        (select minutes_worked from public.v_attendance_detail where id = v_first);
    end if;

    raise exception 'ROLLBACK_ATTENDANCE_PROBE';
  exception
    when others then
      if sqlerrm = 'ROLLBACK_ATTENDANCE_PROBE' then
        raise notice 'migration 29: behavioural check passed';
      else
        raise;
      end if;
  end;
end $$;
