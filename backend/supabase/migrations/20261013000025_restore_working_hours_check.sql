-- ---------------------------------------------------------------------------
-- Migration 25: restore the working-hours check that migration 18 reverted.
--
-- Migration 16 fixed a real acceptance bug: `create_booking` compared the
-- appointment's end against the shift end using `time + interval`, which
-- Postgres takes modulo 24 hours. `time '23:00' + interval '1 hour'` is
-- `00:00`, and `00:00 <= '18:00'` is true, so a 23:00 appointment was
-- accepted by an employee whose shift ends at 18:00 - while
-- `get_available_slots` correctly refused to *offer* it. That is precisely the
-- "the API trusts the UI to validate" bug the check exists to prevent.
--
-- Migration 18 (rooms) restated the whole function from a body that predated
-- migration 16, so the wrap came back. Migration 21 then regenerated the
-- function from the live definition and faithfully carried the regression
-- forward - the diff proved nothing else had moved, which is exactly why the
-- stale clause survived: it was already live.
--
-- Found by `tests/integration/bookings.test.ts` ("refuses a time outside the
-- stylist's working hours"), which had been failing since migration 18.
--
-- The body below is the deployed definition, dumped with pg_get_functiondef
-- and changed in exactly two places: the comparison, and the comment that
-- claimed the wrap could not happen.
--
-- Offset arithmetic, not wall-clock:
--
--   (v_local_start::time - wh.start_time) + duration <= (wh.end_time - wh.start_time)
--
-- `time - time` yields an interval and interval arithmetic does not wrap, so an
-- appointment that overruns closing - or runs past midnight - compares as
-- longer than the shift and is refused.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_booking(p_service_ids uuid[], p_employee_id uuid DEFAULT NULL::uuid, p_start_time timestamp with time zone DEFAULT NULL::timestamp with time zone, p_client_id uuid DEFAULT NULL::uuid, p_guest jsonb DEFAULT NULL::jsonb, p_promo_code citext DEFAULT NULL::citext, p_actor uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text, p_enforce_hours boolean DEFAULT true, p_room_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_tz              text := public.branch_timezone();
  v_local_start     timestamp;
  v_count           integer;
  v_duration        integer;
  v_subtotal        integer;
  v_end             timestamptz;
  v_employee        uuid := p_employee_id;
  v_reference       text;
  v_booking_id      uuid;
  v_guest_name      text;
  v_guest_phone     extensions.citext;
  v_promo           jsonb;
  v_promo_discount  integer := 0;
  v_discount        integer := 0;
  v_promo_id        uuid;
  v_total           integer;
  v_status          public.booking_status;
  v_jti             uuid;
  -- migration 18
  v_room            uuid := p_room_id;
  v_room_type       public.room_type;
  v_room_types      public.room_type[];
  v_room_name       text;
  v_constraint      text;
begin
  -- 1. services ------------------------------------------------------------
  if p_service_ids is null or array_length(p_service_ids, 1) is null then
    raise exception 'SERVICES_REQUIRED' using errcode = 'P0002';
  end if;

  select count(*), coalesce(sum(s.duration_minutes), 0), coalesce(sum(s.price_cents), 0)
    into v_count, v_duration, v_subtotal
    from public.services s
   where s.id = any(p_service_ids) and s.is_active;

  if v_count <> array_length(p_service_ids, 1) then
    raise exception 'SERVICES_INVALID' using errcode = 'P0002';
  end if;

  if p_start_time is null then
    raise exception 'START_TIME_REQUIRED' using errcode = 'P0002';
  end if;

  if p_start_time <= now() then
    raise exception 'START_TIME_IN_PAST' using errcode = 'P0002';
  end if;

  v_end := p_start_time + make_interval(mins => v_duration);

  -- 2. identity ------------------------------------------------------------
  if p_guest is not null then
    v_guest_name  := nullif(btrim(coalesce(p_guest ->> 'name', '')), '');
    v_guest_phone := nullif(btrim(coalesce(p_guest ->> 'phone', '')), '')::extensions.citext;
  end if;

  if p_client_id is null and v_guest_phone is null then
    raise exception 'CLIENT_REQUIRED' using errcode = 'P0002';
  end if;

  -- 3. employee ------------------------------------------------------------
  if v_employee is null then
    select e.id into v_employee
      from public.employees e
     where e.is_active
       and not exists (
         select 1 from unnest(p_service_ids) sid
          where not exists (
            select 1 from public.employee_services es
             where es.employee_id = e.id and es.service_id = sid
          )
       )
       and not exists (
         select 1 from public.bookings b
          where b.employee_id = e.id
            and b.status not in ('CANCELLED', 'NO_SHOW')
            and tstzrange(b.start_time, b.end_time) && tstzrange(p_start_time, v_end)
       )
       and not exists (
         select 1 from public.time_off t
          where t.employee_id = e.id
            and tstzrange(t.starts_at, t.ends_at) && tstzrange(p_start_time, v_end)
       )
     order by e.id
     limit 1;

    if v_employee is null then
      raise exception 'NO_EMPLOYEE_AVAILABLE' using errcode = 'P0001';
    end if;
  else
    if not exists (select 1 from public.employees where id = v_employee and is_active) then
      raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0006';
    end if;

    if exists (
      select 1 from unnest(p_service_ids) sid
       where not exists (
         select 1 from public.employee_services es
          where es.employee_id = v_employee and es.service_id = sid
       )
    ) then
      raise exception 'EMPLOYEE_NOT_QUALIFIED' using errcode = 'P0003';
    end if;
  end if;

  -- 3b. working hours ------------------------------------------------------
  if p_enforce_hours then
    v_local_start := p_start_time at time zone v_tz;

    -- Compared as OFFSETS from the start of the shift, not as wall-clock
    -- times. `time + interval` is taken modulo 24 hours, so
    -- `time '23:00' + interval '1 hour'` is `00:00`, and `00:00 <= '18:00'`
    -- is true - a 23:00 appointment was accepted by an employee whose shift
    -- ends at 18:00. `time - time` yields an interval, and interval
    -- arithmetic does not wrap, so an overrun compares as longer than the
    -- shift and is refused. (Migration 16 made exactly this change; the
    -- migration that added rooms restated the function from a stale body and
    -- silently put the wrap back.)
    if not exists (
      select 1
        from public.working_hours wh
       where wh.employee_id = v_employee
         and wh.weekday = extract(dow from v_local_start)::smallint
         and v_local_start::time >= wh.start_time
         and (v_local_start::time - wh.start_time) + make_interval(mins => v_duration)
            <= (wh.end_time - wh.start_time)
    ) then
      raise exception 'OUTSIDE_WORKING_HOURS' using errcode = 'P0002';
    end if;
  end if;

  -- 3c. room ---------------------------------------------------------------
  -- The distinct room types the requested services need. A service with a
  -- NULL required_room_type needs no room, so it contributes nothing here -
  -- a booking of only such services leaves v_room_types NULL and skips the
  -- whole block.
  select array_agg(distinct s.required_room_type)
    into v_room_types
    from public.services s
   where s.id = any(p_service_ids)
     and s.required_room_type is not null;

  if v_room is null then
    if v_room_types is not null and array_length(v_room_types, 1) > 1 then
      -- One booking occupies one room, so a mixed basket cannot be satisfied
      -- automatically. Guessing would put a massage in a facial room and the
      -- therapist would be the one to discover it.
      raise exception 'ROOM_REQUIRED: services need %', array_to_string(v_room_types, ' + ')
        using errcode = 'P0002';
    end if;

    if v_room_types is not null then
      v_room_type := v_room_types[1];

      -- Ordered by name so the choice is deterministic: the same booking
      -- always lands in the same room and the desk can predict it. The
      -- overlap test is the half-open one the exclusion constraint uses.
      select r.id into v_room
        from public.rooms r
       where r.is_active
         and r.room_type = v_room_type
         and not exists (
           select 1 from public.bookings b
            where b.room_id = r.id
              and b.status not in ('CANCELLED', 'NO_SHOW')
              and tstzrange(b.start_time, b.end_time) && tstzrange(p_start_time, v_end)
         )
       order by r.name
       limit 1;

      if v_room is null then
        raise exception 'NO_ROOM_AVAILABLE: no free % room for that slot', v_room_type
          using errcode = 'P0001';
      end if;
    end if;
  else
    -- Desk override. Verified before the insert so the failure names the
    -- problem instead of arriving as a bare conflict.
    select r.room_type, r.name into v_room_type, v_room_name
      from public.rooms r
     where r.id = v_room and r.is_active;

    if not found then
      raise exception 'ROOM_NOT_FOUND' using errcode = 'P0006';
    end if;

    -- Only checked when the services actually declare a requirement, so a
    -- room may still be reserved for a service that does not need one.
    if v_room_types is not null and not (v_room_type = any(v_room_types)) then
      raise exception 'ROOM_TYPE_MISMATCH: % is a % room', v_room_name, v_room_type
        using errcode = 'P0002';
    end if;
  end if;

  -- 4. promo ---------------------------------------------------------------
  -- FOR UPDATE first: this serialises concurrent redemptions of the same code
  -- so the max_redemptions count read on the next line cannot be stale.
  if p_promo_code is not null and length(btrim(p_promo_code::text)) > 0 then
    select id into v_promo_id
      from public.promo_codes
     where code = p_promo_code
     for update;

    v_promo := public.validate_promo(p_promo_code, p_client_id, v_guest_phone, p_service_ids, v_subtotal);

    if (v_promo ->> 'valid')::boolean then
      v_promo_discount := (v_promo ->> 'discountCents')::integer;
      v_discount       := v_promo_discount;
      v_promo_id       := (v_promo ->> 'promoCodeId')::uuid;
    else
      raise exception 'PROMO_%', upper(v_promo ->> 'reason') using errcode = 'P0005';
    end if;
  end if;

  -- 4b. loyalty reward ------------------------------------------------------
  -- Deliberately NOT applied here. The reward is a ONE-TIME 10% spent on the
  -- third completed eligible visit, and this function runs BEFORE the visit is
  -- delivered - so it cannot know whether that visit will complete. Booking-time
  -- is the wrong moment to decide it.
  --
  -- The concierge spends it at payment time via public.redeem_loyalty(), which
  -- flips clients.loyalty_redeemed_at in a single guarded UPDATE. That keeps the
  -- reward both once-only and self-correcting: a cancelled visit never earns it.
  -- (The old flat member rate that used to live here was retired in migration 20.)

  -- greatest(..., 0) rather than a bare subtraction: a promo worth more than
  -- the subtotal would otherwise produce a negative total and trip the check
  -- constraint, turning a pricing edge case into a 500.
  v_total     := greatest(v_subtotal - v_discount, 0);
  v_reference := public.next_booking_reference();

  -- Self-service (no actor) starts PENDING; staff-created starts CONFIRMED.
  v_status := case when p_actor is null then 'PENDING'::public.booking_status
                   else 'CONFIRMED'::public.booking_status end;

  -- 5. booking -------------------------------------------------------------
  begin
    insert into public.bookings (
      reference, client_id, guest_name, guest_phone, employee_id,
      start_time, end_time, status,
      subtotal_cents, discount_cents, total_cents, promo_code_id, notes, room_id
    ) values (
      v_reference, p_client_id, v_guest_name, v_guest_phone, v_employee,
      p_start_time, v_end, v_status,
      v_subtotal, v_discount, v_total, v_promo_id, p_notes, v_room
    )
    returning id into v_booking_id;
  exception
    when exclusion_violation then
      -- Two constraints can fire here and they mean different things to the
      -- person at the desk: the stylist is busy, or the room is. Reporting
      -- both as SLOT_TAKEN would send them looking for the wrong problem.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'bookings_room_no_overlap' then
        raise exception 'ROOM_TAKEN' using errcode = 'P0001';
      end if;
      raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;

  -- 6. price snapshots -----------------------------------------------------
  insert into public.booking_items (
    booking_id, service_id, employee_id,
    name_snapshot, price_cents_snapshot, duration_minutes_snapshot
  )
  select v_booking_id, s.id, v_employee, s.name, s.price_cents, s.duration_minutes
    from public.services s
   where s.id = any(p_service_ids);

  -- 7. redemption ----------------------------------------------------------
  -- amount_cents records the PROMO's worth only. v_discount is the right number
  -- for the booking, but booking it here would overstate every code's return.
  if v_promo_id is not null then
    insert into public.promo_redemptions (
      promo_code_id, booking_id, client_id, guest_phone, amount_cents
    ) values (
      v_promo_id, v_booking_id, p_client_id, v_guest_phone, v_promo_discount
    );
  end if;

  -- 8. QR pass -------------------------------------------------------------
  insert into public.qr_tokens (booking_id, expires_at)
  values (v_booking_id, v_end + interval '1 day')
  returning jti into v_jti;

  -- 9. audit ---------------------------------------------------------------
  perform public.write_audit(
    p_actor, 'booking.created', 'bookings', v_booking_id,
    jsonb_build_object(
      'reference', v_reference,
      'employeeId', v_employee,
      'roomId', v_room,
      'totalCents', v_total
    )
  );

  return jsonb_build_object(
    'bookingId',           v_booking_id,
    'reference',           v_reference,
    'employeeId',          v_employee,
    'roomId',              v_room,
    'roomType',            v_room_type,
    'startTime',           p_start_time,
    'endTime',             v_end,
    'status',              v_status,
    'subtotalCents',       v_subtotal,
    'discountCents',       v_discount,
    'promoDiscountCents',  v_promo_discount,
    'totalCents',          v_total,
    'jti',                 v_jti
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Self-checks.
--
-- Two layers, because they catch different mistakes.
--
-- 1. The source text. Cheap, and it catches a regeneration that quietly puts
--    the wall-clock form back - which is exactly how this bug survived two
--    migrations. It would also pass on a function that merely mentions the
--    right words, which is why it is not the only check.
--
-- 2. A behavioural probe against the real function, with the expected verdict
--    computed independently as an oracle rather than assumed. The probe never
--    writes: it only calls create_booking when the oracle already says the
--    appointment is outside the shift, so a correct function raises before it
--    reaches the INSERT. If the function is still broken the INSERT succeeds,
--    the migration then fails, and migrate.js rolls the whole file back - so
--    the bad row cannot persist either way.
--
-- The oracle matters because "23:00 is outside a 09:00-18:00 shift" is a fact
-- about the *seed*, not about the code. If the branch ever opens a 24-hour
-- shift the assertion would be wrong, so the check derives the expected answer
-- from the employee's actual hours and skips rather than lying.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_src   text;
begin
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';
  if v_count <> 1 then
    raise exception 'migration 25: expected exactly 1 create_booking, found %', v_count;
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';

  if v_src like '%v_local_start::time + make_interval%' then
    raise exception 'migration 25: the wrapping wall-clock comparison is still present';
  end if;
  if v_src not like '%(v_local_start::time - wh.start_time)%' then
    raise exception 'migration 25: the offset comparison is missing';
  end if;
end $$;

do $$
declare
  v_employee   uuid;
  v_service    uuid;
  v_duration   integer;
  v_slot       timestamptz;
  v_local      timestamp;
  v_within     boolean;
begin
  -- A pair the employee is actually qualified for, so the probe reaches the
  -- working-hours check instead of stopping at EMPLOYEE_NOT_QUALIFIED.
  select es.employee_id, es.service_id, s.duration_minutes
    into v_employee, v_service, v_duration
    from public.employee_services es
    join public.services s on s.id = es.service_id
   order by es.employee_id, es.service_id
   limit 1;

  if v_employee is null then
    raise notice 'migration 25: no employee/service pair to exercise - skipping the behavioural probe';
    return;
  end if;

  -- 23:00 Manila, two days out so it is unambiguously in the future whatever
  -- the branch timezone offset is.
  v_slot  := (date_trunc('day', now() at time zone public.branch_timezone())
              + interval '2 days' + interval '23 hours') at time zone public.branch_timezone();
  v_local := v_slot at time zone public.branch_timezone();

  -- The oracle: the same question, asked with offset arithmetic that cannot
  -- wrap. This is the invariant the migration restores.
  select exists (
    select 1
      from public.working_hours wh
     where wh.employee_id = v_employee
       and wh.weekday = extract(dow from v_local)::smallint
       and (v_local::time - wh.start_time) + make_interval(mins => v_duration)
           <= (wh.end_time - wh.start_time)
  ) into v_within;

  if v_within then
    raise notice 'migration 25: this branch is open at 23:00 - skipping the behavioural probe';
    return;
  end if;

  begin
    perform public.create_booking(
      p_service_ids   => array[v_service],
      p_employee_id   => v_employee,
      p_start_time    => v_slot,
      p_guest         => jsonb_build_object('name', '__migration25_probe', 'phone', '+639000000000'),
      p_enforce_hours => true);

    -- Reached only if the appointment was accepted, i.e. the wrap is still
    -- live. Failing here also rolls back the row that was just written.
    raise exception 'migration 25: a 23:00 appointment was ACCEPTED - the wrap is still live';
  exception
    when others then
      if sqlerrm like 'OUTSIDE_WORKING_HOURS%' then
        raise notice 'migration 25: a 23:00 appointment is correctly refused';
      elsif sqlerrm = 'migration 25: a 23:00 appointment was ACCEPTED - the wrap is still live' then
        raise;
      else
        -- Something else stopped the probe before the check under test - a
        -- room clash, a qualification miss. That proves nothing, so it must
        -- not be allowed to look like a pass.
        raise exception 'migration 25: probe stopped early with: %', sqlerrm;
      end if;
  end;
end $$;
