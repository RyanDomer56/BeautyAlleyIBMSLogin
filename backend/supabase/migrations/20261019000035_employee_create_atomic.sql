-- ===========================================================================
-- 35. Employee creation is atomic
--
-- `POST /employees` used to be two writes: insert the employee, then
-- `setServices` for the qualifications named in the body. `setServices`
-- validates the service ids first and throws 400 SERVICES_INVALID if any is
-- unknown - after the employee row is already committed.
--
-- So a request with one bad service uuid returned 400, and the operator
-- believed nothing had been created. There was, in fact, a brand-new employee
-- with no qualifications, invisible in the error and unattached to the request
-- that was supposed to describe them.
--
-- This is the one gap in migration 34 that the zod layer did not already
-- guard: `createEmployeeSchema` checks that the ids are uuids, which a
-- nonsense uuid still is, and the existence check lived in the second write.
--
-- Moving the validation into SQL fixes both problems at once - the write
-- becomes atomic and the check sits next to the write instead of two
-- round-trips away from it.
--
-- Correction to migration 34, recorded here rather than edited in: the
-- `working_hours` scenario that migration describes is not reachable through
-- the HTTP API. `workingHourSchema` already refines
-- `endTime > startTime`, and the service-layer overlap check covers the
-- unique constraint, so a reversed shift is rejected with a 400 before any
-- statement runs. Migration 34 is still worth having - the delete is no longer
-- commit-ordered ahead of the insert, so a constraint zod has never heard of
-- cannot wipe a stylist's schedule - but it was hardening, not a fix, and the
-- migration file overstates it. The ledger records that file's checksum, so
-- the overstatement stands as the record of what was applied.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- create_employee()
-- ---------------------------------------------------------------------------
create or replace function public.create_employee(
  p_full_name   text,
  p_title       text default null,
  p_bio         text default null,
  p_profile_id  uuid default null,
  p_is_active   boolean default true,
  p_service_ids uuid[] default '{}'::uuid[],
  p_actor       uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_employee_id uuid;
  v_missing     text;
begin
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then
    raise exception 'VALIDATION_FAILED: full name is required' using errcode = 'P0002';
  end if;

  -- Report every unknown id, not just the first, so the caller gets a single
  -- actionable 400 instead of a series of them.
  if array_length(p_service_ids, 1) > 0 then
    select string_agg(s::text, ', ')
      into v_missing
      from unnest(p_service_ids) as s
     where s not in (select id from public.services);

    if v_missing is not null then
      raise exception 'SERVICES_INVALID: %', v_missing using errcode = 'P0002';
    end if;
  end if;

  insert into public.employees (full_name, title, bio, profile_id, is_active)
  values (btrim(p_full_name), nullif(btrim(p_title), ''), nullif(btrim(p_bio), ''), p_profile_id, p_is_active)
  returning id into v_employee_id;

  insert into public.employee_services (employee_id, service_id)
  select v_employee_id, s
  from unnest(p_service_ids) as s
  on conflict do nothing;

  perform public.write_audit(
    p_actor,
    'employee.created',
    'employees',
    v_employee_id,
    jsonb_build_object(
      'fullName', btrim(p_full_name),
      'serviceCount', coalesce(array_length(p_service_ids, 1), 0)
    )
  );

  return v_employee_id;
end;
$$;

comment on function public.create_employee(text,text,text,uuid,boolean,uuid[],uuid) is
  'Create an employee and their service qualifications in one transaction. A bad service id used to leave the employee committed with no qualifications.';

revoke all on function public.create_employee(text,text,text,uuid,boolean,uuid[],uuid) from public;
revoke all on function public.create_employee(text,text,text,uuid,boolean,uuid[],uuid) from anon;
revoke all on function public.create_employee(text,text,text,uuid,boolean,uuid[],uuid) from authenticated;
grant execute on function public.create_employee(text,text,text,uuid,boolean,uuid[],uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.create_employee(text,text,text,uuid,boolean,uuid[],uuid)') is null then
    raise exception 'migration 35 incomplete: create_employee missing';
  end if;
  if has_function_privilege('anon', 'public.create_employee(text,text,text,uuid,boolean,uuid[],uuid)', 'execute') then
    raise exception 'create_employee must not be executable by anon';
  end if;
end $$;
