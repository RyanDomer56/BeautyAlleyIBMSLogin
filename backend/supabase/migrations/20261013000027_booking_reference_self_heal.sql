-- ---------------------------------------------------------------------------
-- Migration 27: booking references that cannot collide.
--
-- ## The bug this fixes
--
-- `bookings.reference` is unique, and `next_booking_reference()` mints it from a
-- per-day counter in `public.booking_counters`:
--
--     insert into booking_counters (day, last_value) values (v_day, 1)
--     on conflict (day) do update set last_value = booking_counters.last_value + 1
--     returning last_value into v_next;
--     return 'BA-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_next::text, 4, '0');
--
-- The counter is the ONLY thing consulted. It assumes it is the only writer of
-- the `BA-<day>-<nnnn>` namespace, and that is not true: `seed-demo-bookings.js`
-- deliberately continues from the highest suffix it finds in `bookings` so that
-- it does not clobber references the smoke test minted for the same day - but it
-- writes rows directly and never advances `booking_counters`. The moment it runs,
-- the counter is behind the reference set, and the next real booking is handed a
-- reference that already exists:
--
--     counter at 28, references up to BA-20261013-0031
--     -> allocate 0029 -> 23505 unique_violation on bookings_reference_key
--     -> 409 CONFLICT "Booking reference collision, please retry"
--
-- and "please retry" is bad advice: the client has no retry loop, and each retry
-- only walks one step further up the same colliding run. On the demo database
-- this took the public booking flow down for the rest of the local day - the
-- booking page simply stopped working after a `npm run demo:bookings`.
--
-- Any external writer has the same effect: an admin import, a restore from a
-- dump, a hand-written INSERT. The counter and the reference set are two sources
-- of truth for one fact, and they drift.
--
-- ## The fix
--
-- Two layers, because one is not enough:
--
--   1. **Re-seed before allocating.** The highest numeric suffix actually in use
--      for that day is folded into the allocation, so a counter left behind by an
--      external writer converges in ONE step instead of walking the gap. This is
--      the fix for the realistic case and it is O(1) - a prefix probe on
--      `bookings_reference_key`.
--
--   2. **Skip anything nonetheless taken.** The re-seed reads a snapshot, so a
--      writer that inserts a reference concurrently could still be missed. The
--      allocation loops until it lands on a genuinely free value. The row lock
--      taken by `on conflict do update` serialises allocators, so two callers
--      never share a number.
--
-- The unique index stays the ultimate arbiter - this does not remove the
-- constraint, it just stops the constraint from being tripped by a bookkeeping
-- mistake. `create_booking`'s 23505 -> CONFLICT mapping is unchanged.
--
-- ## Why the counter is still a counter
--
-- It could be replaced by `max(suffix) + 1` outright, but that would take a
-- table-wide lock on every booking and it would re-issue numbers freed by
-- `reset-demo-data.js`. The counter keeps allocation cheap and monotonic; the
-- re-seed just stops it from lying.
--
-- ## Why `sync_booking_counters()` exists
--
-- The migration has to repair the drift it found (otherwise the live database
-- stays broken until the next booking happens to fix it), and
-- `seed-demo-bookings.js` has to stop creating drift. Both want the same
-- statement, so it is written once, here, as a function. Deriving the day from
-- the REFERENCE and not from `start_time` matters: the counter is keyed by the
-- day the reference was minted, and a booking made today for next month carries
-- today's date in its reference. Grouping by `start_time` would file it under
-- the wrong day and repair nothing.
--
-- ## Why the suffix is parsed as bigint
--
-- Other fixtures mint references with an epoch-millisecond suffix
-- (`BA-SMOKE-1791862646304`). Those are excluded by the day prefix and by the
-- `BA-<8 digits>-` regex below, but parsing into `integer` would still be a
-- landmine for anything wider than 10 digits. `bigint` costs nothing and removes
-- the hazard.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The allocator.
-- ---------------------------------------------------------------------------
create or replace function public.next_booking_reference(p_day date default null)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_day       date := coalesce(p_day, (now() at time zone public.branch_timezone())::date);
  v_prefix    text;
  v_max       bigint;
  v_next      integer;
  v_reference text;
begin
  v_prefix := 'BA-' || to_char(v_day, 'YYYYMMDD') || '-';

  -- The highest suffix already in use for this day. `nullif` guards the cast: a
  -- reference ending in no digits at all makes `substring` NULL, and `max()`
  -- ignores NULLs, so the day simply contributes nothing.
  --
  -- Scoped to one day on purpose - this runs on every booking, so it must stay a
  -- prefix probe on the unique index rather than a scan of the whole table.
  select coalesce(max(nullif(substring(b.reference from '[0-9]+$'), '')::bigint), 0)
    into v_max
    from public.bookings b
   where b.reference like v_prefix || '%';

  -- The counter and the reference set can disagree, so take the greater of the
  -- two. `greatest(...)` in the DO UPDATE arm reads the row AFTER the lock, so a
  -- concurrent allocator that just moved the counter is respected rather than
  -- overwritten - that is what keeps two callers from sharing a number.
  for v_attempt in 1..10000 loop
    insert into public.booking_counters (day, last_value)
    values (v_day, v_max + 1)
    on conflict (day) do update
       set last_value = greatest(public.booking_counters.last_value, v_max) + 1
    returning last_value into v_next;

    v_reference := v_prefix || lpad(v_next::text, 4, '0');

    -- Belt and braces. With the re-seed above this is free in the common case:
    -- one index probe, not a scan.
    if not exists (select 1 from public.bookings b where b.reference = v_reference) then
      return v_reference;
    end if;
  end loop;

  -- 10000 consecutive taken values is not a stale counter, it is a broken
  -- invariant. Fail loudly rather than returning a reference that cannot insert.
  raise exception 'REFERENCE_EXHAUSTED: no free booking reference for %', v_day
    using errcode = 'P0007';
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The repair.
--
-- Rewrites every counter from the references that actually exist. Safe to run at
-- any time: it only ever moves a counter FORWARD (`greatest`), because moving one
-- backwards would re-issue numbers.
-- ---------------------------------------------------------------------------
create or replace function public.sync_booking_counters()
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_written integer;
begin
  with actual as (
    -- The day comes from the reference itself, not from `start_time`: the
    -- counter is keyed by the day the reference was minted.
    select to_date(substring(b.reference from 4 for 8), 'YYYYMMDD') as day,
           max(substring(b.reference from '[0-9]+$')::bigint)     as last_value
      from public.bookings b
     where b.reference ~ '^BA-[0-9]{8}-[0-9]+$'
     group by 1
  )
  insert into public.booking_counters (day, last_value)
  select a.day, a.last_value from actual a
  on conflict (day) do update
     set last_value = greatest(public.booking_counters.last_value, excluded.last_value);

  get diagnostics v_written = row_count;
  return v_written;
end;
$function$;

-- Internal bookkeeping. Only the migration runner and the seed scripts need it,
-- and neither goes through PostgREST - so it is not reachable over the API.
-- (`alter default privileges` does not cover functions created later, which is
-- why this is explicit rather than assumed.)
revoke all on function public.sync_booking_counters() from public;
revoke all on function public.sync_booking_counters() from anon;
revoke all on function public.sync_booking_counters() from authenticated;
grant execute on function public.sync_booking_counters() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Repair the drift this migration found.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rows integer;
begin
  v_rows := public.sync_booking_counters();
  raise notice 'migration 27: reconciled % booking counter row(s)', v_rows;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Self-checks.
--
-- 4a and 4c allocate reference numbers, so both run inside a subtransaction that
-- is then thrown away: the migration must not burn numbers it never uses, and it
-- must not leave probe rows behind. The sentinel is a deliberate `raise`, and the
-- handler re-raises anything that is not the sentinel - so a failed assertion
-- still fails the migration.
-- ---------------------------------------------------------------------------

-- 4a. Shape and monotonicity of the allocator.
do $$
declare
  v_a text;
  v_b text;
begin
  begin
    v_a := public.next_booking_reference(date '2099-06-15');
    v_b := public.next_booking_reference(date '2099-06-15');

    if v_a !~ '^BA-20990615-[0-9]{4,}$' then
      raise exception 'migration 27: malformed reference %', v_a;
    end if;
    if v_a = v_b then
      raise exception 'migration 27: two allocations returned the same reference %', v_a;
    end if;
    -- An explicit day must be honoured, not silently replaced by today.
    if public.next_booking_reference(date '2099-06-16') !~ '^BA-20990616-' then
      raise exception 'migration 27: an explicit day was not honoured';
    end if;
    -- Defaulting to the branch's local day, not UTC.
    if public.next_booking_reference() !~ ('^BA-' || to_char((now() at time zone public.branch_timezone())::date, 'YYYYMMDD') || '-') then
      raise exception 'migration 27: the default day is not the branch-local day';
    end if;

    raise exception 'MIGRATION27_PROBE_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'MIGRATION27_PROBE_ROLLBACK' then
        raise;
      end if;
  end;
end $$;

-- 4b. The repair invariant: no counter may sit below the references that exist.
do $$
declare
  v_bad record;
begin
  select bc.day, bc.last_value, live.max_suffix
    into v_bad
    from public.booking_counters bc
    join lateral (
      select max(substring(b.reference from '[0-9]+$')::bigint) as max_suffix
        from public.bookings b
       where b.reference ~ '^BA-[0-9]{8}-[0-9]+$'
         and to_date(substring(b.reference from 4 for 8), 'YYYYMMDD') = bc.day
    ) live on true
   where bc.last_value < live.max_suffix
   limit 1;

  if found then
    raise exception 'migration 27: counter for % is % but its references reach %',
      v_bad.day, v_bad.last_value, v_bad.max_suffix;
  end if;
end $$;

-- 4c. The behavioural probe - the actual regression.
--
-- Reproduces the failure exactly: a booking holds a reference the counter has
-- never issued.
do $$
declare
  v_employee  uuid;
  v_allocated text;
begin
  select e.id into v_employee from public.employees e order by e.id limit 1;
  if v_employee is null then
    raise notice 'migration 27: no employee - skipping the behavioural check';
    return;
  end if;

  begin
    -- A reference is taken for a day the counter believes is untouched.
    insert into public.bookings
      (reference, guest_name, guest_phone, employee_id, start_time, end_time,
       status, subtotal_cents, discount_cents, total_cents)
    values
      ('BA-20991231-0001', 'Migration 27 probe', '+639000000027', v_employee,
       timestamptz '2099-12-31 10:00+08', timestamptz '2099-12-31 11:00+08',
       'CONFIRMED', 100000, 0, 100000);

    -- ...and the counter is stale, exactly as the demo seeder leaves it.
    insert into public.booking_counters (day, last_value)
    values (date '2099-12-31', 0)
    on conflict (day) do update set last_value = 0;

    v_allocated := public.next_booking_reference(date '2099-12-31');

    if v_allocated = 'BA-20991231-0001' then
      raise exception 'migration 27: the allocator re-issued a taken reference (%)', v_allocated;
    end if;
    if v_allocated <> 'BA-20991231-0002' then
      raise exception 'migration 27: expected the allocator to skip to 0002, got %', v_allocated;
    end if;

    raise exception 'MIGRATION27_PROBE_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'MIGRATION27_PROBE_ROLLBACK' then
        raise;
      end if;
  end;
end $$;

-- 4d. Neither probe may have leaked.
do $$
begin
  if exists (select 1 from public.bookings where reference like 'BA-2099%') then
    raise exception 'migration 27: a probe leaked rows into public.bookings';
  end if;
  if exists (select 1 from public.booking_counters where day >= date '2099-01-01') then
    raise exception 'migration 27: a probe leaked a counter row';
  end if;
end $$;
