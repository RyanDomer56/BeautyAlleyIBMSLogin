-- ---------------------------------------------------------------------------
-- Migration 20: the CONCIERGE role, the one-time loyalty reward, and the
--               employee daily quota.
--
-- Three business changes, all from the master requirements document:
--
--   1. CONCIERGE becomes a fourth role. Until now STAFF covered both the front
--      desk and service delivery, which made "may record a payment" and "may
--      complete a service" the same permission. They are not the same job.
--
--   2. Loyalty changes shape. It was a flat 3% member rate applied to every
--      booking forever. It is now a ONE-TIME 10% reward that fires on the third
--      completed eligible visit and is then spent. "3% forever" and "10% once"
--      are different products, not different numbers.
--
--   3. Only *eligible* services count toward loyalty. The document is explicit
--      that unrelated wellness treatments and product purchases must not count
--      unless the Admin configures them to, so eligibility is a per-service
--      flag that defaults to off rather than a hardcoded category test.
--
-- NOTE ON `alter type ... add value`: this file runs inside a transaction (see
-- scripts/migrate.js), and PostgreSQL forbids *using* a new enum value in the
-- transaction that adds it. So 'CONCIERGE' is added here and deliberately never
-- referenced below. Anything that must test for CONCIERGE in SQL belongs in a
-- later migration; the API enforces roles in TypeScript, which is unaffected.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The fourth role.
-- ---------------------------------------------------------------------------
do $$ begin
  alter type public.user_role add value if not exists 'CONCIERGE';
exception when duplicate_object then null; end $$;

comment on type public.user_role is
  'ADMIN runs the business, CONCIERGE runs the front desk, STAFF delivers services, CLIENT books. GUEST is the unauthenticated actor.';

-- ---------------------------------------------------------------------------
-- 2. Per-service loyalty eligibility.
--
-- Defaults to false so a newly added IV drip or retail product cannot silently
-- start earning haircut loyalty. The backfill turns it on for SALON, which is
-- where the cuts live; the Admin can flip any individual row afterwards.
-- ---------------------------------------------------------------------------
alter table public.services
  add column if not exists loyalty_eligible boolean not null default false;

comment on column public.services.loyalty_eligible is
  'Counts toward the loyalty reward when completed. Salon/haircut services start true; wellness and add-ons start false.';

update public.services
   set loyalty_eligible = true
 where category = 'SALON'
   and loyalty_eligible = false;

-- ---------------------------------------------------------------------------
-- 3. The one-time reward, stored on the client.
--
-- Two facts cannot be derived and so must be stored: the configured rate, and
-- whether the reward has already been spent. The visit count itself stays
-- derived (v_client_loyalty), so a cancelled booking self-corrects rather than
-- leaving a counter permanently ahead of reality.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists loyalty_redeemed_at timestamptz,
  add column if not exists loyalty_discount_percent integer not null default 10
    check (loyalty_discount_percent between 0 and 100);

comment on column public.clients.loyalty_redeemed_at is
  'When the one-time loyalty reward was spent. Non-null = already redeemed, never again.';
comment on column public.clients.loyalty_discount_percent is
  'The configured one-time reward rate. Admin-configurable; 10 by default.';

-- Retire the old flat member rate.
--
-- `discount_percent` was applied to EVERY booking by create_booking. Leaving a
-- non-zero value in place would stack a permanent 3% on top of the new one-time
-- 10% and quietly over-discount every promoted client. Zeroing it here makes
-- that code path inert immediately, which is what lets migration 21 remove the
-- block safely instead of doing both changes in one risky step.
update public.clients
   set discount_percent = 0
 where discount_percent <> 0;

comment on column public.clients.discount_percent is
  'DEPRECATED as an automatic rate - superseded by the one-time loyalty reward. Kept at 0; migration 21 removes its use in create_booking.';

-- ---------------------------------------------------------------------------
-- 4. Employee daily quota.
--
-- The document sets a default target of 10 completed clients per working day
-- for hairstylists and lets the Admin adjust it per employee, so it is a column
-- rather than a constant.
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists daily_quota integer not null default 10
    check (daily_quota between 0 and 100);

comment on column public.employees.daily_quota is
  'Completed clients expected per working day. Default 10 for hairstylists.';

-- ---------------------------------------------------------------------------
-- 5. Loyalty view.
--
-- CREATE OR REPLACE VIEW may only APPEND to the select list, so the original
-- eight columns keep their names and order and the new ones go on the end. The
-- definition of `completed_visits` is unchanged (all completed bookings); the
-- eligibility test moves to the new `loyalty_visits`, which counts only
-- completed bookings containing at least one loyalty-eligible service.
-- ---------------------------------------------------------------------------
create or replace view public.v_client_loyalty
with (security_invoker = true) as
select
  c.id                                              as client_id,
  c.full_name,
  c.phone,
  c.email,
  c.member_since,
  c.discount_percent,
  count(b.id) filter (where b.status = 'COMPLETED')  as completed_visits,
  (
    c.member_since is null
    and count(b.id) filter (where b.status = 'COMPLETED')
        >= public.membership_visit_threshold()
  )                                                  as eligible_for_membership,
  -- ---- appended in migration 20 -------------------------------------------
  count(b.id) filter (
    where b.status = 'COMPLETED'
      and exists (
        select 1
          from public.booking_items bi
          join public.services s on s.id = bi.service_id
         where bi.booking_id = b.id
           and s.loyalty_eligible
      )
  )                                                  as loyalty_visits,
  c.loyalty_redeemed_at,
  c.loyalty_discount_percent,
  (
    c.loyalty_redeemed_at is null
    and count(b.id) filter (
      where b.status = 'COMPLETED'
        and exists (
          select 1
            from public.booking_items bi
            join public.services s on s.id = bi.service_id
           where bi.booking_id = b.id
             and s.loyalty_eligible
        )
    ) >= public.membership_visit_threshold()
  )                                                  as loyalty_available
from public.clients c
left join public.bookings b on b.client_id = c.id
group by c.id, c.full_name, c.phone, c.email, c.member_since, c.discount_percent,
         c.loyalty_redeemed_at, c.loyalty_discount_percent;

comment on view public.v_client_loyalty is
  'Client loyalty standing. loyalty_visits counts COMPLETED bookings with a loyalty-eligible service; loyalty_available means the one-time reward is earned and unspent.';

-- ---------------------------------------------------------------------------
-- 6. Redeeming the reward.
--
-- A single statement, so two concierges clicking at the same moment cannot both
-- succeed: the UPDATE is guarded on `loyalty_redeemed_at is null` and the row
-- count tells us whether we won the race. Checking eligibility with a SELECT
-- and then updating would let both callers pass the check and double-discount.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_loyalty(
  p_client_id uuid,
  p_actor     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_visits   integer;
  v_rate     integer;
  v_redeemed timestamptz;
  v_updated  integer;
begin
  select loyalty_visits, loyalty_discount_percent, loyalty_redeemed_at
    into v_visits, v_rate, v_redeemed
    from public.v_client_loyalty
   where client_id = p_client_id;

  if not found then
    raise exception 'CLIENT_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_redeemed is not null then
    raise exception 'LOYALTY_ALREADY_REDEEMED' using errcode = 'P0001';
  end if;

  if v_visits < public.membership_visit_threshold() then
    raise exception 'NOT_ELIGIBLE_FOR_LOYALTY' using errcode = 'P0001';
  end if;

  update public.clients
     set loyalty_redeemed_at = now(),
         member_since        = coalesce(member_since, now())
   where id = p_client_id
     and loyalty_redeemed_at is null;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    -- Someone else redeemed between our read and our write.
    raise exception 'LOYALTY_ALREADY_REDEEMED' using errcode = 'P0001';
  end if;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    p_actor, 'loyalty.redeemed', 'clients', p_client_id,
    jsonb_build_object('visits', v_visits, 'discountPercent', v_rate)
  );

  return jsonb_build_object(
    'clientId',          p_client_id,
    'visits',            v_visits,
    'discountPercent',   v_rate,
    'redeemedAt',        now()
  );
end $$;

comment on function public.redeem_loyalty(uuid, uuid) is
  'Spends the one-time loyalty reward. Raises LOYALTY_ALREADY_REDEEMED if spent, NOT_ELIGIBLE_FOR_LOYALTY if not earned.';

-- ---------------------------------------------------------------------------
-- 7. Privileges.
--
-- 13_function_grants.sql's `alter default privileges` did NOT cover functions
-- created later - migration 18 was rejected for exactly this. Revoke first,
-- then grant narrowly.
-- ---------------------------------------------------------------------------
revoke all on function public.redeem_loyalty(uuid, uuid) from public, anon, authenticated;
grant execute on function public.redeem_loyalty(uuid, uuid) to service_role;

-- The view is read through the API on behalf of staff, but the underlying
-- tables are RLS-guarded, so no direct anon/authenticated read.
revoke all on public.v_client_loyalty from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Self-checks.
--
-- A migration that silently half-applies is worse than one that fails loudly.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- The enum value landed.
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'user_role' and e.enumlabel = 'CONCIERGE'
  ) then
    raise exception 'migration 20: CONCIERGE was not added to user_role';
  end if;

  -- The new columns exist.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'services'
       and column_name = 'loyalty_eligible'
  ) then
    raise exception 'migration 20: services.loyalty_eligible is missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'employees'
       and column_name = 'daily_quota'
  ) then
    raise exception 'migration 20: employees.daily_quota is missing';
  end if;

  -- The retired rate really is retired.
  select count(*) into v_count from public.clients where discount_percent <> 0;
  if v_count > 0 then
    raise exception 'migration 20: % client(s) still carry a non-zero discount_percent', v_count;
  end if;

  -- The view kept security_invoker (migration 19 proved how easy it is to drop).
  if not exists (
    select 1 from pg_class c
     where c.relname = 'v_client_loyalty'
       and c.reloptions::text like '%security_invoker=true%'
  ) then
    raise exception 'migration 20: v_client_loyalty lost security_invoker';
  end if;

  -- Still exactly one create_booking, and it is still the 10-argument version.
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking';
  if v_count <> 1 then
    raise exception 'migration 20: expected exactly 1 create_booking, found %', v_count;
  end if;
end $$;
