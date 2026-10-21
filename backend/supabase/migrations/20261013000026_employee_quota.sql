-- ---------------------------------------------------------------------------
-- Migration 26: the daily completion quota.
--
-- The requirements document gives every stylist a quota of 10 completed
-- clients a day, and asks both the owner's dashboard and the stylist's own
-- dashboard to show progress against it. `employees.daily_quota` already
-- exists (migration 20); what was missing was a way to ask "how far along is
-- this person today" that both dashboards could share.
--
-- ## Why this is derived and not a stored counter
--
-- The count is computed from `bookings`, for the same reason `v_client_loyalty`
-- is: a stored counter drifts. Cancelling a completed booking, re-opening one,
-- or a `reset-demo-data.js` that deletes bookings would all leave a stored
-- number wrong, with nothing to correct it. Counting COMPLETED rows on read
-- self-corrects by construction.
--
-- It also keeps "completed" from quietly coming to mean "scheduled": a no-show
-- or a cancellation is not work delivered, and the quota measures work
-- delivered.
--
-- ## Why one helper rather than the rule written twice
--
-- `employee_quota_rows` is the only place the rule lives - which statuses
-- count, which timezone decides "today", and how `remaining` and `met` follow
-- from the numbers. The two public wrappers differ only in shape (one
-- employee, or every active one), so the owner's board and the stylist's own
-- page cannot disagree about what the number means.
--
-- ## Timezone
--
-- "Today" is the branch's local day, not UTC. At 09:00 Manila it is still the
-- previous day in UTC, so a UTC-based count would roll the quota over eight
-- hours late and a stylist's 8am completions would land on yesterday.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The rule, as a rowset.
--
-- `p_active_only` exists because the two callers want different things: a
-- board of the floor should show people who still work here, while asking
-- about one specific person should answer even if they have since left - a
-- manager reviewing last month should not get a 404 for someone whose row is
-- plainly in the table.
-- ---------------------------------------------------------------------------
create or replace function public.employee_quota_rows(
  p_day         date    default null,
  p_active_only boolean default true
)
returns table (
  employee_id   uuid,
  employee_name text,
  day           date,
  timezone      text,
  quota         integer,
  completed     bigint,
  scheduled     bigint,
  remaining     bigint,
  met           boolean
)
language sql
stable
security definer
set search_path = public
as $function$
  with bounds as (
    select coalesce(p_day, (now() at time zone public.branch_timezone())::date) as day,
           public.branch_timezone()                                                as tz
  ),
  counted as (
    select b.employee_id,
           count(*) filter (where b.status = 'COMPLETED')                    as completed,
           count(*) filter (where b.status in ('PENDING', 'CONFIRMED',
                                               'CHECKED_IN', 'IN_SERVICE'))  as scheduled
      from public.bookings b
      cross join bounds
     where (b.start_time at time zone bounds.tz)::date = bounds.day
     group by b.employee_id
  )
  select e.id,
         e.full_name,
         bounds.day,
         bounds.tz,
         e.daily_quota,
         coalesce(c.completed, 0),
         coalesce(c.scheduled, 0),
         -- Floored at zero: a stylist who took twelve clients has not "minus
         -- two remaining", and a progress bar fed a negative number renders as
         -- empty rather than as the over-delivery it actually is.
         greatest(e.daily_quota - coalesce(c.completed, 0), 0),
         coalesce(c.completed, 0) >= e.daily_quota
    from public.employees e
    cross join bounds
    left join counted c on c.employee_id = e.id
   where (not p_active_only) or e.is_active
   order by e.full_name;
$function$;

comment on function public.employee_quota_rows(date, boolean) is
  'Per-employee daily quota progress, derived from COMPLETED bookings in the branch timezone. The single source of the quota rule.';

-- ---------------------------------------------------------------------------
-- One employee, as jsonb.
--
-- Raises EMPLOYEE_NOT_FOUND rather than returning null, so the API can answer
-- 404 instead of a fabricated zero. "This stylist completed 0 today" and
-- "there is no such stylist" are different answers and only one of them is
-- true.
-- ---------------------------------------------------------------------------
create or replace function public.get_employee_quota(
  p_employee_id uuid,
  p_day         date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_row record;
begin
  if not exists (select 1 from public.employees where id = p_employee_id) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0001';
  end if;

  select r.employee_id, r.employee_name, r.day, r.timezone, r.quota,
         r.completed, r.scheduled, r.remaining, r.met
    into v_row
    from public.employee_quota_rows(p_day, false) r
   where r.employee_id = p_employee_id;

  return jsonb_build_object(
    'employeeId',   v_row.employee_id,
    'employeeName', v_row.employee_name,
    'date',         to_char(v_row.day, 'YYYY-MM-DD'),
    'timezone',     v_row.timezone,
    'quota',        v_row.quota,
    'completed',    v_row.completed,
    'scheduled',    v_row.scheduled,
    'remaining',    v_row.remaining,
    'met',          v_row.met
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Every active employee, as a jsonb array.
--
-- The owner's board and the front desk's "who is free" view both need the
-- whole floor at once; a per-employee loop would be N round trips for a page
-- rendered in one.
-- ---------------------------------------------------------------------------
create or replace function public.get_employee_quotas(p_day date default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'employeeId',   r.employee_id,
               'employeeName', r.employee_name,
               'date',         to_char(r.day, 'YYYY-MM-DD'),
               'timezone',     r.timezone,
               'quota',        r.quota,
               'completed',    r.completed,
               'scheduled',    r.scheduled,
               'remaining',    r.remaining,
               'met',          r.met
             )
             order by r.employee_name
           ),
           '[]'::jsonb
         )
    from public.employee_quota_rows(p_day, true) r;
$function$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- Migration 13 revoked EXECUTE on every public function from anon and
-- authenticated, and set default privileges for functions created later - but
-- relying on that default is exactly the kind of assumption that fails
-- silently, and `verify.js` treats "a business function anon can call" as a
-- hard failure. So it is stated explicitly.
-- ---------------------------------------------------------------------------
revoke execute on function public.employee_quota_rows(date, boolean) from public, anon, authenticated;
revoke execute on function public.get_employee_quota(uuid, date) from public, anon, authenticated;
revoke execute on function public.get_employee_quotas(date) from public, anon, authenticated;

grant execute on function public.employee_quota_rows(date, boolean) to service_role;
grant execute on function public.get_employee_quota(uuid, date) to service_role;
grant execute on function public.get_employee_quotas(date) to service_role;

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count   integer;
  v_exposed text;
begin
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('employee_quota_rows', 'get_employee_quota', 'get_employee_quotas');
  if v_count <> 3 then
    raise exception 'migration 26: expected 3 quota functions, found %', v_count;
  end if;

  select string_agg(p.proname, ', ') into v_exposed
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('employee_quota_rows', 'get_employee_quota', 'get_employee_quotas')
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );
  if v_exposed is not null then
    raise exception 'migration 26: quota functions still callable by anon/authenticated: %', v_exposed;
  end if;
end $$;

-- Behavioural check. Reads only, so it cannot leave anything behind.
do $$
declare
  v_employee  uuid;
  v_quota     integer;
  v_one       jsonb;
  v_all       jsonb;
  v_completed integer;
begin
  select id, daily_quota into v_employee, v_quota
    from public.employees where is_active order by id limit 1;

  if v_employee is null then
    raise notice 'migration 26: no active employees - skipping the behavioural check';
    return;
  end if;

  v_one := public.get_employee_quota(v_employee);
  v_completed := (v_one ->> 'completed')::integer;

  if v_one ->> 'employeeId' <> v_employee::text then
    raise exception 'migration 26: get_employee_quota returned the wrong employee: %', v_one;
  end if;
  if (v_one ->> 'quota')::integer <> v_quota then
    raise exception 'migration 26: quota is % but employees.daily_quota is %', v_one ->> 'quota', v_quota;
  end if;
  if (v_one ->> 'remaining')::integer <> greatest(v_quota - v_completed, 0) then
    raise exception 'migration 26: remaining does not follow from quota and completed: %', v_one;
  end if;
  if (v_one ->> 'met')::boolean <> (v_completed >= v_quota) then
    raise exception 'migration 26: met does not follow from completed and quota: %', v_one;
  end if;
  if (v_one ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'migration 26: date is not a plain YYYY-MM-DD: %', v_one ->> 'date';
  end if;
  -- A date can be asked for explicitly, and must be echoed back.
  if public.get_employee_quota(v_employee, date '2026-01-02') ->> 'date' <> '2026-01-02' then
    raise exception 'migration 26: an explicit day was not honoured';
  end if;

  v_all := public.get_employee_quotas();
  if jsonb_typeof(v_all) <> 'array' then
    raise exception 'migration 26: get_employee_quotas did not return an array';
  end if;
  if jsonb_array_length(v_all) < 1 then
    raise exception 'migration 26: get_employee_quotas was empty with an active employee present';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_all) e where e ->> 'employeeId' = v_employee::text
  ) then
    raise exception 'migration 26: get_employee_quotas omitted the employee get_employee_quota returned';
  end if;
end $$;

-- An unknown id is a 404, not a zero. Separate block so a failure here cannot
-- be swallowed by the checks above.
do $$
begin
  begin
    perform public.get_employee_quota('00000000-0000-0000-0000-0000000000ff'::uuid);
    raise exception 'migration 26: an unknown employee did not raise';
  exception
    when others then
      if sqlerrm not like 'EMPLOYEE_NOT_FOUND%' then
        raise;
      end if;
  end;
end $$;
