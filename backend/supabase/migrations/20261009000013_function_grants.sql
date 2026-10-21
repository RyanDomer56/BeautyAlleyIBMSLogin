-- ===========================================================================
-- 13_function_grants.sql
--
-- Locking down function execution. This file MUST run after every migration
-- that creates a function, which is why it is last.
--
-- Why it cannot live in 09_rls_policies.sql: REVOKE only affects objects that
-- already exist. Migration 09 runs before 10_functions.sql, so a REVOKE there
-- would be undone the moment each function was created with the default
-- privileges (EXECUTE to PUBLIC, plus the explicit grants Supabase sets up for
-- the anon and authenticated roles).
--
-- The consequence of getting this wrong is not theoretical. With the default
-- grants in place, anyone holding the publishable anon key - which is shipped
-- to browsers by design - could POST to /rest/v1/rpc/get_dashboard_summary and
-- read the salon's revenue, or call create_booking and write rows directly,
-- bypassing the API entirely.
-- ===========================================================================

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from authenticated;

grant execute on all functions in schema public to service_role;

-- Keep it that way for functions added by future migrations.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;
alter default privileges in schema public grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- Self-check: no business function may be executable by anon or authenticated.
-- ---------------------------------------------------------------------------
do $$
declare
  v_exposed text;
begin
  select string_agg(distinct p.proname, ', ' order by p.proname)
    into v_exposed
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and (
       has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );

  if v_exposed is not null then
    raise exception 'functions still executable by anon/authenticated: %', v_exposed;
  end if;
end $$;
