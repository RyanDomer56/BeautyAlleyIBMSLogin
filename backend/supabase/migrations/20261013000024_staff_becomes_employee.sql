-- ---------------------------------------------------------------------------
-- Migration 24: STAFF becomes EMPLOYEE, completing the four-role model.
--
-- The requirements document names exactly four roles: Admin, Concierge,
-- Employee, Client. The schema had ADMIN / STAFF / CLIENT, where STAFF meant
-- "does everything that is not admin". Adding CONCIERGE in migration 20 split
-- the front desk out of it; what is left of STAFF is service delivery, which the
-- document calls Employee. Leaving it named STAFF would mean every reader has to
-- remember that "staff" does not include the concierge - who is, plainly, staff.
--
-- RENAME VALUE rather than add-a-value-and-migrate: it rewrites the label in
-- place, so every existing profiles row follows automatically and no data has to
-- be copied. The only cost is that anything comparing the role as TEXT breaks,
-- which is why role_from_app_metadata() is rebuilt below in the same migration.
--
-- handle_new_auth_user() is NOT touched: migration 15 already reduced it to a
-- call to role_from_app_metadata(), so fixing the one mapping fixes both paths.
-- ---------------------------------------------------------------------------

alter type public.user_role rename value 'STAFF' to 'EMPLOYEE';

-- ---------------------------------------------------------------------------
-- The single role mapping, rebuilt for the new label.
--
-- 'STAFF' is still accepted and mapped to EMPLOYEE. Auth users carry their role
-- in raw_app_meta_data, which is written by whoever created the account; any
-- account created before this migration still has 'STAFF' in there. Without this
-- alias the `in (...)` test would miss it, the CASE would fall through to the
-- ELSE branch, and an existing staff member would quietly become a CLIENT on
-- their next sign-in - a silent privilege downgrade, not an error.
-- ---------------------------------------------------------------------------
create or replace function public.role_from_app_metadata(p_meta jsonb)
returns public.user_role
language sql
immutable
as $function$
  select case
    when p_meta ->> 'role' = 'STAFF' then 'EMPLOYEE'::public.user_role
    when p_meta ->> 'role' in ('ADMIN', 'EMPLOYEE', 'CONCIERGE', 'CLIENT', 'GUEST')
      then (p_meta ->> 'role')::public.user_role
    else 'CLIENT'::public.user_role
  end
$function$;

comment on function public.role_from_app_metadata(jsonb) is
  'Maps raw_app_meta_data to a user_role. Accepts the legacy ''STAFF'' label as EMPLOYEE. Defaults to CLIENT for anything unrecognised.';

-- ---------------------------------------------------------------------------
-- Self-checks. Each one calls the real function rather than inspecting text,
-- so a typo in the CASE cannot pass.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_role  public.user_role;
begin
  -- The enum is exactly the four roles plus GUEST.
  select count(*) into v_count
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'user_role'
     and e.enumlabel in ('ADMIN', 'CONCIERGE', 'EMPLOYEE', 'CLIENT', 'GUEST');
  if v_count <> 5 then
    raise exception 'migration 24: expected 5 role labels, found %', v_count;
  end if;

  if exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role' and e.enumlabel = 'STAFF'
  ) then
    raise exception 'migration 24: STAFF still exists in user_role';
  end if;

  -- The mapping behaves, including the legacy label.
  v_role := public.role_from_app_metadata('{"role":"STAFF"}'::jsonb);
  if v_role <> 'EMPLOYEE' then
    raise exception 'migration 24: legacy STAFF did not map to EMPLOYEE (got %)', v_role;
  end if;

  v_role := public.role_from_app_metadata('{"role":"EMPLOYEE"}'::jsonb);
  if v_role <> 'EMPLOYEE' then
    raise exception 'migration 24: EMPLOYEE did not map to EMPLOYEE (got %)', v_role;
  end if;

  v_role := public.role_from_app_metadata('{"role":"CONCIERGE"}'::jsonb);
  if v_role <> 'CONCIERGE' then
    raise exception 'migration 24: CONCIERGE did not map to CONCIERGE (got %)', v_role;
  end if;

  -- Unknown input still falls back to CLIENT rather than erroring.
  v_role := public.role_from_app_metadata('{"role":"WIZARD"}'::jsonb);
  if v_role <> 'CLIENT' then
    raise exception 'migration 24: unknown role did not fall back to CLIENT (got %)', v_role;
  end if;

  -- No profile was left on a label that no longer exists.
  select count(*) into v_count
    from public.profiles
   where role::text not in ('ADMIN', 'CONCIERGE', 'EMPLOYEE', 'CLIENT', 'GUEST');
  if v_count > 0 then
    raise exception 'migration 24: % profile(s) hold an unknown role', v_count;
  end if;
end $$;
