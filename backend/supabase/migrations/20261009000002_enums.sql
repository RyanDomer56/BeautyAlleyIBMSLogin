-- ===========================================================================
-- 02_enums.sql
--
-- Every block is idempotent: re-running a migration file must be a no-op.
-- ===========================================================================

do $$ begin
  create type public.user_role as enum ('GUEST', 'CLIENT', 'STAFF', 'ADMIN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.service_category as enum ('SPA', 'SALON', 'WELLNESS');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.booking_status as enum (
    'PENDING', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE', 'COMPLETED',
    'CANCELLED', 'NO_SHOW'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.promo_type as enum ('PERCENT', 'FIXED');
exception when duplicate_object then null; end $$;
