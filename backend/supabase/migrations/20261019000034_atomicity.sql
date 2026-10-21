-- ===========================================================================
-- 34. Atomicity for the read-then-write sequences
--
-- Four operations in the service layer are two PostgREST statements that must
-- be one. Each one is reachable from the console, and each one loses data or
-- creates drift when the second statement fails:
--
--   1. employeesRepository.setWorkingHours   delete, then insert
--   2. employeesRepository.setServices       delete, then insert
--   3. roomsService.deactivate               count, then update
--   4. bookingsService.ensureClientRow       insert, then create_booking
--
-- (1) is the dangerous one. `working_hours` carries
-- `check (end_time > start_time)`, so a payload with a shift that ends before
-- it starts deletes every existing shift, fails the insert, and returns 500 -
-- the stylist is left with no availability at all and the admin sees an error
-- that says nothing about the damage. The comment in the old code claimed a
-- failure "leaves an employee temporarily unqualified rather than corrupt",
-- which was true only if the insert could never fail. It can.
--
-- (2) fails the same way on a concurrent FK error or a duplicate.
--
-- (3) is a check-then-act race: a booking created between the count and the
-- update lands in a room the desk has just decommissioned.
--
-- (4) inserts a `clients` row before the booking is attempted. `clients.
-- profile_id` is unique, so a client double-tapping "Book" the first time they
-- ever book gets a 23505 on the second request and a 500 rather than the
-- booking. If the booking itself fails, the client row is left behind as an
-- orphan.
--
-- The fix is SQL functions rather than a `pg` transaction helper in the app.
-- The codebase already routes every multi-table write through PL/pgSQL
-- (create_booking, cancel_booking, reschedule_booking, set_booking_room,
-- set_booking_status) precisely so that a write cannot be half-applied. Adding
-- a second write path with its own connection pool and its own copy of the
-- database password would be a step backwards from that discipline, and would
-- give the API two different failure modes for the same table.
--
-- Error codes: P0015 onwards were free after migration 33.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. replace_employee_services()
--
-- Replace-all semantics: the caller sends the complete desired set. The
-- existence check for the service ids stays in the service layer, because it
-- produces a per-id 400 that this function could only reproduce by hand; only
-- the write needs to be atomic.
-- ---------------------------------------------------------------------------
create or replace function public.replace_employee_services(
  p_employee_id uuid,
  p_service_ids uuid[]
)
returns uuid[]
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ids uuid[] := coalesce(p_service_ids, '{}'::uuid[]);
begin
  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- Both statements are in one function body, so they share one transaction.
  -- If the insert raises - a duplicate in the payload, an FK that vanished
  -- between the service's check and here - the delete is rolled back with it.
  delete from public.employee_services where employee_id = p_employee_id;

  insert into public.employee_services (employee_id, service_id)
  select p_employee_id, s
  from unnest(v_ids) as s
  -- on conflict do nothing so a duplicated id in the payload is not a 500.
  on conflict do nothing;

  return v_ids;
end;
$$;

comment on function public.replace_employee_services(uuid, uuid[]) is
  'Replace an employee''s service qualifications in one transaction. Delete-then-insert through PostgREST could lose the whole set.';

revoke all on function public.replace_employee_services(uuid, uuid[]) from public;
revoke all on function public.replace_employee_services(uuid, uuid[]) from anon;
revoke all on function public.replace_employee_services(uuid, uuid[]) from authenticated;
grant execute on function public.replace_employee_services(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 2. replace_working_hours()
--
-- Takes the rows as jsonb rather than three parallel arrays, because parallel
-- arrays can be passed with mismatched lengths and Postgres will happily zip
-- them into nonsense.
-- ---------------------------------------------------------------------------
create or replace function public.replace_working_hours(
  p_employee_id uuid,
  p_hours       jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hours   jsonb := coalesce(p_hours, '[]'::jsonb);
  v_count   integer;
  v_bad     text;
begin
  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0006';
  end if;

  if jsonb_typeof(v_hours) <> 'array' then
    raise exception 'WORKING_HOURS_INVALID: hours must be an array' using errcode = 'P0015';
  end if;

  -- Validate before touching the table. This is the whole point of the
  -- function: the old code deleted first and discovered the problem second.
  select string_agg(
           format('weekday %s: %s-%s', h.weekday, h.start_time, h.end_time),
           '; '
         )
    into v_bad
    from jsonb_to_recordset(v_hours) as h(weekday smallint, start_time time, end_time time)
   where h.end_time <= h.start_time;

  if v_bad is not null then
    raise exception 'WORKING_HOURS_INVALID: %', v_bad using errcode = 'P0015';
  end if;

  delete from public.working_hours where employee_id = p_employee_id;

  insert into public.working_hours (employee_id, weekday, start_time, end_time)
  select p_employee_id, h.weekday, h.start_time, h.end_time
  from jsonb_to_recordset(v_hours) as h(weekday smallint, start_time time, end_time time);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.replace_working_hours(uuid, jsonb) is
  'Replace an employee''s weekly hours in one transaction, validating the shifts before the delete.';

revoke all on function public.replace_working_hours(uuid, jsonb) from public;
revoke all on function public.replace_working_hours(uuid, jsonb) from anon;
revoke all on function public.replace_working_hours(uuid, jsonb) from authenticated;
grant execute on function public.replace_working_hours(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. deactivate_room()
--
-- The upcoming-booking check and the deactivation are one statement, so a
-- booking cannot slip between them. Row lock on the room first, so two
-- concurrent deactivations serialise rather than both counting zero.
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_room(
  p_room_id uuid,
  p_actor   uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_room     public.rooms%rowtype;
  v_upcoming integer;
begin
  select * into v_room from public.rooms where id = p_room_id for update;

  if not found then
    raise exception 'ROOM_NOT_FOUND' using errcode = 'P0008';
  end if;

  -- Already inactive: idempotent, and no second audit row.
  if not v_room.is_active then
    return 0;
  end if;

  -- "Upcoming" means a booking that has not finished yet and has not been
  -- cancelled. A NO_SHOW is finished business - the room is free.
  select count(*)
    into v_upcoming
    from public.bookings
   where room_id = p_room_id
     and end_time > now()
     and status not in ('CANCELLED', 'NO_SHOW', 'COMPLETED');

  if v_upcoming > 0 then
    -- The service turns this into a 409 naming the room and the count. The
    -- message carries the count so the number survives the round trip.
    raise exception 'ROOM_STILL_BOOKED: %', v_upcoming using errcode = 'P0016';
  end if;

  -- `rooms` is the one table in the schema with no `set_updated_at` trigger
  -- (every other table gets one in migration 11), so the timestamp is set here
  -- explicitly. Without it a deactivated room keeps reporting the moment it
  -- was created.
  update public.rooms
     set is_active = false,
         updated_at = now()
   where id = p_room_id;

  perform public.write_audit(
    p_actor,
    'room.deactivated',
    'rooms',
    p_room_id,
    jsonb_build_object('name', v_room.name, 'roomType', v_room.room_type)
  );

  return 0;
end;
$$;

comment on function public.deactivate_room(uuid, uuid) is
  'Deactivate a room atomically, refusing while it still has unfinished bookings.';

revoke all on function public.deactivate_room(uuid, uuid) from public;
revoke all on function public.deactivate_room(uuid, uuid) from anon;
revoke all on function public.deactivate_room(uuid, uuid) from authenticated;
grant execute on function public.deactivate_room(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. ensure_client_for_profile()
--
-- Returns the client id for a profile, creating the row on first use.
--
-- The `on conflict ... do update set profile_id = excluded.profile_id` is the
-- standard trick to make RETURNING fire on the conflict branch as well: a
-- plain `do nothing` returns no row, so the caller would have to select
-- afterwards and lose the atomicity it came here for. The update is a no-op
-- by construction - it writes the value that is already there.
--
-- The existing client's name is deliberately NOT overwritten: `profiles` and
-- `clients` are edited in different places, and having a booking silently
-- rename a customer from their profile is worse than the two drifting.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_client_for_profile(
  p_profile_id uuid,
  p_email      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client_id uuid;
begin
  insert into public.clients (profile_id, full_name, phone, email)
  select
    p.id,
    coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p_email), ''), 'Client'),
    p.phone,
    p_email
  from public.profiles p
  where p.id = p_profile_id
  on conflict (profile_id) do update
    set profile_id = excluded.profile_id
  returning id into v_client_id;

  if v_client_id is null then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0017';
  end if;

  return v_client_id;
end;
$$;

comment on function public.ensure_client_for_profile(uuid, text) is
  'Get or create the clients row for a profile in one statement, so a double-submit cannot raise a unique violation.';

revoke all on function public.ensure_client_for_profile(uuid, text) from public;
revoke all on function public.ensure_client_for_profile(uuid, text) from anon;
revoke all on function public.ensure_client_for_profile(uuid, text) from authenticated;
grant execute on function public.ensure_client_for_profile(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Tasks: a real duplicate guard.
--
-- tasksService.create does `findOpenDuplicate` and then inserts. Two
-- concurrent creates both see nothing and both insert, so the "prevent
-- duplicate tasks" requirement held only when the two requests were far enough
-- apart. A partial unique index is the only version of this that cannot be
-- raced; the service keeps its lookup so it can still answer with the
-- existing task's reference, and now treats a 23505 as the same answer.
--
-- lower(btrim(title)) matches the old `ilike(title)` comparison, which was
-- case-insensitive but also treated % and _ in the title as wildcards - so a
-- task called "50% off stocktake" matched "50X off stocktake". The index is
-- stricter and more correct.
-- ---------------------------------------------------------------------------
do $$
declare
  v_dupes text;
begin
  select string_agg(format('employee %s / "%s" x%s', employee_id, title, n), '; ')
    into v_dupes
    from (
      select employee_id, lower(btrim(title)) as title, count(*) as n
        from public.tasks
       where status in ('PENDING', 'IN_PROGRESS')
       group by 1, 2
      having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception 'Cannot add the duplicate-task index; resolve these first: %', v_dupes;
  end if;
end $$;

create unique index if not exists tasks_open_title_per_employee_idx
  on public.tasks (employee_id, lower(btrim(title)))
  where status in ('PENDING', 'IN_PROGRESS');

comment on index public.tasks_open_title_per_employee_idx is
  'One open task per employee per title. The service-layer check alone was racy.';

-- ---------------------------------------------------------------------------
-- 6. Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text[] := '{}';
begin
  if to_regprocedure('public.replace_employee_services(uuid,uuid[])') is null then
    v_missing := v_missing || 'replace_employee_services';
  end if;
  if to_regprocedure('public.replace_working_hours(uuid,jsonb)') is null then
    v_missing := v_missing || 'replace_working_hours';
  end if;
  if to_regprocedure('public.deactivate_room(uuid,uuid)') is null then
    v_missing := v_missing || 'deactivate_room';
  end if;
  if to_regprocedure('public.ensure_client_for_profile(uuid,text)') is null then
    v_missing := v_missing || 'ensure_client_for_profile';
  end if;
  if to_regclass('public.tasks_open_title_per_employee_idx') is null then
    v_missing := v_missing || 'tasks_open_title_per_employee_idx';
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'migration 34 incomplete, missing: %', array_to_string(v_missing, ', ');
  end if;

  -- None of these may be reachable with the anon key: they bypass RLS by
  -- design and two of them write.
  if has_function_privilege('anon', 'public.replace_working_hours(uuid,jsonb)', 'execute') then
    raise exception 'replace_working_hours must not be executable by anon';
  end if;
  if has_function_privilege('anon', 'public.deactivate_room(uuid,uuid)', 'execute') then
    raise exception 'deactivate_room must not be executable by anon';
  end if;
  if has_function_privilege('anon', 'public.ensure_client_for_profile(uuid,text)', 'execute') then
    raise exception 'ensure_client_for_profile must not be executable by anon';
  end if;
  if has_function_privilege('anon', 'public.replace_employee_services(uuid,uuid[])', 'execute') then
    raise exception 'replace_employee_services must not be executable by anon';
  end if;
end $$;
