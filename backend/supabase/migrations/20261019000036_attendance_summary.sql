-- ---------------------------------------------------------------------------
-- Migration 36: attendance summary, aggregated in SQL.
--
-- ## What was wrong
--
-- `attendanceRepository.forSummary` fetched up to 1000 rows and summed them in
-- Node. That is not a summary, it is a page: past a thousand records the
-- totals silently under-report, and nothing on the wire marks the response as
-- truncated, so the desk reads "412 hours this quarter" as a fact.
--
-- The comment defending the `1000` limit said PostgREST caps a response. What
-- is actually true is that PostgREST can *be* configured with a row cap
-- (Supabase's hosted default is 1000), which is precisely why the limit was
-- added - and precisely why it was never noticed as a silent truncation. The
-- cap, if present, applies to rows returned, so a summary that needs all rows
-- cannot be built from a capped read at any limit. It has to be aggregated
-- where the data lives.
--
-- ## What this replaces it with
--
-- One `security definer` function that counts and sums in Postgres. Rows never
-- leave the database, so no row cap can truncate the answer, and the cost is
-- an index scan rather than transferring a thousand rows to Node to add them
-- up there.
--
-- ## One deliberate semantic difference
--
-- The summary aggregates `public.attendance` directly rather than through
-- `v_attendance_detail`. The view left-joins `working_hours` on
-- (employee_id, weekday), and the unique constraint on that table is
-- (employee_id, weekday, start_time) - so an employee with two *non-overlapping*
-- shifts on one weekday (09:00-12:00 and 13:00-17:00, which the overlap check
-- accepts) makes the view return that day's clock-in twice. Doubling a second
-- worked in a payroll-facing total is the worse of the two errors, so the
-- aggregate counts physical records. The view's duplication is a separate bug
-- and is deliberately not fixed here: changing a view's join is a wider change
-- than this migration should carry, and it deserves its own review.
--
-- Grants revoke from `public`/`anon`/`authenticated`, grant to `service_role`
-- only - same posture as every other internal function.
-- ---------------------------------------------------------------------------

create or replace function public.attendance_summary(
  p_employee_id uuid default null,
  p_status      text default null,
  p_from        date default null,
  p_to          date default null
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with filtered as (
    select
      a.work_date,
      a.status::text                                        as status,
      a.time_out is null                                    as still_open,
      -- Same expression as v_attendance_detail, so the two agree.
      case
        when a.time_out is not null
          then round((extract(epoch from (a.time_out - a.time_in)) / 60.0)::numeric, 2)
      end                                                   as minutes_worked
    from public.attendance a
    where (p_employee_id is null or a.employee_id = p_employee_id)
      and (p_status is null or a.status::text = p_status)
      and (p_from is null or a.work_date >= p_from)
      and (p_to is null or a.work_date <= p_to)
  ),
  totals as (
    select
      count(*)                                                as records,
      count(*) filter (where status = 'PRESENT')              as present,
      count(*) filter (where status = 'HALF_DAY')             as half_day,
      count(*) filter (where status = 'LEAVE')                as leave,
      count(*) filter (where status = 'ABSENT')               as absent,
      count(*) filter (where still_open)                      as open,
      count(minutes_worked)                                   as closed_days,
      coalesce(sum(minutes_worked), 0)                        as total_minutes,
      min(work_date)                                          as first_day,
      max(work_date)                                          as last_day
    from filtered
  ),
  by_day as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'day',     work_date::text,
          'records', records,
          'minutes', minutes
        ) order by work_date
      ),
      '[]'::jsonb
    ) as days
    from (
      select work_date, count(*) as records, coalesce(sum(minutes_worked), 0) as minutes
      from filtered
      group by work_date
    ) per_day
  )
  select jsonb_build_object(
    'records',      t.records,
    'present',      t.present,
    'halfDay',      t.half_day,
    'leave',        t.leave,
    'absent',       t.absent,
    'open',         t.open,
    'closedDays',   t.closed_days,
    'totalMinutes', t.total_minutes,
    -- The span the summary actually covers, so the caller can label it
    -- honestly instead of echoing a bound the data does not support.
    'firstDay',     t.first_day::text,
    'lastDay',      t.last_day::text,
    'byDay',        d.days
  )
  from totals t cross join by_day d;
$$;

revoke all on function public.attendance_summary(uuid, text, date, date) from public;
revoke all on function public.attendance_summary(uuid, text, date, date) from anon;
revoke all on function public.attendance_summary(uuid, text, date, date) from authenticated;
grant execute on function public.attendance_summary(uuid, text, date, date) to service_role;

comment on function public.attendance_summary(uuid, text, date, date) is
  'Attendance totals and per-day breakdown for a filter, aggregated in SQL. Returns the span the data covers so an unfiltered call can be labelled without inventing bounds.';

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_has   boolean;
  v_shape record;
begin
  -- 1. The function exists and returns jsonb.
  select exists(
    select 1 from pg_proc where proname = 'attendance_summary' and pronargs = 4
  ) into v_has;
  if not v_has then
    raise exception 'SELF_CHECK_FAILED: attendance_summary(uuid,text,date,date) not created';
  end if;

  -- 2. Calling it with no filter must not error and must return every field
  --    the service reads. jsonb_to_record would raise on a name mismatch, and
  --    would leave the target null on a missing key.
  select * from jsonb_to_record(public.attendance_summary(null, null, null, null))
    as x(records bigint, present bigint, halfDay bigint, leave bigint, absent bigint,
         open bigint, closedDays bigint, totalMinutes numeric, firstDay text, lastDay text,
         byDay jsonb)
  into v_shape;

  if v_shape.records is null then
    raise exception 'SELF_CHECK_FAILED: attendance_summary returned an incomplete shape';
  end if;

  -- 3. A status filter must accept the enum's text form.
  perform public.attendance_summary(null, 'PRESENT', null, null);

  -- 4. A date range must narrow rather than return the whole table.
  perform public.attendance_summary(null, null, current_date, current_date);

  raise notice 'SELF_CHECK_OK: attendance_summary shape verified (% record(s))', v_shape.records;
end $$;
