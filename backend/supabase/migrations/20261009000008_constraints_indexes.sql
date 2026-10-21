-- ===========================================================================
-- 08_constraints_indexes.sql
-- The structural guarantees: no double-booking, and the deferred promo FK.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Deferred FK from 05: bookings.promo_code_id -> promo_codes.id
-- ---------------------------------------------------------------------------
alter table public.bookings
  drop constraint if exists bookings_promo_code_fk;

alter table public.bookings
  add constraint bookings_promo_code_fk
  foreign key (promo_code_id)
  references public.promo_codes (id)
  on delete set null;

-- ---------------------------------------------------------------------------
-- THE double-booking guard.
--
-- Two live bookings for the same employee may never overlap in time. This is
-- enforced by the storage engine via a GiST exclusion constraint, not by
-- application code, so it holds even if a future developer forgets to check
-- availability in a new code path.
--
-- `tstzrange(start_time, end_time)` defaults to the half-open interval [start,
-- end), which is what we want: a 09:00-10:00 booking and a 10:00-11:00 booking
-- are adjacent, not overlapping.
--
-- The WHERE clause excludes CANCELLED and NO_SHOW bookings, so a cancelled
-- slot becomes bookable again immediately.
--
-- A violation raises SQLSTATE 23P01, which the API maps to HTTP 409
-- SLOT_TAKEN.
-- ---------------------------------------------------------------------------
alter table public.bookings
  drop constraint if exists bookings_no_overlap;

alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    employee_id with =,
    tstzrange(start_time, end_time) with &&
  )
  where (status not in ('CANCELLED', 'NO_SHOW'));

comment on constraint bookings_no_overlap on public.bookings is
  'Prevents two live bookings from overlapping for the same employee. Raises 23P01.';

-- ---------------------------------------------------------------------------
-- Supporting indexes for the reporting views and the availability scan.
-- ---------------------------------------------------------------------------

-- Availability queries filter "this employee, this window, live statuses".
create index if not exists bookings_live_window_idx
  on public.bookings using gist (employee_id, tstzrange(start_time, end_time))
  where status not in ('CANCELLED', 'NO_SHOW');

-- Dashboard: revenue in a date range over completed work.
create index if not exists bookings_completed_idx
  on public.bookings (start_time desc)
  where status = 'COMPLETED';

-- Client detail: visit history.
create index if not exists booking_items_service_idx
  on public.booking_items (service_id);
