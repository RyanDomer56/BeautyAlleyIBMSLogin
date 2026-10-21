-- ---------------------------------------------------------------------------
-- Migration 31: normalise the security_invoker spelling on the two views added
-- by migrations 29 and 30.
--
-- ## What went wrong
--
-- `alter view ... set (security_invoker = on)` and
-- `alter view ... set (security_invoker = true)` mean exactly the same thing to
-- Postgres - the option is boolean, and `on` is just the other spelling of
-- `true`. But `pg_class.reloptions` stores the *literal text* the caller wrote,
-- so the two forms are indistinguishable in behaviour yet differ as strings:
--
--     v_booking_detail      ["security_invoker=true"]
--     v_attendance_detail   ["security_invoker=on"]     <-- same effect
--
-- `scripts/verify.js` asserts the invariant by looking for the substring
-- `security_invoker=true` on every view in `public`. It is right to do that -
-- a view that silently loses this option becomes readable with the publishable
-- key - but the check is a string comparison, so the `= on` spelling reads as a
-- regression even though nothing is actually wrong.
--
-- ## The fix
--
-- Rewrite the option in the house spelling rather than loosening the check.
-- Making the verifier accept both spellings would work, but it would also mean
-- the next view added with `= on` passes while looking different from the other
-- seven - and the whole point of the check is that one grep tells you whether
-- every view is safe. Keep one spelling, keep the strict check.
--
-- No grants change here: both views are already service_role-only, and the
-- self-check below re-asserts that so a future edit cannot quietly widen them.
-- ---------------------------------------------------------------------------

alter view public.v_attendance_detail set (security_invoker = true);
alter view public.v_task_detail set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- Self-check.
--
-- Asserts the exact literal the verifier looks for, plus the anon privilege
-- that actually matters. If either view is ever recreated without the option,
-- this migration's intent is re-testable by re-running the check.
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
  v_opts text[];
  v_missing text[] := '{}';
begin
  foreach v_name in array array['v_attendance_detail', 'v_task_detail'] loop
    select c.reloptions into v_opts
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_name;

    if v_opts is null or not ('security_invoker=true' = any(v_opts)) then
      v_missing := v_missing || format('%s (reloptions: %s)', v_name, coalesce(v_opts::text, 'null'));
    end if;

    if has_table_privilege('anon', format('public.%I', v_name), 'SELECT') then
      raise exception 'migration 31: % is readable by anon', v_name;
    end if;
    if has_table_privilege('authenticated', format('public.%I', v_name), 'SELECT') then
      raise exception 'migration 31: % is readable by authenticated', v_name;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'migration 31: security_invoker=true not set on: %', array_to_string(v_missing, ', ');
  end if;
end $$;
