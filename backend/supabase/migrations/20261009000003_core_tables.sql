-- ===========================================================================
-- 03_core_tables.sql
-- profiles, clients, employees, services
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- profiles
-- One row per authenticated user. `id` is the auth.users id, so a profile
-- cannot exist without an account. The role lives here and nowhere else.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.user_role not null default 'CLIENT',
  full_name   text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Application identity. Role is authoritative here; JWTs only carry a copy.';

-- ---------------------------------------------------------------------------
-- clients
-- A bookable customer. May be linked to a profile (registered) or exist as a
-- walk-in record created by staff. Guest bookings key off phone instead.
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid unique references public.profiles (id) on delete set null,
  full_name   text not null,
  phone       extensions.citext,
  email       extensions.citext,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.clients.profile_id is
  'Null for staff-created walk-ins. Unique, so one profile owns one client row.';

-- ---------------------------------------------------------------------------
-- employees
-- A person who delivers services and owns a calendar.
-- ---------------------------------------------------------------------------
create table if not exists public.employees (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid unique references public.profiles (id) on delete set null,
  full_name   text not null,
  title       text,
  bio         text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- services
-- Money is stored as integer minor units (centavos). Never a float.
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  category         public.service_category not null,
  description      text,
  price_cents      integer not null check (price_cents >= 0),
  duration_minutes integer not null check (duration_minutes > 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists services_active_category_idx
  on public.services (category) where is_active;
