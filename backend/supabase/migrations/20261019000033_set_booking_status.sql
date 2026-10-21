-- ===========================================================================
-- 33. set_booking_status()
--
-- `PATCH /bookings/:id/status` wrote the status column directly. Two problems:
--
--   1. CANCELLED could never succeed. The table requires
--      `(status = 'CANCELLED') = (cancelled_at is not null)`, and a bare
--      `status = 'CANCELLED'` update leaves cancelled_at null, so the CHECK
--      constraint rejected it every time. The endpoint looked like it supported
--      cancellation and did not.
--
--   2. COMPLETED and NO_SHOW were written with no audit row at all, while every
--      SQL-function transition was audited. The trail had holes exactly where
--      the desk changes the record by hand.
--
-- This function makes the non-cancellation transitions atomic and audited.
-- Cancellation is deliberately NOT handled here: it also has to revoke the
-- pass, release the promo and stamp cancelled_at, and cancel_booking() already
-- does all four. The service routes CANCELLED there, and this function refuses
-- it so the two paths cannot silently diverge.
-- ===========================================================================

create or replace function public.set_booking_status(
  p_booking_id uuid,
  p_status     text,
  p_actor      uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking public.bookings%rowtype;
  v_old     text;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;

  if not found then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0006';
  end if;

  -- One way to cancel, and it is not this one. See the header.
  if p_status = 'CANCELLED' then
    raise exception 'USE_CANCEL_BOOKING' using errcode = 'P0014';
  end if;

  v_old := v_booking.status;

  -- The status trigger owns legality; a bad transition raises here.
  update public.bookings
     set status     = p_status::public.booking_status,
         updated_at = now()
   where id = p_booking_id;

  -- One action name with from/to in the metadata, rather than an action per
  -- status: it keeps the trail queryable ("every manual status change") without
  -- colliding with booking.checked_in, which check_in_booking already writes.
  perform public.write_audit(
    p_actor,
    'booking.status_changed',
    'bookings',
    p_booking_id,
    jsonb_build_object('from', v_old, 'to', p_status)
  );

  return jsonb_build_object('bookingId', p_booking_id, 'from', v_old, 'to', p_status);
end;
$$;

comment on function public.set_booking_status(uuid, text, uuid) is
  'Audited non-cancellation status change. Refuses CANCELLED - use cancel_booking().';

-- Service-role only, like the other write functions: writes go through the API
-- so the rate limiter and request validation apply.
revoke all on function public.set_booking_status(uuid, text, uuid) from public;
revoke all on function public.set_booking_status(uuid, text, uuid) from anon, authenticated;
grant execute on function public.set_booking_status(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Self-checks
-- ---------------------------------------------------------------------------
do $$
declare
  v_src text;
begin
  select prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_booking_status';

  if v_src is null then
    raise exception 'set_booking_status was not created';
  end if;

  if position('write_audit' in v_src) = 0 then
    raise exception 'set_booking_status does not write an audit row';
  end if;

  if position('USE_CANCEL_BOOKING' in v_src) = 0 then
    raise exception 'set_booking_status does not refuse CANCELLED';
  end if;

  if has_function_privilege(
       'anon',
       'public.set_booking_status(uuid, text, uuid)',
       'EXECUTE'
     ) then
    raise exception 'set_booking_status is executable by anon';
  end if;
end;
$$;
