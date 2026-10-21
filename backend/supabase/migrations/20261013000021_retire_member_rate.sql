-- ---------------------------------------------------------------------------
-- Migration 21: retire the flat member rate from create_booking.
--
-- Migration 20 zeroed clients.discount_percent and introduced the one-time
-- loyalty reward, which made the member-rate block in create_booking dead code
-- (it is guarded by `if v_member_percent > 0`, and nothing can set it above 0).
-- This migration removes the corpse, and reworks promote_client so membership is
-- a STATUS rather than a rate.
--
-- Why split across two migrations: reproducing this ~320-line function by hand
-- is the kind of edit that silently drops a clause. Migration 20 made the block
-- inert first, so this one could be generated from the LIVE definition and
-- diffed against it, rather than retyped.
--
-- Signature is UNCHANGED (10 arguments), so CREATE OR REPLACE is safe and the
-- function's grants survive. Changing the arity would create an overload, and
-- two functions of one name make the PostgREST named-argument call ambiguous.
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

    -- Compared in the `time` domain to sidestep the midnight wrap: a shift
    -- that ends at 23:00 cannot contain a 22:30 start plus 90 minutes, and
    -- `time` arithmetic simply refuses it rather than wrapping to 00:00.
    if not exists (
      select 1
        from public.working_hours wh
       where wh.employee_id = v_employee
         and wh.weekday = extract(dow from v_local_start)::smallint
         and v_local_start::time >= wh.start_time
         and (v_local_start::time + make_interval(mins => v_duration)) <= wh.end_time
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
-- promote_client: membership becomes status-only.
--
-- The rate parameter is KEPT in the signature on purpose. Dropping it would
-- change the arity, create an overload, and break the existing named-argument
-- call from the API - the same trap migration 18 hit with create_booking. It is
-- accepted, validated, ignored, and reported back so a caller can see it had no
-- effect. The benefit of membership is now the one-time reward from
-- redeem_loyalty(), not a standing percentage.
-- ---------------------------------------------------------------------------
create or replace function public.promote_client(
  p_client_id        uuid,
  p_discount_percent integer default 3,   -- DEPRECATED: accepted, ignored.
  p_actor            uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $function$
declare
  v_client       public.clients%rowtype;
  v_visits       integer;
  v_threshold    integer := public.membership_visit_threshold();
  v_member_since timestamptz;
begin
  if p_discount_percent is null or p_discount_percent < 0 or p_discount_percent > 100 then
    raise exception 'VALIDATION_FAILED: discount must be between 0 and 100' using errcode = 'P0002';
  end if;

  select * into v_client from public.clients where id = p_client_id for update;

  if not found or not v_client.is_active then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- Eligibility is judged on ELIGIBLE completed visits, not all of them. A
  -- client who has had three IV drips has not earned haircut loyalty.
  select loyalty_visits into v_visits
    from public.v_client_loyalty
   where client_id = p_client_id;

  v_visits := coalesce(v_visits, 0);

  -- The gate applies only to the FIRST promotion. Once someone is a member,
  -- staff may adjust membership without them re-earning the visits.
  if v_client.member_since is null and v_visits < v_threshold then
    raise exception 'NOT_ELIGIBLE_FOR_MEMBERSHIP: % of % eligible visits', v_visits, v_threshold
      using errcode = 'P0007';
  end if;

  v_member_since := coalesce(v_client.member_since, now());

  update public.clients
     set member_since     = v_member_since,
         discount_percent = 0,
         updated_at       = now()
   where id = p_client_id;

  perform public.write_audit(
    p_actor, 'client.promoted', 'clients', p_client_id,
    jsonb_build_object(
      'eligibleVisits',        v_visits,
      'threshold',             v_threshold,
      'requestedDiscount',     p_discount_percent,
      'discountApplied',       0
    )
  );

  return jsonb_build_object(
    'clientId',          p_client_id,
    'memberSince',       v_member_since,
    'discountPercent',   0,
    'eligibleVisits',    v_visits,
    'threshold',         v_threshold,
    'loyaltyDiscountPercent', v_client.loyalty_discount_percent,
    'loyaltyRedeemedAt',      v_client.loyalty_redeemed_at
  );
end;
$function$;

-- Grants: 13_function_grants.sql's alter default privileges does not cover
-- functions created later, so state them explicitly.
revoke all on function public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean, uuid
) to service_role;

revoke all on function public.promote_client(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.promote_client(uuid, integer, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_def   text;
begin
  -- Exactly one create_booking, still 10 arguments.
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';
  if v_count <> 1 then
    raise exception 'migration 21: expected exactly 1 create_booking, found %', v_count;
  end if;

  -- The member rate is genuinely gone from the body.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';

  if v_def like '%v_member%' then
    raise exception 'migration 21: create_booking still references v_member*';
  end if;

  -- And nothing can put a rate back.
  select count(*) into v_count from public.clients where discount_percent <> 0;
  if v_count > 0 then
    raise exception 'migration 21: % client(s) carry a non-zero discount_percent', v_count;
  end if;
end $$;
