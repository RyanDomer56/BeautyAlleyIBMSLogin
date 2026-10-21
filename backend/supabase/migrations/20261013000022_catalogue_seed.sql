-- ---------------------------------------------------------------------------
-- Migration 22: the real Beauty Alley catalogue, plus the rooms that serve it.
--
-- Source: the master requirements document. Prices are the business's own and
-- are NOT invented. Two things the document does not supply, handled explicitly
-- rather than silently guessed:
--
--   * DURATIONS. services.duration_minutes is NOT NULL, so something has to be
--     written. The values below are PLACEHOLDERS chosen from how long each
--     treatment realistically occupies a room, and every one is marked in the
--     description as awaiting confirmation. Correct them in the Admin UI.
--
--   * INGREDIENTS. The document lists ingredients for three of the four drips.
--     The Luminous Drip's are NOT given, so ingredients_verified is false and
--     the API returns them as "requires verification" instead of inventing them.
--     No medical claims are recorded anywhere - the descriptions state only how
--     a treatment is *marketed*, which is what the document itself says.
--
-- Idempotent: re-running inserts nothing. Matched on name, since these have no
-- natural key and the ids are generated.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Ingredient fields.
--
-- A dedicated column rather than stuffing them into `description`: the catalogue
-- has to render them as a list, and the "unverified" state has to be a fact the
-- API can act on rather than prose a human has to notice.
-- ---------------------------------------------------------------------------
alter table public.services
  add column if not exists ingredients text,
  add column if not exists ingredients_verified boolean not null default true;

comment on column public.services.ingredients is
  'Comma-separated ingredient list for the public catalogue. NULL = not applicable.';
comment on column public.services.ingredients_verified is
  'False = the business has not confirmed this list. The API must present it as requiring verification, not as fact.';

-- ---------------------------------------------------------------------------
-- 2. Second-level categories.
-- ---------------------------------------------------------------------------
insert into public.service_subcategories (category, name, slug, sort_order)
values
  ('WELLNESS', 'IV Drips',     'iv-drips',     10),
  ('WELLNESS', 'Beauty Shots', 'beauty-shots', 20),
  ('WELLNESS', 'Add-ons',      'add-ons',      30)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Services.
--
-- required_room_type: IV drips need a private treatment room, so the auto
-- assigner will hold one for the whole slot. Shots and add-ons are quick
-- in-chair procedures and need none (NULL = no room required).
--
-- loyalty_eligible stays FALSE for all of these: the document is explicit that
-- wellness treatments must not count toward haircut loyalty unless the Admin
-- turns it on for a specific service.
-- ---------------------------------------------------------------------------
insert into public.services (
  name, category, subcategory_id, description, ingredients, ingredients_verified,
  price_cents, duration_minutes, required_room_type, loyalty_eligible, is_active
)
select
  v.name, v.category::public.service_category, sc.id, v.description,
  v.ingredients, v.ingredients_verified,
  v.price_cents, v.duration_minutes, v.required_room_type::public.room_type,
  false, true
from (values
  -- ---- IV Drips (prices from the document) --------------------------------
  ('Korean Glass Skin Drip', 'WELLNESS', 'iv-drips',
   'Korean-style glutathione drip. Duration is a placeholder pending confirmation from the business.',
   'Glutathione, Lipotocin (Thioctic Acid), Korean Vitamin C', true,
   180000, 60, 'OTHER'),

  ('Korean Youthful Glowing Skin Drip', 'WELLNESS', 'iv-drips',
   'Also known as the Cinderella or Baby Face Drip. Duration is a placeholder pending confirmation from the business.',
   'Glutathione, Vitamin C, Alpha Lipoic Acid', true,
   160000, 60, 'OTHER'),

  ('Luminous Drip', 'WELLNESS', 'iv-drips',
   'Also known as Miracle White with Melanin Inhibitor. INGREDIENTS NOT SUPPLIED by the business - confirm before publishing. Duration is also a placeholder.',
   null, false,
   140000, 60, 'OTHER'),

  ('Immune Booster Drip', 'WELLNESS', 'iv-drips',
   'Vitamin and mineral drip. Duration is a placeholder pending confirmation from the business.',
   'Vitamin C, Zinc, Vitamin B12, Collagen', true,
   150000, 60, 'OTHER'),

  -- ---- Beauty Shots (prices from the document) ----------------------------
  ('Anti-Aging Shot (Placenta)', 'WELLNESS', 'beauty-shots',
   'A beauty treatment marketed for skin rejuvenation and anti-aging. Duration is a placeholder pending confirmation from the business.',
   'Placenta', true,
   120000, 30, null),

  ('Rejuvenating Shot (Collagen)', 'WELLNESS', 'beauty-shots',
   'A beauty treatment marketed to support skin elasticity and improve the appearance of fine lines and wrinkles. Duration is a placeholder pending confirmation from the business.',
   'Collagen', true,
   120000, 30, null),

  -- ---- Add-ons (prices from the document) ---------------------------------
  ('Placenta Add-on', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Placenta', true,
   50000, 15, null),

  ('Collagen Add-on', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Collagen', true,
   50000, 15, null),

  ('Vitamin C Add-on', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Vitamin C', true,
   30000, 15, null),

  ('Multivitamins Add-on (Vitamin B12)', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Vitamin B12', true,
   30000, 15, null)
) as v (name, category, slug, description, ingredients, ingredients_verified,
        price_cents, duration_minutes, required_room_type)
join public.service_subcategories sc on sc.slug = v.slug
where not exists (
  select 1 from public.services s where s.name = v.name
);

-- ---------------------------------------------------------------------------
-- 4. Rooms.
--
-- The document does not name its rooms, and the auto-assigner needs somewhere
-- to put a drip, so this is a MINIMAL starting set the Admin should rename to
-- match the real floor plan. `room_type` has no IV value, so the lounges use
-- OTHER rather than bending an unrelated type to fit.
-- ---------------------------------------------------------------------------
insert into public.rooms (name, room_type, capacity, notes)
select v.name, v.room_type::public.room_type, v.capacity, v.notes
from (values
  ('IV Lounge 1', 'OTHER',   1::smallint, 'Starting set - rename to match the real floor plan.'),
  ('IV Lounge 2', 'OTHER',   1::smallint, 'Starting set - rename to match the real floor plan.'),
  ('IV Lounge 3', 'OTHER',   1::smallint, 'Starting set - rename to match the real floor plan.'),
  ('VIP Treatment Room', 'VIP', 1::smallint, 'Starting set - rename to match the real floor plan.')
) as v (name, room_type, capacity, notes)
where not exists (
  select 1 from public.rooms r where lower(r.name) = lower(v.name)
);

-- ---------------------------------------------------------------------------
-- 5. Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_bad   integer;
begin
  select count(*) into v_count
    from public.services s
    join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons');
  if v_count <> 10 then
    raise exception 'migration 22: expected 10 catalogue services, found %', v_count;
  end if;

  -- The Luminous Drip must be flagged unverified, not quietly presented as fact.
  if not exists (
    select 1 from public.services
     where name = 'Luminous Drip' and ingredients_verified = false
  ) then
    raise exception 'migration 22: Luminous Drip should have ingredients_verified = false';
  end if;

  -- Nothing wellness may count toward haircut loyalty.
  select count(*) into v_bad
    from public.services s
    join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons')
     and s.loyalty_eligible;
  if v_bad > 0 then
    raise exception 'migration 22: % wellness service(s) wrongly loyalty_eligible', v_bad;
  end if;

  -- Every price must be a positive number of cents.
  select count(*) into v_bad from public.services where price_cents <= 0;
  if v_bad > 0 then
    raise exception 'migration 22: % service(s) have a non-positive price', v_bad;
  end if;

  if not exists (select 1 from public.rooms where is_active) then
    raise exception 'migration 22: no active rooms were seeded';
  end if;
end $$;
