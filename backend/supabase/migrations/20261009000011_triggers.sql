-- ===========================================================================
-- 11_triggers.sql
-- updated_at maintenance, status-transition enforcement, auth user hook.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- set_updated_at()
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_clients_updated_at on public.clients;
create trigger trg_clients_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

drop trigger if exists trg_employees_updated_at on public.employees;
create trigger trg_employees_updated_at
  before update on public.employees
  for each row execute function public.set_updated_at();

drop trigger if exists trg_services_updated_at on public.services;
create trigger trg_services_updated_at
  before update on public.services
  for each row execute function public.set_updated_at();

drop trigger if exists trg_bookings_updated_at on public.bookings;
create trigger trg_bookings_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

drop trigger if exists trg_promo_codes_updated_at on public.promo_codes;
create trigger trg_promo_codes_updated_at
  before update on public.promo_codes
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------------------------
-- enforce_booking_status_transition()
--
-- The legal lifecycle is:
--   PENDING    -> CONFIRMED | CHECKED_IN | CANCELLED | NO_SHOW
--   CONFIRMED  -> CHECKED_IN | CANCELLED | NO_SHOW
--   CHECKED_IN -> IN_SERVICE | COMPLETED | NO_SHOW
--   IN_SERVICE -> COMPLETED
--   COMPLETED / CANCELLED / NO_SHOW are terminal.
--
-- PENDING -> CHECKED_IN is permitted because a guest booking starts life as
-- PENDING (self-service, no staff involvement) and a guest who scans at the
-- desk is confirming by turning up. Forcing that through an explicit
-- CONFIRMED step would only add a state nobody ever observes.
--
-- Enforced in the database so that a bug in the service layer - or a future
-- admin tool - cannot silently move a COMPLETED booking back to PENDING.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_booking_status_transition()
returns trigger
language plpgsql
as $$
declare
  v_allowed text[];
begin
  if new.status = old.status then
    return new;
  end if;

  v_allowed := case old.status
    when 'PENDING'    then array['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW']
    when 'CONFIRMED'  then array['CHECKED_IN', 'CANCELLED', 'NO_SHOW']
    when 'CHECKED_IN' then array['IN_SERVICE', 'COMPLETED', 'NO_SHOW']
    when 'IN_SERVICE' then array['COMPLETED']
    else array[]::text[]   -- COMPLETED, CANCELLED, NO_SHOW: terminal
  end;

  if not (new.status::text = any (v_allowed)) then
    raise exception 'INVALID_STATUS_TRANSITION: % -> %', old.status, new.status
      using errcode = 'P0007';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bookings_status_transition on public.bookings;
create trigger trg_bookings_status_transition
  before update of status on public.bookings
  for each row execute function public.enforce_booking_status_transition();


-- ---------------------------------------------------------------------------
-- handle_new_auth_user()
--
-- Mirrors every new auth.users row into public.profiles.
--
-- SECURITY NOTE: the role is read from `raw_app_meta_data`, which only the
-- service role / admin API can write. It is deliberately NOT read from
-- `raw_user_meta_data`, because that field is the user-controlled sign-up
-- `data` payload - reading the role from there would let anyone register
-- themselves as ADMIN by passing {"role":"ADMIN"} to the sign-up endpoint.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role public.user_role;
begin
  if new.raw_app_meta_data ->> 'role' in ('ADMIN', 'STAFF', 'CLIENT', 'GUEST') then
    v_role := (new.raw_app_meta_data ->> 'role')::public.user_role;
  else
    v_role := 'CLIENT';
  end if;

  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    v_role,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
