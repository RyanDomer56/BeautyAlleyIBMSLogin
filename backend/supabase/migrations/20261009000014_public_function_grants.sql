-- ===========================================================================
-- 14_public_function_grants.sql
--
-- 13_function_grants.sql revokes EXECUTE on every function in `public` from
-- anon and authenticated. That is the right default - it stops anyone holding
-- the publishable key from calling get_dashboard_summary() and reading the
-- salon's revenue, or calling create_booking() and writing rows directly.
--
-- But two of those functions are genuinely public-facing, and the booking flow
-- cannot work without them:
--
--   get_available_slots  the "pick a time" grid, shown to signed-out visitors
--   validate_promo       the cart's "apply code" preview, before sign-in
--
-- Both are re-granted here. The justification for each:
--
--   * Neither returns personal data. get_available_slots returns employee ids
--     and free time ranges; validate_promo returns a discount amount for a
--     code the caller already supplied.
--   * Both are read-only. Both are declared `stable` and neither writes a row,
--     so granting EXECUTE cannot be used to mutate anything.
--   * Both are already `security definer` with a pinned search_path, so a
--     caller cannot redirect what they read.
--
-- Everything else stays service_role-only. In particular create_booking,
-- cancel_booking, reschedule_booking and check_in_booking are NOT granted:
-- those are writes, and they are meant to go through the API so that the
-- per-IP rate limiter and the request validation apply.
-- ===========================================================================

grant execute on function public.get_available_slots(
  uuid, date, uuid, integer, text
) to anon, authenticated;

grant execute on function public.validate_promo(
  extensions.citext, uuid, extensions.citext, uuid[], integer
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Self-check: the public functions are reachable, and the write functions
-- are not. A regression here is a security regression, so it fails loudly.
-- ---------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_leaked  text;
begin
  -- Reachable?
  select string_agg(f.name, ', ')
    into v_missing
    from (values ('get_available_slots'), ('validate_promo')) as f(name)
   where not has_function_privilege(
           'anon',
           (select p.oid from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = f.name
             limit 1),
           'EXECUTE'
         );

  if v_missing is not null then
    raise exception 'public functions not executable by anon: %', v_missing;
  end if;

  -- Still locked down?
  select string_agg(f.name, ', ')
    into v_leaked
    from (values
            ('create_booking'), ('cancel_booking'), ('reschedule_booking'),
            ('check_in_booking'), ('get_dashboard_summary'), ('next_booking_reference')
         ) as f(name)
   where has_function_privilege(
           'anon',
           (select p.oid from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = f.name
             limit 1),
           'EXECUTE'
         );

  if v_leaked is not null then
    raise exception 'write functions must not be executable by anon: %', v_leaked;
  end if;
end $$;
