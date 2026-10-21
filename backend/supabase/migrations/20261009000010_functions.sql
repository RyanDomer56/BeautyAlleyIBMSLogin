-- ===========================================================================
-- 10_functions.sql
--
-- All multi-row writes live here, as SECURITY DEFINER functions called through
-- PostgREST rpc(). The reasons this matters:
--
--   1. Atomicity. supabase-js cannot open a multi-statement transaction.
--      Creating a booking touches bookings + booking_items +
--      promo_redemptions + qr_tokens + audit_logs. Doing that from Node means
--      four round trips that can half-fail. In one PL/pgSQL function it is a
--      single transaction by construction.
--
--   2. Row locking. SELECT ... FOR UPDATE on the promo row serialises
--      concurrent redemptions, so max_redemptions cannot be exceeded by two
--      simultaneous requests.
--
--   3. One source of truth. The Node layer cannot drift from the rules, and
--      a second client (a script, a future admin tool) gets identical
--      behaviour.
--
-- Every function is `set search_path = public, extensions` so a SECURITY
-- DEFINER function cannot be hijacked by a caller-controlled search_path.
--
-- Error convention: `raise exception 'CODE' using errcode = '<class>'`.
-- The API maps the CODE string to an HTTP status. Custom classes:
--   P0001 conflict       P0002 bad request    P0003 forbidden
--   P0004 window passed  P0005 promo          P0006 not found
--   P0007 invalid state  P0008..P0011 QR
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- branch_timezone() - the salon's local timezone.
-- Read from the `app.branch_timezone` GUC so the Node layer can set it per
-- connection, falling back to the configured default.
-- ---------------------------------------------------------------------------
create or replace function public.branch_timezone()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('app.branch_timezone', true), ''), 'Asia/Manila')
$$;


-- ---------------------------------------------------------------------------
-- next_booking_reference() - BA-YYYYMMDD-NNNN
--
-- The INSERT ... ON CONFLICT DO UPDATE ... RETURNING is a single atomic
-- statement: Postgres locks the counter row, increments it and returns the new
-- value. Two concurrent calls cannot receive the same number.
-- ---------------------------------------------------------------------------
create or replace function public.next_booking_reference(p_day date default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_day  date := coalesce(p_day, (now() at time zone public.branch_timezone())::date);
  v_next integer;
begin
  insert into public.booking_counters (day, last_value)
  values (v_day, 1)
  on conflict (day) do update
     set last_value = public.booking_counters.last_value + 1
  returning last_value into v_next;

  return 'BA-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_next::text, 4, '0');
end;
$$;


-- ---------------------------------------------------------------------------
-- write_audit() - append-only audit trail.
-- ---------------------------------------------------------------------------
create or replace function public.write_audit(
  p_actor     uuid,
  p_action    text,
  p_entity    text,
  p_entity_id uuid,
  p_metadata  jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.audit_logs (actor_id, actor_role, action, entity, entity_id, metadata)
  values (
    p_actor,
    (select role from public.profiles where id = p_actor),
    p_action,
    p_entity,
    p_entity_id,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- validate_promo()
--
-- Returns a verdict rather than raising, so the same function serves both
-- "preview this code in the checkout UI" and "apply this code during a
-- booking". Reasons: NOT_FOUND, INACTIVE, NOT_STARTED, EXPIRED,
-- MIN_SPEND_NOT_MET, NOT_APPLICABLE, LIMIT_REACHED, OK.
--
-- When a promo is restricted to certain services, the discount is computed
-- against the subtotal of the *applicable* services only - not the whole cart.
-- ---------------------------------------------------------------------------
create or replace function public.validate_promo(
  p_code           extensions.citext,
  p_client_id      uuid default null,
  p_guest_phone    extensions.citext default null,
  p_service_ids    uuid[] default null,
  p_subtotal_cents integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_promo       public.promo_codes%rowtype;
  v_now         timestamptz := now();
  v_base        integer := coalesce(p_subtotal_cents, 0);
  v_discount    integer;
  v_used        integer;
  v_client_used integer;
begin
  if p_code is null or length(btrim(p_code::text)) = 0 then
    return jsonb_build_object('valid', false, 'reason', 'NOT_FOUND', 'discountCents', 0, 'promoCodeId', null);
  end if;

  select * into v_promo from public.promo_codes where code = p_code;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'NOT_FOUND', 'discountCents', 0, 'promoCodeId', null);
  end if;

  if not v_promo.is_active then
    return jsonb_build_object('valid', false, 'reason', 'INACTIVE', 'discountCents', 0, 'promoCodeId', v_promo.id);
  end if;

  if v_promo.starts_at is not null and v_now < v_promo.starts_at then
    return jsonb_build_object('valid', false, 'reason', 'NOT_STARTED', 'discountCents', 0, 'promoCodeId', v_promo.id);
  end if;

  if v_promo.ends_at is not null and v_now >= v_promo.ends_at then
    return jsonb_build_object('valid', false, 'reason', 'EXPIRED', 'discountCents', 0, 'promoCodeId', v_promo.id);
  end if;

  if v_base < v_promo.min_spend_cents then
    return jsonb_build_object('valid', false, 'reason', 'MIN_SPEND_NOT_MET', 'discountCents', 0,
                              'promoCodeId', v_promo.id, 'minSpendCents', v_promo.min_spend_cents);
  end if;

  -- Restrict to listed services, and re-base the discount on just those.
  if v_promo.applicable_service_ids is not null then
    select coalesce(sum(s.price_cents), 0)
      into v_base
      from public.services s
     where s.id = any(p_service_ids)
       and s.id = any(v_promo.applicable_service_ids);

    if v_base = 0 then
      return jsonb_build_object('valid', false, 'reason', 'NOT_APPLICABLE', 'discountCents', 0,
                                'promoCodeId', v_promo.id);
    end if;
  end if;

  -- Global cap, counting only live (unreleased) redemptions.
  if v_promo.max_redemptions is not null then
    select count(*) into v_used
      from public.promo_redemptions
     where promo_code_id = v_promo.id and released_at is null;

    if v_used >= v_promo.max_redemptions then
      return jsonb_build_object('valid', false, 'reason', 'LIMIT_REACHED', 'discountCents', 0,
                                'promoCodeId', v_promo.id);
    end if;
  end if;

  -- Per-customer cap. Identified by client id when registered, phone when guest.
  if v_promo.per_client_limit is not null
     and (p_client_id is not null or p_guest_phone is not null) then
    select count(*) into v_client_used
      from public.promo_redemptions
     where promo_code_id = v_promo.id
       and released_at is null
       and (
         (p_client_id is not null and client_id = p_client_id)
         or (p_client_id is null and p_guest_phone is not null and guest_phone = p_guest_phone)
       );

    if v_client_used >= v_promo.per_client_limit then
      return jsonb_build_object('valid', false, 'reason', 'LIMIT_REACHED', 'discountCents', 0,
                                'promoCodeId', v_promo.id);
    end if;
  end if;

  if v_promo.type = 'PERCENT' then
    v_discount := floor(v_base * v_promo.value / 100.0)::integer;
  else
    v_discount := v_promo.value;
  end if;

  -- A discount can never exceed the amount being discounted.
  v_discount := least(v_discount, v_base);

  return jsonb_build_object(
    'valid', true,
    'reason', 'OK',
    'discountCents', v_discount,
    'promoCodeId', v_promo.id,
    'code', v_promo.code,
    'type', v_promo.type,
    'value', v_promo.value
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_available_slots()
--
-- Free start times for a service on a date, derived from:
--   working hours  -  time off  -  existing live bookings  -  the past
-- and dropping any slot that would run past the end of the shift.
--
-- Times in working_hours are branch-local wall clock, so they are converted to
-- instants with `at time zone`. Slots are stepped by p_interval_minutes.
-- ---------------------------------------------------------------------------
create or replace function public.get_available_slots(
  p_service_id       uuid,
  p_date             date,
  p_employee_id      uuid default null,
  p_interval_minutes integer default 30,
  p_timezone         text default null
)
returns table (employee_id uuid, slot_start timestamptz, slot_end timestamptz)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_duration integer;
  v_tz       text := coalesce(nullif(p_timezone, ''), public.branch_timezone());
  v_step     interval;
begin
  select s.duration_minutes into v_duration
    from public.services s
   where s.id = p_service_id and s.is_active;

  if v_duration is null then
    return;  -- unknown or inactive service: no slots, not an error
  end if;

  v_step := make_interval(mins => greatest(coalesce(p_interval_minutes, 30), 5));

  return query
  with candidates as (
    select
      e.id                                        as emp_id,
      (p_date + wh.start_time) at time zone v_tz  as win_start,
      (p_date + wh.end_time)   at time zone v_tz  as win_end
      from public.employees e
      join public.working_hours wh on wh.employee_id = e.id
     where e.is_active
       and (p_employee_id is null or e.id = p_employee_id)
       and wh.weekday = extract(dow from p_date)::smallint
       and exists (
         select 1 from public.employee_services es
          where es.employee_id = e.id and es.service_id = p_service_id
       )
  ),
  slots as (
    select
      c.emp_id,
      gs                                                    as slot_start,
      gs + make_interval(mins => v_duration)                as slot_end
      from candidates c
      cross join lateral generate_series(
        c.win_start,
        c.win_end - make_interval(mins => v_duration),
        v_step
      ) as gs
  )
  select s.emp_id, s.slot_start, s.slot_end
    from slots s
   where s.slot_start > now()
     and not exists (
       select 1 from public.bookings b
        where b.employee_id = s.emp_id
          and b.status not in ('CANCELLED', 'NO_SHOW')
          and tstzrange(b.start_time, b.end_time) && tstzrange(s.slot_start, s.slot_end)
     )
     and not exists (
       select 1 from public.time_off t
        where t.employee_id = s.emp_id
          and tstzrange(t.starts_at, t.ends_at) && tstzrange(s.slot_start, s.slot_end)
     )
   order by s.slot_start, s.emp_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- create_booking()
--
-- The single entry point for creating a booking, guest or registered.
-- Steps, all inside one transaction:
--   1. validate the services and total the duration/price
--   2. resolve a guest identity or require a client
--   3. pick a qualified employee (or verify the requested one is qualified)
--   4. lock the promo row, then validate and apply the code
--   5. insert the booking - the EXCLUDE constraint is the real double-booking
--      guard; a violation becomes SLOT_TAKEN
--   6. write price snapshots into booking_items
--   7. record the promo redemption
--   8. mint a QR pass
--   9. append an audit entry
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
  p_enforce_hours boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tz          text := public.branch_timezone();
  v_local_start timestamp;
  v_count       integer;
  v_duration    integer;
  v_subtotal    integer;
  v_end         timestamptz;
  v_employee    uuid := p_employee_id;
  v_reference   text;
  v_booking_id  uuid;
  v_guest_name  text;
  v_guest_phone extensions.citext;
  v_promo       jsonb;
  v_discount    integer := 0;
  v_promo_id    uuid;
  v_total       integer;
  v_status      public.booking_status;
  v_jti         uuid;
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
  -- A booking must sit inside one of the employee's shifts. Working hours are
  -- branch-local wall clock, so the instants are converted before comparing.
  -- Without this, get_available_slots would refuse to *offer* 23:00 but the
  -- API would happily *accept* it - the classic "the UI is the validation
  -- layer" bug.
  if p_enforce_hours then
    v_local_start := p_start_time at time zone v_tz;

    -- The shift must contain the whole appointment. Comparing in the `time`
    -- domain (start + duration <= shift end) avoids a separate special case
    -- for appointments that cross midnight: they simply do not fit, because
    -- `time` cannot exceed 24:00.
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
      v_discount := (v_promo ->> 'discountCents')::integer;
      v_promo_id := (v_promo ->> 'promoCodeId')::uuid;
    else
      raise exception 'PROMO_%', upper(v_promo ->> 'reason') using errcode = 'P0005';
    end if;
  end if;

  v_total     := v_subtotal - v_discount;
  v_reference := public.next_booking_reference();

  -- Self-service (no actor) starts PENDING; staff-created starts CONFIRMED.
  v_status := case when p_actor is null then 'PENDING'::public.booking_status
                   else 'CONFIRMED'::public.booking_status end;

  -- 5. booking -------------------------------------------------------------
  begin
    insert into public.bookings (
      reference, client_id, guest_name, guest_phone, employee_id,
      start_time, end_time, status,
      subtotal_cents, discount_cents, total_cents, promo_code_id, notes
    ) values (
      v_reference, p_client_id, v_guest_name, v_guest_phone, v_employee,
      p_start_time, v_end, v_status,
      v_subtotal, v_discount, v_total, v_promo_id, p_notes
    )
    returning id into v_booking_id;
  exception
    when exclusion_violation then
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
      v_promo_id, v_booking_id, p_client_id, v_guest_phone, v_discount
    );
  end if;

  -- 8. QR pass -------------------------------------------------------------
  insert into public.qr_tokens (booking_id, expires_at)
  values (v_booking_id, v_end + interval '1 day')
  returning jti into v_jti;

  -- 9. audit ---------------------------------------------------------------
  perform public.write_audit(
    p_actor, 'booking.created', 'bookings', v_booking_id,
    jsonb_build_object('reference', v_reference, 'employeeId', v_employee, 'totalCents', v_total)
  );

  return jsonb_build_object(
    'bookingId',     v_booking_id,
    'reference',     v_reference,
    'employeeId',    v_employee,
    'startTime',     p_start_time,
    'endTime',       v_end,
    'status',        v_status,
    'subtotalCents', v_subtotal,
    'discountCents', v_discount,
    'totalCents',    v_total,
    'jti',           v_jti
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- cancel_booking()
-- Guards the cancellation window, revokes the QR pass and releases the promo
-- redemption so the code becomes usable again.
-- p_force bypasses the window check (staff override).
-- ---------------------------------------------------------------------------
create or replace function public.cancel_booking(
  p_booking_id   uuid,
  p_actor        uuid default null,
  p_reason       text default null,
  p_force        boolean default false,
  p_window_hours integer default 2
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking public.bookings%rowtype;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0006';
  end if;

  if v_booking.status = 'CANCELLED' then
    raise exception 'ALREADY_CANCELLED' using errcode = 'P0007';
  end if;

  if v_booking.status in ('COMPLETED', 'NO_SHOW') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0007';
  end if;

  if not p_force
     and v_booking.start_time - now() < make_interval(hours => greatest(coalesce(p_window_hours, 0), 0))
  then
    raise exception 'CANCELLATION_WINDOW_PASSED' using errcode = 'P0004';
  end if;

  update public.bookings
     set status              = 'CANCELLED',
         cancelled_at        = now(),
         cancellation_reason = p_reason,
         updated_at          = now()
   where id = p_booking_id;

  update public.qr_tokens
     set revoked_at = now()
   where booking_id = p_booking_id and revoked_at is null;

  update public.promo_redemptions
     set released_at = now()
   where booking_id = p_booking_id and released_at is null;

  perform public.write_audit(
    p_actor, 'booking.cancelled', 'bookings', p_booking_id,
    jsonb_build_object('reason', p_reason, 'forced', p_force)
  );

  return jsonb_build_object(
    'bookingId',   p_booking_id,
    'status',      'CANCELLED',
    'cancelledAt', now()
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- reschedule_booking()
-- Re-validates the slot, revokes the old pass and mints a new one.
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
  v_booking public.bookings%rowtype;
  v_minutes integer;
  v_new_end timestamptz;
  v_jti     uuid;
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
-- check_in_booking()
--
-- Redeems a QR pass. Atomic: lock the token, lock the booking, insert the
-- check-in, mark the token used, advance the status, audit.
--
-- The window is [start - p_window_minutes, end]. Scanning a pass for next
-- week's appointment should fail; so should scanning one after the slot has
-- already ended.
-- ---------------------------------------------------------------------------
create or replace function public.check_in_booking(
  p_jti            uuid,
  p_staff_id       uuid default null,
  p_actor          uuid default null,
  p_window_minutes integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token      public.qr_tokens%rowtype;
  v_booking    public.bookings%rowtype;
  v_now        timestamptz := now();
  v_checkin_id uuid;
begin
  select * into v_token from public.qr_tokens where jti = p_jti for update;

  if not found then
    raise exception 'QR_INVALID' using errcode = 'P0008';
  end if;

  if v_token.revoked_at is not null then
    raise exception 'QR_REVOKED' using errcode = 'P0010';
  end if;

  if v_token.expires_at <= v_now then
    raise exception 'QR_EXPIRED' using errcode = 'P0009';
  end if;

  select * into v_booking from public.bookings where id = v_token.booking_id for update;

  if v_booking.status = 'CHECKED_IN' then
    raise exception 'ALREADY_CHECKED_IN' using errcode = 'P0007';
  end if;

  if v_booking.status in ('CANCELLED', 'COMPLETED', 'NO_SHOW') then
    raise exception 'INVALID_STATUS_TRANSITION' using errcode = 'P0007';
  end if;

  if v_now < v_booking.start_time - make_interval(mins => greatest(coalesce(p_window_minutes, 0), 0)) then
    raise exception 'QR_TOO_EARLY' using errcode = 'P0011';
  end if;

  if v_now > v_booking.end_time then
    raise exception 'QR_TOO_LATE' using errcode = 'P0011';
  end if;

  insert into public.checkins (booking_id, staff_id)
  values (v_booking.id, p_staff_id)
  returning id into v_checkin_id;

  update public.qr_tokens set used_at = v_now where id = v_token.id;

  update public.bookings
     set status = 'CHECKED_IN', updated_at = v_now
   where id = v_booking.id;

  perform public.write_audit(
    p_actor, 'booking.checked_in', 'bookings', v_booking.id,
    jsonb_build_object('staffId', p_staff_id, 'jti', p_jti)
  );

  return jsonb_build_object(
    'bookingId',   v_booking.id,
    'reference',   v_booking.reference,
    'status',      'CHECKED_IN',
    'checkedInAt', v_now,
    'checkinId',   v_checkin_id
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_dashboard_summary()
-- Set-based aggregation. No per-day loop in Node.
-- ---------------------------------------------------------------------------
create or replace function public.get_dashboard_summary(
  p_from     date,
  p_to       date,
  p_timezone text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_tz    text := coalesce(nullif(p_timezone, ''), public.branch_timezone());
  v_start timestamptz := (p_from::timestamp) at time zone v_tz;
  v_end   timestamptz := ((p_to + 1)::timestamp) at time zone v_tz;
begin
  return jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'totals', (
      select jsonb_build_object(
        'bookings',     count(*),
        'completed',    count(*) filter (where b.status = 'COMPLETED'),
        'cancelled',    count(*) filter (where b.status = 'CANCELLED'),
        'noShow',       count(*) filter (where b.status = 'NO_SHOW'),
        'checkedIn',    count(*) filter (where b.status in ('CHECKED_IN', 'IN_SERVICE', 'COMPLETED')),
        'revenueCents', coalesce(sum(b.total_cents) filter (where b.status = 'COMPLETED'), 0)
      )
      from public.bookings b
      where b.start_time >= v_start and b.start_time < v_end
    ),
    'byDay', (
      select coalesce(jsonb_agg(row_to_json(d) order by d.day), '[]'::jsonb)
      from (
        select to_char((b.start_time at time zone v_tz)::date, 'YYYY-MM-DD') as day,
               count(*)                                                     as bookings,
               coalesce(sum(b.total_cents) filter (where b.status = 'COMPLETED'), 0) as revenue_cents
          from public.bookings b
         where b.start_time >= v_start and b.start_time < v_end
         group by 1
      ) d
    ),
    'topServices', (
      select coalesce(jsonb_agg(row_to_json(s)), '[]'::jsonb)
      from (
        select bi.name_snapshot                        as name,
               count(*)                                as bookings,
               coalesce(sum(bi.price_cents_snapshot), 0) as revenue_cents
          from public.booking_items bi
          join public.bookings b on b.id = bi.booking_id
         where b.start_time >= v_start
           and b.start_time < v_end
           and b.status = 'COMPLETED'
         group by 1
         order by 2 desc, 1
         limit 5
      ) s
    )
  );
end;
$$;


-- ---------------------------------------------------------------------------
-- get_employee_performance()
-- ---------------------------------------------------------------------------
create or replace function public.get_employee_performance(
  p_employee_id uuid,
  p_from        date,
  p_to          date,
  p_timezone    text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_tz    text := coalesce(nullif(p_timezone, ''), public.branch_timezone());
  v_start timestamptz := (p_from::timestamp) at time zone v_tz;
  v_end   timestamptz := ((p_to + 1)::timestamp) at time zone v_tz;
begin
  return (
    select jsonb_build_object(
      'employeeId',     e.id,
      'fullName',       e.full_name,
      'title',          e.title,
      'from',           p_from,
      'to',             p_to,
      'bookings',       count(b.id),
      'completed',      count(b.id) filter (where b.status = 'COMPLETED'),
      'cancelled',      count(b.id) filter (where b.status = 'CANCELLED'),
      'noShow',         count(b.id) filter (where b.status = 'NO_SHOW'),
      'revenueCents',   coalesce(sum(b.total_cents) filter (where b.status = 'COMPLETED'), 0),
      'minutesBooked',  coalesce(sum(
                          (extract(epoch from (b.end_time - b.start_time)) / 60)::integer
                        ) filter (where b.status not in ('CANCELLED', 'NO_SHOW')), 0)
    )
    from public.employees e
    left join public.bookings b
      on b.employee_id = e.id
     and b.start_time >= v_start
     and b.start_time < v_end
    where e.id = p_employee_id
    group by e.id, e.full_name, e.title
  );
end;
$$;
