CREATE OR REPLACE FUNCTION public.role_from_app_metadata(p_meta jsonb)
 RETURNS user_role
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when p_meta ->> 'role' in ('ADMIN', 'STAFF', 'CLIENT', 'GUEST')
      then (p_meta ->> 'role')::public.user_role
    else 'CLIENT'::public.user_role
  end
$function$
