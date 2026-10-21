-- ===========================================================================
-- 17_rooms_loyalty_notes.sql
--
-- Four additions, all driven by the walk-in flow:
--   1. rooms          - a booking now occupies a physical room
--   2. subcategories  - the second level of the service catalogue
--   3. membership     - the 3-visit promotion and the member rate
--   4. booking_notes  - the therapist's aftercare note, readable by the client
--
-- Idempotent: re-running this file must be a no-op.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. room_type - what a room is equipped for.
-- A service declares the type it needs; the auto-assigner will only ever
-- offer a room of that type, so a massage never lands in a nail station.
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.room_type as enum (
    'MASSAGE', 'FACIAL', 'NAIL', 'WAXING', 'SAUNA', 'VIP', 'OTHER'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. rooms
-- ---------------------------------------------------------------------------
create table if not exists public.rooms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  room_type  public.room_type not null,
  capacity   smallint not null default 1 check (capacity > 0),
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.rooms is
  'A physical treatment room. One booking occupies one room for its whole slot.';

-- Two rooms may not share a name, whatever the casing.
create unique index if not exists rooms_name_key
  on public.rooms (lower(name));

create index if not exists rooms_active_type_idx
  on public.rooms (room_type) where is_active;

-- ---------------------------------------------------------------------------
-- 3. Which room a service needs. NULL = no room (a chair at a station is
--    enough), which is the correct default for a trim or a quick polish.
-- ---------------------------------------------------------------------------
alter table public.services
  add column if not exists required_room_type public.room_type;

comment on column public.services.required_room_type is
  'NULL when the service needs no room. Drives the room auto-assigner.';

-- ---------------------------------------------------------------------------
-- 4. service_subcategories - the second level of the catalogue.
--
-- A table rather than an enum, on purpose: adding "Brazilian spa" or a new
-- massage classification must not require a database migration. The top level
-- stays the existing service_category enum.
-- ---------------------------------------------------------------------------
create table if not exists public.service_subcategories (
  id         uuid primary key default gen_random_uuid(),
  category   public.service_category not null,
  name       text not null,
  slug       text not null unique,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.service_subcategories is
  'Second catalogue level. category is the top level (SPA/SALON/WELLNESS).';

create index if not exists service_subcategories_category_idx
  on public.service_subcategories (category, sort_order) where is_active;

alter table public.services
  add column if not exists subcategory_id uuid
    references public.service_subcategories (id) on delete set null;

create index if not exists services_subcategory_idx
  on public.services (subcategory_id) where is_active;

-- ---------------------------------------------------------------------------
-- 5. Client membership.
--
-- The visit COUNT is deliberately NOT stored. It is derived from COMPLETED
-- bookings in v_client_loyalty below, so cancelling or deleting a booking
-- corrects the count instead of leaving a denormalised counter permanently
-- ahead of reality. Only the two facts that cannot be derived are stored:
-- whether the client was promoted, and at what rate.
--
-- Promotion is a staff decision, so member_since is set by the API and never
-- by a trigger.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists member_since timestamptz,
  add column if not exists discount_percent integer not null default 0
    check (discount_percent between 0 and 100);

comment on column public.clients.member_since is
  'Set when staff promote the client. NULL = not a member yet.';
comment on column public.clients.discount_percent is
  'Member rate applied to every booking, on top of any promo code. 0 until promoted.';

-- ---------------------------------------------------------------------------
-- 6. booking_notes - the therapist's aftercare note on a booking.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_notes (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references public.bookings (id) on delete cascade,
  author_id         uuid references public.employees (id) on delete set null,
  body              text not null,
  visible_to_client boolean not null default true,
  created_at        timestamptz not null default now()
);

comment on table public.booking_notes is
  'Aftercare notes written by the therapist. visible_to_client gates the client dashboard.';

create index if not exists booking_notes_booking_idx
  on public.booking_notes (booking_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 7. Room occupancy.
-- ---------------------------------------------------------------------------
alter table public.bookings
  add column if not exists room_id uuid
    references public.rooms (id) on delete set null;

create index if not exists bookings_room_start_idx
  on public.bookings (room_id, start_time desc) where room_id is not null;

-- The room equivalent of bookings_no_overlap from 08. A NULL room_id never
-- conflicts, so services that need no room are unaffected. Same half-open
-- [start, end) interval, so a 09:00-10:00 and a 10:00-11:00 booking in one
-- room are adjacent, not overlapping.
alter table public.bookings
  drop constraint if exists bookings_room_no_overlap;

alter table public.bookings
  add constraint bookings_room_no_overlap
  exclude using gist (
    room_id with =,
    tstzrange(start_time, end_time) with &&
  )
  where (room_id is not null and status not in ('CANCELLED', 'NO_SHOW'));

comment on constraint bookings_room_no_overlap on public.bookings is
  'A room cannot host two live bookings at once. Raises 23P01, mapped to 409 ROOM_TAKEN.';

-- ---------------------------------------------------------------------------
-- 8. Membership threshold and the loyalty view.
-- ---------------------------------------------------------------------------
create or replace function public.membership_visit_threshold()
returns integer
language sql
immutable
as $$ select 3 $$;

comment on function public.membership_visit_threshold() is
  'Completed visits a client needs before staff may promote them to member.';

-- Derived, never stored. `eligible_for_membership` is the flag the front desk
-- acts on: they have earned it and have not been promoted yet.
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
  )                                                  as eligible_for_membership
from public.clients c
left join public.bookings b on b.client_id = c.id
group by c.id, c.full_name, c.phone, c.email, c.member_since, c.discount_percent;

-- ---------------------------------------------------------------------------
-- 9. RLS and privileges for the new tables.
--
-- 09_rls_policies.sql sets the standard: a table without RLS is a leak, not
-- an oversight. The self-check in section 10 enforces it for these too.
-- ---------------------------------------------------------------------------
alter table public.rooms                 enable row level security;
alter table public.service_subcategories enable row level security;
alter table public.booking_notes         enable row level security;

grant select on public.rooms                 to anon, authenticated;
grant select on public.service_subcategories to anon, authenticated;
grant select on public.booking_notes         to authenticated;

grant all on public.rooms                 to service_role;
grant all on public.service_subcategories to service_role;
grant all on public.booking_notes         to service_role;

-- Rooms and the catalogue are public information - the booking page needs them.
drop policy if exists rooms_public_read on public.rooms;
create policy rooms_public_read on public.rooms
  for select to anon, authenticated
  using (is_active);

drop policy if exists service_subcategories_public_read on public.service_subcategories;
create policy service_subcategories_public_read on public.service_subcategories
  for select to anon, authenticated
  using (is_active);

-- A client may read aftercare notes on their OWN bookings, and only the ones
-- the therapist marked shareable. Guest bookings (client_id IS NULL) are
-- invisible by construction, exactly as with bookings_select_own.
drop policy if exists booking_notes_select_own on public.booking_notes;
create policy booking_notes_select_own on public.booking_notes
  for select to authenticated
  using (
    visible_to_client
    and exists (
      select 1
        from public.bookings b
        join public.clients c on c.id = b.client_id
       where b.id = booking_notes.booking_id
         and c.profile_id = (select auth.uid())
    )
  );

-- The loyalty view is a reporting view: backend only, same as the views in 12.
revoke all on public.v_client_loyalty from anon, authenticated;
grant select on public.v_client_loyalty to service_role;
grant execute on function public.membership_visit_threshold() to service_role;

-- ---------------------------------------------------------------------------
-- 10. Self-check: no public table may be left without RLS.
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
