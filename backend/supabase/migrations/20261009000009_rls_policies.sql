-- ===========================================================================
-- 09_rls_policies.sql
--
-- Posture: DENY BY DEFAULT.
-- RLS is switched on for every table. A table with no policy grants nothing
-- to anon/authenticated - the absence of a policy IS the denial, not an
-- oversight. Adding a table without adding RLS is the single most common way
-- to leak data in Supabase, so the last statement in this file asserts that
-- every table in `public` has RLS enabled.
--
-- The backend connects with the service_role key, which has BYPASSRLS. These
-- policies therefore protect *direct client access* (a browser holding the
-- public anon key) - they are defence in depth, not the primary control.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable RLS everywhere.
-- ---------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.clients            enable row level security;
alter table public.employees          enable row level security;
alter table public.services           enable row level security;
alter table public.employee_services  enable row level security;
alter table public.working_hours      enable row level security;
alter table public.time_off           enable row level security;
alter table public.booking_counters   enable row level security;
alter table public.bookings           enable row level security;
alter table public.booking_items      enable row level security;
alter table public.promo_codes        enable row level security;
alter table public.promo_redemptions  enable row level security;
alter table public.qr_tokens          enable row level security;
alter table public.checkins           enable row level security;
alter table public.audit_logs         enable row level security;
alter table public.login_attempts     enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Table privileges.
-- RLS decides *which rows*; GRANTs decide *whether you may touch the table at
-- all*. Both are required. Supabase's default privileges cover tables created
-- by the dashboard, but being explicit here means this schema is portable.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- Public catalogue.
grant select on public.services          to anon, authenticated;
grant select on public.employees         to anon, authenticated;
grant select on public.employee_services to anon, authenticated;

-- Own-account reads.
grant select on public.profiles to authenticated;
grant select on public.clients  to authenticated;
grant select on public.bookings to authenticated;
grant select on public.booking_items to authenticated;

-- Column-scoped writes. See the note below on why this is not a blanket UPDATE.
grant update (full_name, phone) on public.profiles to authenticated;
grant update (full_name, phone, email) on public.clients to authenticated;

-- service_role is the backend's own identity.
grant all on all tables in schema public to service_role;

-- ---------------------------------------------------------------------------
-- 3. Policies.
-- ---------------------------------------------------------------------------

-- --- profiles --------------------------------------------------------------
-- A user may read and edit their own profile. They may NOT change their own
-- role: `update` is granted column-by-column above, and `role`/`is_active` are
-- not in that list. Without that restriction, `update profiles set
-- role = 'ADMIN' where id = auth.uid()` would be a one-line privilege
-- escalation available to every logged-in user.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- --- clients ---------------------------------------------------------------
drop policy if exists clients_select_own on public.clients;
create policy clients_select_own on public.clients
  for select to authenticated
  using (profile_id = (select auth.uid()));

drop policy if exists clients_update_own on public.clients;
create policy clients_update_own on public.clients
  for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- --- public catalogue ------------------------------------------------------
drop policy if exists services_public_read on public.services;
create policy services_public_read on public.services
  for select to anon, authenticated
  using (is_active);

drop policy if exists employees_public_read on public.employees;
create policy employees_public_read on public.employees
  for select to anon, authenticated
  using (is_active);

drop policy if exists employee_services_public_read on public.employee_services;
create policy employee_services_public_read on public.employee_services
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.employees e
      where e.id = employee_services.employee_id and e.is_active
    )
  );

-- --- bookings --------------------------------------------------------------
-- A client sees their own bookings. Guest bookings (client_id IS NULL) are
-- invisible to every client, by construction.
drop policy if exists bookings_select_own on public.bookings;
create policy bookings_select_own on public.bookings
  for select to authenticated
  using (
    client_id in (
      select c.id from public.clients c where c.profile_id = (select auth.uid())
    )
  );

drop policy if exists booking_items_select_own on public.booking_items;
create policy booking_items_select_own on public.booking_items
  for select to authenticated
  using (
    exists (
      select 1
        from public.bookings b
        join public.clients c on c.id = b.client_id
       where b.id = booking_items.booking_id
         and c.profile_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Tables with NO policy for anon/authenticated (intentional):
--    working_hours, time_off, booking_counters, promo_codes,
--    promo_redemptions, qr_tokens, checkins, audit_logs, login_attempts
--    Reachable only through the backend's service_role connection.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 5. Function execution.
--
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. Left alone, anyone
-- holding the public anon key could call public.get_dashboard_summary() and
-- read the salon's revenue, or call public.create_booking() directly.
--
-- The REVOKE deliberately does NOT live here. The functions do not exist yet
-- at this point in the migration order, and a REVOKE only applies to objects
-- that already exist - anything created afterwards picks the default
-- privileges back up. The revoke runs in 13_function_grants.sql, after
-- 10_functions.sql has created them.
--
-- What is set here is the *default* privilege for functions created later by
-- this role, so the intent is recorded next to the policies it belongs to.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- 6. Self-check: fail the migration if any public table is missing RLS.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and not c.relrowsecurity;

  if v_missing is not null then
    raise exception 'RLS is not enabled on: %', v_missing;
  end if;
end $$;
