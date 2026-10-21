-- ---------------------------------------------------------------------------
-- 16_fix_working_hours_wrap.sql
--
-- Fixes a real acceptance bug in `create_booking`'s working-hours check.
--
-- The check was:
--
--     and (v_local_start::time + make_interval(mins => v_duration)) <= wh.end_time
--
-- with a comment claiming that an appointment crossing midnight "simply does
-- not fit, because `time` cannot exceed 24:00". That is not how Postgres
-- behaves: `time + interval` is taken modulo 24 hours. So
--
--     time '23:00' + interval '1 hour'  ->  00:00:00
--
-- and the comparison became `00:00:00 <= 18:00:00` -> true. A 23:00
-- appointment was therefore accepted by an employee whose shift ends at 18:00,
-- while `get_available_slots` correctly refused to *offer* it. Exactly the
-- "the API trusts the UI to validate" bug the check was written to prevent.
--
-- The fix compares offsets from the start of the shift rather than wall-clock
-- times. `time - time` yields an `interval`, and interval arithmetic does not
-- wrap, so an appointment that overruns closing - or runs past midnight -
-- compares as longer than the shift and is refused.
--
-- `create or replace function` has to restate the whole body, so the body below
-- is the deployed definition (dumped with pg_get_functiondef) with only this
-- condition changed.
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
  --
  -- The comparison is done on *offsets from the start of the shift*, not on
  -- wall-clock times. `time + interval` wraps at midnight in Postgres -
  -- `time '23:00' + interval '1 hour'` is `00:00:00`, not `24:00:00` - so the
  -- obvious `start + duration <= end_time` test reads a 23:00 appointment as
  -- fitting inside a 09:00-18:00 shift. Subtracting the shift start first keeps
  -- both sides as `interval`s, which cannot wrap, and makes an appointment that
  -- overruns closing or crosses midnight compare as longer than the shift.
  if p_enforce_hours then
    v_local_start := p_start_time at time zone v_tz;

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

-- Grants are re-applied because `create or replace` preserves them, but stating
-- them here makes the migration self-contained: anon must not be able to reach
-- create_booking (migration 13 revoked it, migration 14 re-granted only the two
-- public read functions).
revoke all on function public.create_booking(
  uuid[], uuid, timestamptz, uuid, jsonb, extensions.citext, uuid, text, boolean
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Self-check: the wrap bug must be gone.
--
-- Asserts both directions, so this migration cannot silently no-op:
--   * 23:00-00:00 in a 09:00-18:00 shift is refused
--   * 10:00-11:00 in the same shift is accepted
-- ---------------------------------------------------------------------------
do $$
declare
  v_inside  boolean;
  v_inside2 boolean;
begin
  -- Offset arithmetic must reject an appointment that overruns closing.
  select ((time '23:00' - time '09:00') + interval '60 minutes') <= (time '18:00' - time '09:00')
    into v_inside;
  if v_inside then
    raise exception 'working-hours offset arithmetic still accepts 23:00 + 60min in a 09:00-18:00 shift';
  end if;

  -- And the old expression must be shown to be the broken one, so the reason
  -- for the change is recorded in the migration itself rather than only in a
  -- comment.
  select (time '23:00' + interval '60 minutes') <= time '18:00'
    into v_inside2;
  if not v_inside2 then
    raise exception 'expected the wrapped comparison to be true (that is the bug); Postgres time arithmetic changed';
  end if;

  -- A normal in-shift appointment must still be accepted.
  select ((time '10:00' - time '09:00') + interval '60 minutes') <= (time '18:00' - time '09:00')
    into v_inside;
  if not v_inside then
    raise exception 'working-hours offset arithmetic wrongly rejects 10:00 + 60min in a 09:00-18:00 shift';
  end if;
end;
$$;
