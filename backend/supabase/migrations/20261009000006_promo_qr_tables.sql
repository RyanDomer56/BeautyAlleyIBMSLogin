-- ===========================================================================
-- 06_promo_qr_tables.sql
-- promo_codes, promo_redemptions, qr_tokens, checkins
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- promo_codes
-- `code` is citext so "save10" and "SAVE10" are the same code - users type
-- promo codes in whatever case they like.
-- ---------------------------------------------------------------------------
create table if not exists public.promo_codes (
  id                    uuid primary key default gen_random_uuid(),
  code                  extensions.citext not null unique,
  type                  public.promo_type not null,
  -- PERCENT: 1-100. FIXED: minor units.
  value                 integer not null check (value > 0),
  starts_at             timestamptz,
  ends_at               timestamptz,
  -- NULL = unlimited.
  max_redemptions       integer check (max_redemptions is null or max_redemptions > 0),
  per_client_limit      integer check (per_client_limit is null or per_client_limit > 0),
  min_spend_cents       integer not null default 0 check (min_spend_cents >= 0),
  -- NULL = applies to every service.
  applicable_service_ids uuid[],
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint promo_window_order
    check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint promo_percent_range
    check (type <> 'PERCENT' or value between 1 and 100)
);

create index if not exists promo_codes_active_idx
  on public.promo_codes (code) where is_active;

-- ---------------------------------------------------------------------------
-- promo_redemptions
-- A redemption is "live" while released_at IS NULL. Cancelling a booking
-- releases the redemption rather than deleting it, so the audit trail of
-- "this code was used and then given back" survives.
-- ---------------------------------------------------------------------------
create table if not exists public.promo_redemptions (
  id            uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes (id) on delete cascade,
  booking_id    uuid not null references public.bookings (id) on delete cascade,
  client_id     uuid references public.clients (id) on delete set null,
  guest_phone   extensions.citext,
  amount_cents  integer not null check (amount_cents >= 0),
  created_at    timestamptz not null default now(),
  released_at   timestamptz
);

-- One live redemption per booking, enforced by the database.
create unique index if not exists promo_redemptions_one_live_per_booking
  on public.promo_redemptions (booking_id) where released_at is null;

create index if not exists promo_redemptions_code_idx
  on public.promo_redemptions (promo_code_id) where released_at is null;

create index if not exists promo_redemptions_client_idx
  on public.promo_redemptions (client_id) where released_at is null;

-- ---------------------------------------------------------------------------
-- qr_tokens
-- One HMAC-signed pass per booking. The signed payload carries the `jti`;
-- this table is the authority on whether that jti is still good.
-- ---------------------------------------------------------------------------
create table if not exists public.qr_tokens (
  id         uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  jti        uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists qr_tokens_booking_idx
  on public.qr_tokens (booking_id);

-- ---------------------------------------------------------------------------
-- checkins
-- ---------------------------------------------------------------------------
create table if not exists public.checkins (
  id            uuid primary key default gen_random_uuid(),
  booking_id    uuid not null references public.bookings (id) on delete cascade,
  staff_id      uuid references public.employees (id) on delete set null,
  checked_in_at timestamptz not null default now()
);

-- A booking can only be checked in once.
create unique index if not exists checkins_one_per_booking
  on public.checkins (booking_id);
