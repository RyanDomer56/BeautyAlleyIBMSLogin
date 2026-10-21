-- ===========================================================================
-- 12_views.sql
--
-- SECURITY NOTE, and this one bites people:
-- In Postgres 15+ a view defaults to running with the *owner's* privileges and
-- therefore BYPASSES the row level security of the tables underneath it. A
-- view created in `public` is reachable by the public anon key. Left at the
-- default, `select * from v_booking_detail` would hand every booking in the
-- salon to anyone holding that key, RLS notwithstanding.
--
-- Two defences, both applied below:
--   1. `with (security_invoker = true)` - the view runs as the *caller*, so
--      the underlying RLS policies apply normally.
--   2. Explicit REVOKE from anon/authenticated. These are reporting views for
--      the backend; clients have no business reading them at all.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- v_booking_detail - bookings joined to employee and client names.
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
  b.updated_at
from public.bookings b
left join public.employees e on e.id = b.employee_id
left join public.clients   c on c.id = b.client_id;

-- ---------------------------------------------------------------------------
-- v_daily_revenue - one row per branch-local day.
-- ---------------------------------------------------------------------------
create or replace view public.v_daily_revenue
with (security_invoker = true) as
select
  (b.start_time at time zone public.branch_timezone())::date          as day,
  count(*)                                                            as bookings,
  count(*) filter (where b.status = 'COMPLETED')                      as completed,
  count(*) filter (where b.status = 'CANCELLED')                      as cancelled,
  count(*) filter (where b.status = 'NO_SHOW')                        as no_show,
  coalesce(sum(b.total_cents) filter (where b.status = 'COMPLETED'), 0) as revenue_cents,
  coalesce(sum(b.discount_cents) filter (where b.status = 'COMPLETED'), 0) as discount_cents
from public.bookings b
group by 1;

-- ---------------------------------------------------------------------------
-- v_client_history - lifetime value and visit counts.
-- ---------------------------------------------------------------------------
create or replace view public.v_client_history
with (security_invoker = true) as
select
  c.id,
  c.full_name,
  c.phone,
  c.email,
  c.is_active,
  count(b.id)                                                          as total_bookings,
  count(b.id) filter (where b.status = 'COMPLETED')                    as completed_bookings,
  count(b.id) filter (where b.status = 'NO_SHOW')                      as no_show_bookings,
  coalesce(sum(b.total_cents) filter (where b.status = 'COMPLETED'), 0) as lifetime_value_cents,
  min(b.start_time)                                                    as first_visit_at,
  max(b.start_time)                                                    as last_visit_at
from public.clients c
left join public.bookings b on b.client_id = c.id
group by c.id, c.full_name, c.phone, c.email, c.is_active;

-- ---------------------------------------------------------------------------
-- v_employee_utilisation - booked minutes per employee per day.
-- ---------------------------------------------------------------------------
create or replace view public.v_employee_utilisation
with (security_invoker = true) as
select
  e.id                                                                 as employee_id,
  e.full_name,
  (b.start_time at time zone public.branch_timezone())::date           as day,
  count(b.id)                                                          as bookings,
  coalesce(sum((extract(epoch from (b.end_time - b.start_time)) / 60)::integer), 0) as booked_minutes
from public.employees e
left join public.bookings b
       on b.employee_id = e.id
      and b.status not in ('CANCELLED', 'NO_SHOW')
group by e.id, e.full_name, 3;

-- ---------------------------------------------------------------------------
-- Lock the reporting views down to the backend.
-- ---------------------------------------------------------------------------
revoke all on public.v_booking_detail      from anon, authenticated;
revoke all on public.v_daily_revenue       from anon, authenticated;
revoke all on public.v_client_history      from anon, authenticated;
revoke all on public.v_employee_utilisation from anon, authenticated;

grant select on public.v_booking_detail       to service_role;
grant select on public.v_daily_revenue        to service_role;
grant select on public.v_client_history       to service_role;
grant select on public.v_employee_utilisation to service_role;
