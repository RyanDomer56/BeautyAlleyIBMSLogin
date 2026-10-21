-- ===========================================================================
-- 18_booking_rooms_loyalty.sql
--
-- Migration 17 added the tables. This one puts them to work:
--
--   1. create_booking   - assigns a room, and applies the member rate
--   2. reschedule_booking - reports a room clash as ROOM_TAKEN, not SLOT_TAKEN
--   3. promote_client / revoke_membership - the manual 3-visit promotion
--   4. set_booking_room - the desk override on an existing booking
--
-- Why the room is assigned inside create_booking rather than in the API:
-- two walk-ins arriving at the same minute would both be told "room 3 is
-- free" by a read-then-write in Node, and the second would fail at the
-- exclusion constraint. Inside the transaction the search and the insert see
-- the same snapshot, and a genuine clash still surfaces as ROOM_TAKEN.
--
-- Why the member rate is folded into v_discount rather than a new column:
-- migration 05 pins `total_cents = subtotal_cents - discount_cents` as a
-- CHECK constraint. A separate member_discount column would break that
-- invariant for every booking. The promo portion is tracked separately so
-- promo_redemptions still records what the *code* was worth.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. create_booking, now room-aware and member-aware.
--
-- The old 9-argument function is DROPPED, not merely replaced: adding a
-- parameter creates an overload, and two functions named create_booking would
-- make PostgREST's named-argument call ambiguous ("function is not unique").
-- ---------------------------------------------------------------------------
drop function if exists public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean
);

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
  -- Appended last so the existing named-argument calls keep working. NULL
  -- means "assign one for me"; an id is the desk overriding the choice.
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

  -- 4b. member rate --------------------------------------------------------
  -- clients.discount_percent is set by staff via promote_client() and is 0
  -- until then, so this is a no-op for everyone who has not been promoted.
  -- Applied to the SUBTOTAL and added to the promo discount, which is what
  -- "3% on every booking, stacks with promos" means arithmetically.
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

  -- greatest(..., 0) rather than a bare subtraction: a 100% promo stacked on
  -- a 100% member rate would otherwise produce a negative total and trip the
  -- check constraint, turning a pricing edge case into a 500.
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
  -- amount_cents records the PROMO's worth only. Using v_discount here would
  -- book the member rate as promo revenue and overstate every code's return.
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
  'Creates a booking, assigning a room when the services need one. Folds the member rate into discount_cents so total = subtotal - discount still holds.';

-- ---------------------------------------------------------------------------
-- 2. reschedule_booking - same constraint discrimination as above.
--
-- The room is NOT re-assigned here. Moving a booking into a slot where its
-- room is busy is a real scheduling decision (does the desk move the room or
-- the time?), so it is reported rather than silently fixed.
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_new_start  timestamptz,
  p_actor      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking    public.bookings%rowtype;
  v_minutes    integer;
  v_new_end    timestamptz;
  v_jti        uuid;
  v_constraint text;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0006';
  end if;

  if v_booking.status in ('CANCELLED', 'COMPLETED', 'NO_SHOW') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0007';
  end if;

  if p_new_start is null or p_new_start <= now() then
    raise exception 'START_TIME_IN_PAST' using errcode = 'P0002';
  end if;

  -- Preserve the original duration rather than re-deriving it from services.
  v_minutes := (extract(epoch from (v_booking.end_time - v_booking.start_time)) / 60)::integer;
  v_new_end := p_new_start + make_interval(mins => v_minutes);

  begin
    update public.bookings
       set start_time = p_new_start,
           end_time   = v_new_end,
           status     = 'CONFIRMED',
           updated_at = now()
     where id = p_booking_id;
  exception
    when exclusion_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'bookings_room_no_overlap' then
        raise exception 'ROOM_TAKEN' using errcode = 'P0001';
      end if;
      raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;

  update public.qr_tokens
     set revoked_at = now()
   where booking_id = p_booking_id and revoked_at is null;

  insert into public.qr_tokens (booking_id, expires_at)
  values (p_booking_id, v_new_end + interval '1 day')
  returning jti into v_jti;

  perform public.write_audit(
    p_actor, 'booking.rescheduled', 'bookings', p_booking_id,
    jsonb_build_object('startTime', p_new_start, 'endTime', v_new_end)
  );

  return jsonb_build_object(
    'bookingId', p_booking_id,
    'startTime', p_new_start,
    'endTime',   v_new_end,
    'jti',       v_jti
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. promote_client() - the manual 3-visit promotion.
--
-- A function rather than a plain UPDATE so the eligibility rule lives in one
-- place and cannot be bypassed by a caller that forgets it. The visit count
-- is recomputed here from COMPLETED bookings - never trusted from the caller,
-- and never read from a stored counter that could have drifted.
-- ---------------------------------------------------------------------------
create or replace function public.promote_client(
  p_client_id        uuid,
  p_discount_percent integer default 3,
  p_actor            uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client      public.clients%rowtype;
  v_visits      integer;
  v_threshold   integer := public.membership_visit_threshold();
  v_member_since timestamptz;
begin
  if p_discount_percent is null or p_discount_percent < 0 or p_discount_percent > 100 then
    raise exception 'VALIDATION_FAILED: discount must be between 0 and 100' using errcode = 'P0002';
  end if;

  select * into v_client from public.clients where id = p_client_id for update;

  if not found or not v_client.is_active then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0006';
  end if;

  select count(*) into v_visits
    from public.bookings b
   where b.client_id = p_client_id
     and b.status = 'COMPLETED';

  -- The gate applies only to the FIRST promotion. Once someone is a member,
  -- staff may adjust the rate without them re-earning the visits - a
  -- goodwill upgrade must not require three more appointments.
  if v_client.member_since is null and v_visits < v_threshold then
    raise exception 'NOT_ELIGIBLE_FOR_MEMBERSHIP: % of % visits', v_visits, v_threshold
      using errcode = 'P0007';
  end if;

  v_member_since := coalesce(v_client.member_since, now());

  update public.clients
     set member_since     = v_member_since,
         discount_percent = p_discount_percent,
         updated_at       = now()
   where id = p_client_id;

  perform public.write_audit(
    p_actor, 'client.promoted', 'clients', p_client_id,
    jsonb_build_object(
      'discountPercent', p_discount_percent,
      'completedVisits', v_visits,
      'threshold',       v_threshold
    )
  );

  return jsonb_build_object(
    'clientId',         p_client_id,
    'memberSince',      v_member_since,
    'discountPercent',  p_discount_percent,
    'completedVisits',  v_visits,
    'threshold',        v_threshold
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. revoke_membership() - the undo.
--
-- Membership is stored as two facts, so revoking is clearing both. The visit
-- history is untouched: if the client comes back three more times they become
-- eligible again, which is the behaviour a salon would expect.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_membership(
  p_client_id uuid,
  p_actor     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_client public.clients%rowtype;
begin
  select * into v_client from public.clients where id = p_client_id for update;

  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0006';
  end if;

  update public.clients
     set member_since     = null,
         discount_percent = 0,
         updated_at       = now()
   where id = p_client_id;

  perform public.write_audit(
    p_actor, 'client.membership_revoked', 'clients', p_client_id,
    jsonb_build_object('previousDiscountPercent', v_client.discount_percent)
  );

  return jsonb_build_object(
    'clientId',        p_client_id,
    'memberSince',     null,
    'discountPercent', 0
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. set_booking_room() - the desk moving a booking to another room.
--
-- Separate from reschedule_booking because the two are different intents:
-- changing the room keeps the time, changing the time keeps the room. Folding
-- them together would make "move this to 3pm" able to silently relocate the
-- treatment as well.
-- ---------------------------------------------------------------------------
create or replace function public.set_booking_room(
  p_booking_id uuid,
  p_room_id    uuid,
  p_actor      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking    public.bookings%rowtype;
  v_room_type  public.room_type;
  v_room_name  text;
  v_required   public.room_type[];
  v_constraint text;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0006';
  end if;

  if v_booking.status in ('CANCELLED', 'COMPLETED', 'NO_SHOW') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0007';
  end if;

  if p_room_id is not null then
    select r.room_type, r.name into v_room_type, v_room_name
      from public.rooms r
     where r.id = p_room_id and r.is_active;

    if not found then
      raise exception 'ROOM_NOT_FOUND' using errcode = 'P0006';
    end if;

    -- Re-check the type against what the booked services need, resolved from
    -- the snapshots rather than a stored column, so a service whose
    -- requirement changed since booking is judged on its current rule.
    select array_agg(distinct s.required_room_type)
      into v_required
      from public.booking_items bi
      join public.services s on s.id = bi.service_id
     where bi.booking_id = p_booking_id
       and s.required_room_type is not null;

    if v_required is not null and not (v_room_type = any(v_required)) then
      raise exception 'ROOM_TYPE_MISMATCH: % is a % room', v_room_name, v_room_type
        using errcode = 'P0002';
    end if;
  end if;

  begin
    update public.bookings
       set room_id    = p_room_id,
           updated_at = now()
     where id = p_booking_id;
  exception
    when exclusion_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'bookings_room_no_overlap' then
        raise exception 'ROOM_TAKEN' using errcode = 'P0001';
      end if;
      raise exception 'SLOT_TAKEN' using errcode = 'P0001';
  end;

  perform public.write_audit(
    p_actor, 'booking.room_changed', 'bookings', p_booking_id,
    jsonb_build_object('from', v_booking.room_id, 'to', p_room_id)
  );

  return jsonb_build_object(
    'bookingId', p_booking_id,
    'roomId',    p_room_id,
    'roomType',  v_room_type
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges.
--
-- Migration 13 revoked EXECUTE from anon/authenticated and set
-- `alter default privileges` for future functions. That default did NOT take
-- effect here: creating a function grants EXECUTE to PUBLIC implicitly, and
-- anon inherits from PUBLIC, so all five arrived publicly executable. The
-- revoke is therefore stated explicitly rather than relied upon - the same
-- belt-and-braces ordering migration 13 itself uses.
--
-- All five are writes and stay service_role-only: they are meant to go through
-- the API so the rate limiter and request validation apply.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean, uuid
) from public, anon, authenticated;

revoke execute on function public.reschedule_booking(uuid, timestamptz, uuid)
  from public, anon, authenticated;
revoke execute on function public.promote_client(uuid, integer, uuid)
  from public, anon, authenticated;
revoke execute on function public.revoke_membership(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.set_booking_room(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean, uuid
) to service_role;

grant execute on function public.reschedule_booking(uuid, timestamptz, uuid) to service_role;
grant execute on function public.promote_client(uuid, integer, uuid) to service_role;
grant execute on function public.revoke_membership(uuid, uuid) to service_role;
grant execute on function public.set_booking_room(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Self-check: the new write functions must not be reachable with the
-- publishable key, and there must be exactly ONE create_booking (an overload
-- left behind would make the RPC call ambiguous at runtime).
-- ---------------------------------------------------------------------------
do $$
declare
  v_leaked    text;
  v_overloads integer;
begin
  select count(*) into v_overloads
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';

  if v_overloads <> 1 then
    raise exception 'expected exactly 1 create_booking, found %', v_overloads;
  end if;

  select string_agg(distinct p.proname, ', ' order by p.proname)
    into v_leaked
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'create_booking', 'reschedule_booking', 'promote_client',
       'revoke_membership', 'set_booking_room'
     )
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );

  if v_leaked is not null then
    raise exception 'write functions must not be executable by anon: %', v_leaked;
  end if;
end $$;
