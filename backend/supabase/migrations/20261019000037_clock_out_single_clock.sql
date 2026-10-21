-- ---------------------------------------------------------------------------
-- Migration 37: stamp time_out on the database clock, not the app's.
--
-- ## The bug
--
-- `attendanceRepository.clockOut` sent `time_out: new Date().toISOString()` -
-- the Node process's clock - while `clockIn` inserts no `time_in` at all and
-- lets the column default (`now()`) fill it, which is the *database* clock.
--
-- Two clocks, one CHECK constraint:
--
--   constraint attendance_time_order check (time_out is null or time_out > time_in)
--
-- Measured on this deployment the database runs ~500 ms ahead of the app host.
-- So an employee who taps "Time out" less than half a second after "Time in"
-- sent a time_out that was *earlier* than the stored time_in, the constraint
-- fired (SQLSTATE 23514), and the API reported 400 VALIDATION_FAILED. A retry a
-- second later succeeded, which is why it looked like flakiness rather than a
-- bug: the failure window is exactly the size of the clock skew.
--
-- It is not a test artefact. A real double tap on a slow phone hits it, and it
-- gets worse the further apart the app host and the database are - which is
-- precisely the deployment this is heading for.
--
-- ## The fix
--
-- One clock. `clock_out_attendance` stamps `time_out` with `clock_timestamp()`
-- inside the database, so both ends of the session come from the same clock and
-- the comparison is between two values that mean the same thing.
--
-- `clock_timestamp()` rather than `now()`: `now()` is the transaction start,
-- and the useful fact here is when the row was actually closed. Both are on the
-- database clock, so either would fix the bug; this one is simply more accurate.
--
-- The `time_out is null` predicate stays in the UPDATE, so closing an already
-- closed session still affects zero rows and the service still turns that into
-- a 409 rather than a second close.
-- ---------------------------------------------------------------------------

create or replace function public.clock_out_attendance(
  p_employee_id uuid,
  p_day         date,
  p_remarks     text default null
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.attendance
     set time_out   = clock_timestamp(),
         -- Only overwrite remarks when the caller supplied one; the previous
         -- shape left the column untouched when the key was absent.
         remarks    = coalesce(p_remarks, remarks),
         updated_at = clock_timestamp()
   where employee_id = p_employee_id
     and work_date   = p_day
     and time_out is null
  returning id;
$$;

revoke all on function public.clock_out_attendance(uuid, date, text) from public;
revoke all on function public.clock_out_attendance(uuid, date, text) from anon;
revoke all on function public.clock_out_attendance(uuid, date, text) from authenticated;
grant execute on function public.clock_out_attendance(uuid, date, text) to service_role;

comment on function public.clock_out_attendance(uuid, date, text) is
  'Closes the open session for an employee on a given day, stamping time_out from the database clock. Returns the row id, or NULL when there was no open session to close.';

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_employee uuid;
  v_id       uuid;
  v_row      record;
  v_second   uuid;
begin
  -- A throwaway employee, because the function needs a real FK target.
  insert into public.employees (full_name, title)
  values ('__clock_out_selfcheck', 'Therapist')
  returning id into v_employee;

  -- 1. An open session closes, and time_out is on the database clock: strictly
  --    after time_in, and not in the future.
  insert into public.attendance (employee_id, work_date, time_in)
  values (v_employee, current_date, now() - interval '1 hour');

  select public.clock_out_attendance(v_employee, current_date, 'self-check')
    into v_id;

  if v_id is null then
    raise exception 'SELF_CHECK_FAILED: clock_out_attendance did not close an open session';
  end if;

  select time_in, time_out, remarks into v_row
    from public.attendance where id = v_id;

  if v_row.time_out is null or v_row.time_out <= v_row.time_in then
    raise exception 'SELF_CHECK_FAILED: time_out (%) is not after time_in (%)',
      v_row.time_out, v_row.time_in;
  end if;
  if v_row.time_out > clock_timestamp() then
    raise exception 'SELF_CHECK_FAILED: time_out is in the future';
  end if;
  if v_row.remarks <> 'self-check' then
    raise exception 'SELF_CHECK_FAILED: remarks were not stored';
  end if;

  -- 2. Closing it again returns NULL rather than rewriting the timestamp.
  select public.clock_out_attendance(v_employee, current_date, null) into v_second;
  if v_second is not null then
    raise exception 'SELF_CHECK_FAILED: a closed session was closed twice';
  end if;

  -- 3. A remark-less close must not erase an existing remark.
  insert into public.attendance (employee_id, work_date, time_in, remarks)
  values (v_employee, current_date - 1, now() - interval '1 hour', 'kept');

  perform public.clock_out_attendance(v_employee, current_date - 1, null);

  select remarks into v_row from public.attendance
   where employee_id = v_employee and work_date = current_date - 1;
  if v_row.remarks <> 'kept' then
    raise exception 'SELF_CHECK_FAILED: a null remark overwrote the existing one';
  end if;

  -- Clean up; the probe must leave nothing behind.
  delete from public.attendance where employee_id = v_employee;
  delete from public.employees where id = v_employee;

  raise notice 'SELF_CHECK_OK: clock_out_attendance stamps time_out on the database clock';
end $$;
