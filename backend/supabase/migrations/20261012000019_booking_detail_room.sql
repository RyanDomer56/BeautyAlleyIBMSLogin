-- ===========================================================================
-- 19_booking_detail_room.sql
--
-- v_booking_detail gained no room columns in migration 17 - the view predates
-- the concept. The desk needs to see which room a booking is in, and the
-- client dashboard shows it too, so the three columns are appended here.
--
-- CREATE OR REPLACE VIEW can only ADD columns at the END of the select list;
-- anything else requires a drop, which would take the grants and the
-- dependent objects with it. Appending is therefore both the cheapest and the
-- only safe option.
--
-- `security_invoker = true` is repeated deliberately: it is a property of the
-- view, and re-creating the view without it would silently turn these into
-- definer views that bypass the RLS policies on bookings - the exact leak
-- migration 12 set out to prevent.
-- ===========================================================================

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
  c.discount_percent as member_discount_percent
from public.bookings b
left join public.employees e on e.id = b.employee_id
left join public.clients   c on c.id = b.client_id
left join public.rooms     r on r.id = b.room_id;

comment on view public.v_booking_detail is
  'Bookings joined to employee, client and room names. security_invoker, so the RLS policies on bookings apply.';

-- `create or replace view` preserves the existing grants, but they are
-- re-stated so the intent is visible in the file rather than inherited from a
-- migration two years earlier.
revoke all on public.v_booking_detail from anon, authenticated;
grant select on public.v_booking_detail to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: the view must still be security_invoker, and must not have
-- become readable with the publishable key.
-- ---------------------------------------------------------------------------
do $$
declare
  v_opts text[];
begin
  select c.reloptions into v_opts
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'v_booking_detail';

  if v_opts is null or not ('security_invoker=true' = any(v_opts)) then
    raise exception 'v_booking_detail lost security_invoker (reloptions: %)', v_opts;
  end if;

  if has_table_privilege('anon', 'public.v_booking_detail', 'SELECT') then
    raise exception 'v_booking_detail is readable by anon';
  end if;
end $$;
