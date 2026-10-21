-- ===========================================================================
-- 32. Booking correctness
--
-- Three defects that a staff pilot would hit within a week. They are unrelated
-- in cause, so each is documented where it is fixed.
--
--   1. v_booking_detail had no service ids, so `GET /bookings?serviceId=...`
--      was accepted, validated and then silently ignored - the caller got
--      every booking and no error. A filter that does nothing is worse than
--      no filter, because it is trusted.
--
--   2. reschedule_booking forced `status = 'CONFIRMED'` unconditionally. For a
--      booking already CHECKED_IN or IN_SERVICE that is an illegal transition,
--      so the status trigger raised INVALID_STATUS_TRANSITION - an error about
--      the status machine in response to a request about the time. The guard
--      below rejects the real problem with a code that names it.
--
--   3. An explicitly chosen employee skipped the time_off check. Only the
--      auto-assign branch consulted it, so booking a named stylist who was on
--      leave succeeded. Fixed with a trigger rather than by editing the
--      300-line create_booking: a trigger covers the explicit branch, the
--      auto branch, reschedules and any future direct write, and cannot drift
--      out of step with the function.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. v_booking_detail gains service_ids
--
-- CREATE OR REPLACE VIEW may only append columns, which is what this does.
-- The WITH clause is restated because dropping it would silently turn this
-- into a definer view that bypasses the RLS policies on bookings - the exact
-- leak migration 12 existed to prevent.
-- ---------------------------------------------------------------------------
create or replace view public.v_booking_detail
with (security_invoker = true) as
select
  b.id,
  b.reference,
  b.status,
  b.start_time,
  b.end_time,
  b.employee_id,
  e.full_name  as employee_name,
  b.client_id,
  c.full_name  as client_name,
  b.guest_name,
  b.guest_phone,
  b.subtotal_cents,
  b.discount_cents,
  b.total_cents,
  b.promo_code_id,
  b.notes,
  b.created_at,
  b.updated_at,
  -- migration 19
  b.room_id,
  r.name        as room_name,
  r.room_type,
  c.discount_percent as member_discount_percent,
  -- migration 32: the service filter, and the ids the UI needs to link back
  -- to the catalogue without a second round trip.
  coalesce(
    (select array_agg(bi.service_id order by bi.service_id)
       from public.booking_items bi
      where bi.booking_id = b.id
        and bi.service_id is not null),
    '{}'::uuid[]
  ) as service_ids
from public.bookings b
left join public.employees e on e.id = b.employee_id
left join public.clients   c on c.id = b.client_id
left join public.rooms     r on r.id = b.room_id;

comment on view public.v_booking_detail is
  'Bookings joined to employee, client and room names, with service ids. security_invoker, so the RLS policies on bookings apply.';

revoke all on public.v_booking_detail from anon, authenticated;
grant select on public.v_booking_detail to service_role;


-- ---------------------------------------------------------------------------
-- 2. reschedule_booking
--
-- Only the guard and the status expression change. Everything else is the
-- migration-18 body, including the constraint discrimination that reports a
-- room clash as ROOM_TAKEN rather than SLOT_TAKEN.
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

  -- Once the client is in the chair, the appointment time is a record, not a
  -- plan. Moving it would also move the end time and therefore room occupancy
  -- for a service already under way. Say that plainly instead of letting the
  -- status trigger report a transition nobody asked for.
  if v_booking.status in ('CHECKED_IN', 'IN_SERVICE') then
    raise exception 'BOOKING_IN_PROGRESS' using errcode = 'P0012';
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
           -- A guest rescheduling their own PENDING booking is confirming it.
           -- Anything already CONFIRMED stays CONFIRMED; forcing the value
           -- was what broke the in-progress case.
           status     = case when v_booking.status = 'PENDING' then 'CONFIRMED' else v_booking.status end,
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
-- 3. An employee cannot be booked while on leave
--
-- The auto-assign branch inside create_booking already excluded time_off, so
-- the only hole was an explicitly named employee. A trigger closes it for
-- every write path instead of only the one that was audited.
--
-- CANCELLED and NO_SHOW are exempt: cancelling a booking that happens to
-- overlap leave must not be blocked by the leave.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_employee_time_off()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if new.status in ('CANCELLED', 'NO_SHOW') then
    return new;
  end if;

  if exists (
    select 1
      from public.time_off t
     where t.employee_id = new.employee_id
       and tstzrange(t.starts_at, t.ends_at) && tstzrange(new.start_time, new.end_time)
  ) then
    raise exception 'EMPLOYEE_UNAVAILABLE' using errcode = 'P0013';
  end if;

  return new;
end;
$$;

comment on function public.enforce_employee_time_off() is
  'Rejects a booking whose window overlaps the employee''s time_off. Covers the explicitly-assigned employee, which create_booking did not check.';

drop trigger if exists trg_bookings_employee_time_off on public.bookings;
create trigger trg_bookings_employee_time_off
  before insert or update of employee_id, start_time, end_time on public.bookings
  for each row execute function public.enforce_employee_time_off();


-- ---------------------------------------------------------------------------
-- Self-checks
-- ---------------------------------------------------------------------------
do $$
declare
  v_has_service_ids boolean;
  v_opts            text[];
  v_resched         text;
begin
  -- 1. the view exposes service_ids
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'v_booking_detail'
       and column_name = 'service_ids'
  ) into v_has_service_ids;

  if not v_has_service_ids then
    raise exception 'v_booking_detail is missing service_ids';
  end if;

  -- 2. it is still security_invoker and still unreadable by anon
  select c.reloptions into v_opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_booking_detail';

  if v_opts is null or not ('security_invoker=true' = any (v_opts)) then
    raise exception 'v_booking_detail lost security_invoker (reloptions: %)', v_opts;
  end if;

  if has_table_privilege('anon', 'public.v_booking_detail', 'SELECT') then
    raise exception 'v_booking_detail is readable by anon';
  end if;

  -- 3. reschedule carries the in-progress guard
  select prosrc into v_resched
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reschedule_booking';

  if v_resched is null or position('BOOKING_IN_PROGRESS' in v_resched) = 0 then
    raise exception 'reschedule_booking is missing the in-progress guard';
  end if;

  -- 4. the trigger is installed
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_bookings_employee_time_off' and not tgisinternal
  ) then
    raise exception 'trg_bookings_employee_time_off is missing';
  end if;
end;
$$;
