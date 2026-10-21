-- ===========================================================================
-- 15_sync_profile_role.sql
--
-- Fixes a real bug found by the test suite: setting a role through the Auth
-- admin API did not reach public.profiles.
--
-- THE BUG
--
-- `handle_new_auth_user` (migration 11) is an AFTER INSERT trigger on
-- auth.users. It reads the role from `raw_app_meta_data` and writes it into
-- the new profile row. That works for a plain sign-up.
--
-- It does NOT work for `auth.admin.createUser({ app_metadata: { role } })`.
-- GoTrue inserts the row first and then applies `app_metadata` in a separate
-- UPDATE, so at INSERT time `raw_app_meta_data` is `{}`. The trigger takes its
-- else branch, and every admin-created STAFF or ADMIN account silently becomes
-- a CLIENT.
--
-- The failure is quiet and late: the account is created, the API returns 201,
-- and the user is refused with a 403 the first time they touch an admin
-- endpoint. Observed directly: `raw_app_meta_data` held {"role":"ADMIN"} while
-- `profiles.role` said CLIENT.
--
-- THE FIX
--
-- A second trigger on UPDATE OF raw_app_meta_data that keeps the profile in
-- step. Both directions of the mapping now live in one function, so the INSERT
-- and UPDATE paths cannot drift apart.
--
-- SECURITY NOTE
--
-- This does not open an escalation path. `raw_app_meta_data` is writable only
-- by the service role - a signed-up user cannot reach it, which is exactly why
-- migration 11 reads the role from `app_metadata` rather than the
-- user-controlled `user_meta_data`. The same reasoning applies here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- role_from_app_metadata() - the single mapping, used by both triggers.
-- ---------------------------------------------------------------------------
create or replace function public.role_from_app_metadata(p_meta jsonb)
returns public.user_role
language sql
immutable
as $$
  select case
    when p_meta ->> 'role' in ('ADMIN', 'STAFF', 'CLIENT', 'GUEST')
      then (p_meta ->> 'role')::public.user_role
    else 'CLIENT'::public.user_role
  end
$$;

comment on function public.role_from_app_metadata(jsonb) is
  'Maps raw_app_meta_data to a user_role. Defaults to CLIENT for anything unrecognised.';

-- ---------------------------------------------------------------------------
-- handle_new_auth_user() - rebuilt on top of the shared mapping.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    public.role_from_app_metadata(new.raw_app_meta_data),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- sync_profile_role() - the UPDATE half.
--
-- `is distinct from` means an update that leaves the role unchanged writes
-- nothing, so this cannot cause a write amplification loop when GoTrue updates
-- app_metadata for an unrelated reason (adding a provider, for instance).
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role public.user_role := public.role_from_app_metadata(new.raw_app_meta_data);
begin
  update public.profiles
     set role = v_role
   where id = new.id
     and role is distinct from v_role;

  return new;
end;
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of raw_app_meta_data on auth.users
  for each row execute function public.sync_profile_role();

-- ---------------------------------------------------------------------------
-- Backfill: any account whose app_metadata and profile already disagree.
-- ---------------------------------------------------------------------------
update public.profiles p
   set role = public.role_from_app_metadata(u.raw_app_meta_data)
  from auth.users u
 where u.id = p.id
   and p.role is distinct from public.role_from_app_metadata(u.raw_app_meta_data);

-- ---------------------------------------------------------------------------
-- Self-check: no account may disagree with its own app_metadata.
-- ---------------------------------------------------------------------------
do $$
declare
  v_drifted integer;
begin
  select count(*) into v_drifted
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.role is distinct from public.role_from_app_metadata(u.raw_app_meta_data);

  if v_drifted > 0 then
    raise exception 'profile role drift remains on % account(s)', v_drifted;
  end if;
end $$;
