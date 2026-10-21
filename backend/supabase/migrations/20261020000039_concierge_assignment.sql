-- ===========================================================================
-- 39. The front desk assigns the stylist, not the client
--
-- The public booking page used to ask the visitor to pick a stylist. That is
-- the desk's decision: a client has no idea who is qualified for the treatment
-- they chose, who is on leave, or whose shift actually covers the time. Once
-- the picker comes off that page, `create_booking`'s auto-assign branch stops
-- being a fallback and becomes the only path - so it has to be correct.
--
--   1. create_booking   - auto-assign now honours working hours, and picks
--                         at random among the stylists who are genuinely free
--                         rather than always taking the lowest uuid.
--   2. reassign_booking_employee() - the desk's override, audited.
--
-- Why the working-hours check matters here
-- ----------------------------------------
-- The old branch filtered on qualification, overlapping bookings and leave,
-- then handed the winner to the working-hours check further down. If the
-- lowest-uuid stylist was qualified but not rostered for that time, the whole
-- booking failed with OUTSIDE_WORKING_HOURS even though a colleague was free.
-- That was survivable while a human was choosing; with the choice removed it
-- would reject bookings the slot grid had just offered.
--
-- The check itself is migration 16's offset form, not migration 18's wall
-- clock form. `time + interval` wraps at midnight in Postgres, so
-- `time '23:00' + interval '1 hour'` is `00:00:00` - which is `<= 18:00`, and
-- a 23:00 appointment would be accepted by a stylist who leaves at six. Every
-- comparison below therefore subtracts the shift start first and compares
-- intervals, which cannot wrap. Migration 16 fixed this; migration 18 lost it
-- again, and this file must not lose it a third time.
--
-- Why random
-- ----------
-- `order by e.id` sent every unassigned booking to the same stylist, which is
-- both unfair on commission and a capacity problem - one chair fills while the
-- others idle. Random spreads the walk-in load. The desk can still override,
-- which is the second half of the requirement.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. create_booking - migration 18's body, with the auto-assign branch fixed.
--
-- Everything else is unchanged. The function is restated in full because
-- PL/pgSQL has no way to patch one branch of an existing body.
-- ---------------------------------------------------------------------------
create or replace function public.create_booking(
  p_service_ids uuid[],
  p_employee_id uuid default null,
  p_start_time  timestamptz default null,
  p_client_id   uuid default null,
  p_guest       jsonb default null,
  p_promo_code  extensions.citext default null,
  p_actor       uuid default null,
  p_notes       text default null,
  p_enforce_hours boolean default true,
  p_room_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
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
  v_member_discount integer := 0;
  v_member_percent  integer := 0;
  v_discount        integer := 0;
  v_promo_id        uuid;
  v_total           integer;
  v_status          public.booking_status;
  v_jti             uuid;
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
    -- The visitor no longer names a stylist, so this is the only assignment
    -- path for a self-service booking. Every condition the explicit branch is
    -- held to is applied here as well - including the shift - because there is
    -- no human left to notice that the chosen person is not rostered.
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
       and (
         not p_enforce_hours
         or exists (
           select 1
             from public.working_hours wh
            where wh.employee_id = e.id
              and wh.weekday = extract(dow from (p_start_time at time zone v_tz))::smallint
              and (p_start_time at time zone v_tz)::time >= wh.start_time
              and ((p_start_time at time zone v_tz)::time - wh.start_time)
                    + make_interval(mins => v_duration)
                  <= (wh.end_time - wh.start_time)
         )
       )
     order by random()
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

    -- Offsets from the start of the shift, not wall-clock times: see the note
    -- at the top of this file. A shift that ends at 18:00 cannot contain a
    -- 23:00 start plus 60 minutes, and interval arithmetic says so.
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
  select array_agg(distinct s.required_room_type)
    into v_room_types
    from public.services s
   where s.id = any(p_service_ids)
     and s.required_room_type is not null;

  if v_room is null then
    if v_room_types is not null and array_length(v_room_types, 1) > 1 then
      raise exception 'ROOM_REQUIRED: services need %', array_to_string(v_room_types, ' + ')
        using errcode = 'P0002';
    end if;

    if v_room_types is not null then
      v_room_type := v_room_types[1];

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
    select r.room_type, r.name into v_room_type, v_room_name
      from public.rooms r
     where r.id = v_room and r.is_active;

    if not found then
      raise exception 'ROOM_NOT_FOUND' using errcode = 'P0006';
    end if;

    if v_room_types is not null and not (v_room_type = any(v_room_types)) then
      raise exception 'ROOM_TYPE_MISMATCH: % is a % room', v_room_name, v_room_type
        using errcode = 'P0002';
    end if;
  end if;

  -- 4. promo ---------------------------------------------------------------
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

  -- 4b. member rate --------------------------------------------------------
  if p_client_id is not null then
    select c.discount_percent into v_member_percent
      from public.clients c
     where c.id = p_client_id;

    v_member_percent := coalesce(v_member_percent, 0);

    if v_member_percent > 0 then
      v_member_discount := round(v_subtotal * v_member_percent / 100.0)::integer;
      v_discount        := v_discount + v_member_discount;
    end if;
  end if;

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
      'totalCents', v_total,
      'memberDiscountCents', v_member_discount
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
    'memberDiscountCents', v_member_discount,
    'promoDiscountCents',  v_promo_discount,
    'totalCents',          v_total,
    'jti',                 v_jti
  );
end;
$$;

comment on function public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean, uuid
) is
  'Creates a booking. With no employee id, picks a qualified, rostered, free stylist at random - the desk reassigns if it disagrees.';

-- ---------------------------------------------------------------------------
-- 2. reassign_booking_employee() - the desk's override.
--
-- Separate from reschedule_booking for the same reason set_booking_room is:
-- changing who delivers a treatment keeps the time and the room. Folding it
-- into a reschedule would let "put Maria on this" silently move the
-- appointment.
--
-- The checks mirror the explicit branch of create_booking, because the desk
-- can only move a booking onto someone who could have been booked for it in
-- the first place. Without them, a reassignment is a way around the
-- qualification, leave and availability rules.
-- ---------------------------------------------------------------------------
create or replace function public.reassign_booking_employee(
  p_booking_id  uuid,
  p_employee_id uuid,
  p_actor       uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking     public.bookings%rowtype;
  v_minutes     integer;
  v_local_start timestamp;
  v_tz          text := public.branch_timezone();
  v_constraint  text;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- Once the service has started the stylist is a record, not a plan.
  if v_booking.status in ('CANCELLED', 'COMPLETED', 'NO_SHOW', 'IN_SERVICE') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0007';
  end if;

  if p_employee_id is null then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0006';
  end if;

  if not exists (
    select 1 from public.employees where id = p_employee_id and is_active
  ) then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- Qualified for every treatment on the booking. Read from booking_items
  -- rather than the requested ids, so a service that has since been edited or
  -- retired is judged on what was actually booked.
  if exists (
    select 1
      from public.booking_items bi
     where bi.booking_id = p_booking_id
       and bi.service_id is not null
       and not exists (
         select 1 from public.employee_services es
          where es.employee_id = p_employee_id
            and es.service_id = bi.service_id
       )
  ) then
    raise exception 'EMPLOYEE_NOT_QUALIFIED' using errcode = 'P0003';
  end if;

  v_minutes     := (extract(epoch from (v_booking.end_time - v_booking.start_time)) / 60)::integer;
  v_local_start := v_booking.start_time at time zone v_tz;

  if not exists (
    select 1
      from public.working_hours wh
     where wh.employee_id = p_employee_id
       and wh.weekday = extract(dow from v_local_start)::smallint
       and v_local_start::time >= wh.start_time
       and (v_local_start::time - wh.start_time) + make_interval(mins => v_minutes)
           <= (wh.end_time - wh.start_time)
  ) then
    raise exception 'OUTSIDE_WORKING_HOURS' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.time_off t
     where t.employee_id = p_employee_id
       and tstzrange(t.starts_at, t.ends_at) && tstzrange(v_booking.start_time, v_booking.end_time)
  ) then
    raise exception 'EMPLOYEE_UNAVAILABLE' using errcode = 'P0013';
  end if;

  begin
    update public.bookings
       set employee_id = p_employee_id,
           updated_at  = now()
     where id = p_booking_id;
  exception
    when exclusion_violation then
      -- Only the employee constraint can fire here: the room is unchanged.
      raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;

  -- The snapshots carry the delivering employee too, so a report that joins
  -- through booking_items does not still credit the previous stylist.
  update public.booking_items
     set employee_id = p_employee_id
   where booking_id = p_booking_id;

  perform public.write_audit(
    p_actor, 'booking.employee_assigned', 'bookings', p_booking_id,
    jsonb_build_object('from', v_booking.employee_id, 'to', p_employee_id)
  );

  return jsonb_build_object(
    'bookingId',  p_booking_id,
    'employeeId', p_employee_id
  );
end;
$$;

comment on function public.reassign_booking_employee(uuid, uuid, uuid) is
  'Moves a booking to another stylist, enforcing qualification, shift, leave and overlap. Audited.';

revoke all on function public.reassign_booking_employee(uuid, uuid, uuid) from public;
revoke all on function public.reassign_booking_employee(uuid, uuid, uuid) from anon, authenticated;
grant execute on function public.reassign_booking_employee(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Self-checks
-- ---------------------------------------------------------------------------
do $$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';

  if v_src is null then
    raise exception 'create_booking is missing';
  end if;

  -- The auto-assign branch must consider working hours and must not always
  -- hand the booking to the same uuid.
  if position('working_hours wh' in v_src) = 0 then
    raise exception 'create_booking auto-assign does not check working hours';
  end if;
  if position('order by random()' in v_src) = 0 then
    raise exception 'create_booking auto-assign is not random';
  end if;

  -- Migration 16's fix must still be in place. The wall-clock form wraps at
  -- midnight and accepts a 23:00 booking in a shift that ends at 18:00.
  if position('wh.end_time - wh.start_time' in v_src) = 0 then
    raise exception 'create_booking lost the offset working-hours comparison';
  end if;

  select prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reassign_booking_employee';

  if v_src is null then
    raise exception 'reassign_booking_employee was not created';
  end if;

  if position('write_audit' in v_src) = 0 then
    raise exception 'reassign_booking_employee does not write an audit row';
  end if;

  if position('wh.end_time - wh.start_time' in v_src) = 0 then
    raise exception 'reassign_booking_employee uses the wrapping hours comparison';
  end if;

  if has_function_privilege(
       'anon',
       'public.reassign_booking_employee(uuid, uuid, uuid)',
       'EXECUTE'
     ) then
    raise exception 'reassign_booking_employee is executable by anon';
  end if;
end;
$$;
