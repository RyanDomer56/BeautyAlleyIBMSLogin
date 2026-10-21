-- ---------------------------------------------------------------------------
-- Migration 23: stop presenting invented prices as if they were real.
--
-- Four services were seeded as demo data long before the business supplied a
-- catalogue: Signature Massage, Cut & Style, Radiance Facial and Manicure &
-- Pedicure. Their prices and durations were made up.
--
-- The requirements document is explicit: "Do not invent missing haircut prices
-- or durations. Allow the Admin to enter the correct business values." An
-- invented price is worse than no price, because it looks authoritative - it
-- gets quoted to a customer and then has to be walked back at the till.
--
-- So these rows are NOT deleted. The document expects the Admin to enter the
-- real figures, and a row has to exist for them to edit. Instead they are
-- deactivated (so nothing offers them) and their invented price is cleared to
-- zero, so no invented number survives anywhere in the database.
--
-- `needs_pricing` exists because 0 alone is ambiguous - it reads as "free"
-- rather than "not yet known". The flag is what the Admin UI lists.
--
-- The 10 catalogue services from migration 22 keep their real prices and stay
-- active. Their DURATIONS are still placeholders (60/30/15 min) awaiting
-- confirmation - that is a separate, already-flagged gap, and it does not block
-- them being bookable.
-- ---------------------------------------------------------------------------

alter table public.services
  add column if not exists needs_pricing boolean not null default false;

comment on column public.services.needs_pricing is
  'True = the business has not confirmed a price. The service must stay inactive and must never be bookable until an Admin sets a real price.';

-- Clear the invented values and take the services off the menu.
update public.services
   set price_cents  = 0,
       is_active    = false,
       needs_pricing = true,
       updated_at   = now()
 where name in (
   'Cut & Style',
   'Radiance Facial',
   'Signature Massage',
   'Manicure & Pedicure'
 );

-- ---------------------------------------------------------------------------
-- Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  -- No active service may sit at zero: a bookable service with no price is
  -- either a bug or an invented value that crept back in.
  select count(*) into v_count
    from public.services
   where is_active and price_cents <= 0;
  if v_count > 0 then
    raise exception 'migration 23: % active service(s) have no price', v_count;
  end if;

  -- The four demo services are flagged, inactive and stripped.
  select count(*) into v_count
    from public.services
   where name in ('Cut & Style', 'Radiance Facial', 'Signature Massage', 'Manicure & Pedicure')
     and needs_pricing
     and not is_active
     and price_cents = 0;
  if v_count <> 4 then
    raise exception 'migration 23: expected 4 flagged demo services, found %', v_count;
  end if;

  -- The real catalogue is untouched: exactly 10 priced, active services.
  select count(*) into v_count
    from public.services
   where not needs_pricing and is_active and price_cents > 0;
  if v_count <> 10 then
    raise exception 'migration 23: expected the 10 real catalogue services to stay active, found %', v_count;
  end if;

  -- And every one of them is genuinely from the document.
  select count(*) into v_count
    from public.services s
    join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons')
     and s.is_active
     and s.price_cents > 0;
  if v_count <> 10 then
    raise exception 'migration 23: % catalogue service(s) lost their price', v_count;
  end if;
end $$;
