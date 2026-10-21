-- ===========================================================================
-- 05_booking_tables.sql
-- booking_counters, bookings, booking_items
--
-- NOTE ON ORDERING: bookings.promo_code_id is declared here WITHOUT its foreign
-- key, because promo_codes is created in migration 06. The FK is attached in
-- 08_constraints_indexes.sql. That keeps the design's grouping (bookings
-- together, promo/QR together) without a circular file dependency.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- booking_counters - per-day counter backing the human-readable reference
-- BA-YYYYMMDD-NNNN. A row is locked FOR UPDATE while it is incremented, so
-- two concurrent bookings can never mint the same reference.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_counters (
  day        date primary key,
  last_value integer not null default 0 check (last_value >= 0)
);

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------
create table if not exists public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  reference           text not null unique,
  client_id           uuid references public.clients (id) on delete set null,
  guest_name          text,
  guest_phone         extensions.citext,
  employee_id         uuid not null references public.employees (id) on delete restrict,
  start_time          timestamptz not null,
  end_time            timestamptz not null,
  status              public.booking_status not null default 'PENDING',
  subtotal_cents      integer not null check (subtotal_cents >= 0),
  discount_cents      integer not null default 0 check (discount_cents >= 0),
  total_cents         integer not null check (total_cents >= 0),
  promo_code_id       uuid,  -- FK added in 08 (promo_codes lives in 06)
  notes               text,
  cancelled_at        timestamptz,
  cancellation_reason text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint bookings_time_order  check (end_time > start_time),
  -- Every booking belongs to either a registered client or a phone-identified
  -- guest. Without this, an anonymous booking could exist with no way to find
  -- its owner.
  constraint bookings_identity    check (client_id is not null or guest_phone is not null),
  -- The arithmetic on the row must hold, whatever the service layer does.
  constraint bookings_total_math  check (total_cents = subtotal_cents - discount_cents),
  -- A cancelled booking must record when.
  constraint bookings_cancel_stamp
    check ((status = 'CANCELLED') = (cancelled_at is not null))
);

create index if not exists bookings_employee_start_idx
  on public.bookings (employee_id, start_time desc);
create index if not exists bookings_client_start_idx
  on public.bookings (client_id, start_time desc);
create index if not exists bookings_guest_phone_idx
  on public.bookings (guest_phone) where guest_phone is not null;
create index if not exists bookings_start_idx
  on public.bookings (start_time desc);
create index if not exists bookings_status_idx
  on public.bookings (status) where status not in ('COMPLETED', 'CANCELLED', 'NO_SHOW');

comment on constraint bookings_cancel_stamp on public.bookings is
  'cancelled_at is set if and only if status = CANCELLED.';

-- ---------------------------------------------------------------------------
-- booking_items
-- The price/duration SNAPSHOT is the point of this table. A booking made in
-- March must still total the same in June, even if the service was repriced.
-- ---------------------------------------------------------------------------
create table if not exists public.booking_items (
  id                       uuid primary key default gen_random_uuid(),
  booking_id               uuid not null references public.bookings (id) on delete cascade,
  service_id               uuid references public.services (id) on delete set null,
  employee_id              uuid references public.employees (id) on delete set null,
  name_snapshot            text not null,
  price_cents_snapshot     integer not null check (price_cents_snapshot >= 0),
  duration_minutes_snapshot integer not null check (duration_minutes_snapshot > 0),
  created_at               timestamptz not null default now()
);

create index if not exists booking_items_booking_idx
  on public.booking_items (booking_id);
