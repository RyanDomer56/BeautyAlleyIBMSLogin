-- ---------------------------------------------------------------------------
-- Migration 28: put the wellness catalogue back.
--
-- ## What happened
--
-- Migration 22 inserted ten wellness services (four IV drips, two beauty shots,
-- four add-ons). They are no longer in the database, and migration 22 is still
-- recorded as APPLIED - so re-running the migrator would not bring them back.
--
-- The cause was not a migration. `scripts/seed.js` TRUNCATEs `public.services`
-- and rebuilds it from a hard-coded list that only ever contained the four
-- original salon services. The Jest global setup runs that script, so every
-- `npm test` silently deleted the entire wellness menu. The tests went green
-- while the catalogue shrank, which is the worst way for data to go missing.
--
-- `seed.js` now rebuilds all fourteen services, so the two paths agree. This
-- migration exists for the databases the seed script never touches, and to
-- repair the ones it already emptied.
--
-- ## Why it is safe to re-run, and safe on a fresh database
--
-- Every insert is guarded by `where not exists (… where s.name = v.name)`, so
-- running it against a database that already has these rows changes nothing.
-- On a fresh project, migration 22 inserts them first (with generated ids) and
-- this one skips; on the affected database, migration 22's rows are gone and
-- this one restores them (with the fixed ids `seed.js` also uses).
--
-- Nothing depends on the ids being one value or the other, which is exactly
-- why the guard is written against the NAME.
--
-- ## Prices and durations
--
-- Prices are the business's own and are not invented here. Durations are
-- placeholders - the brief supplied prices but not durations, and the column is
-- NOT NULL - so each description says so. The Luminous Drip's ingredient list
-- was not supplied, so `ingredients_verified` is false and the API presents it
-- as requiring verification rather than asserting a list nobody confirmed.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Second-level categories, in case this database predates migration 22.
-- ---------------------------------------------------------------------------
insert into public.service_subcategories (category, name, slug, sort_order)
values
  ('WELLNESS', 'IV Drips',     'iv-drips',     10),
  ('WELLNESS', 'Beauty Shots', 'beauty-shots', 20),
  ('WELLNESS', 'Add-ons',      'add-ons',      30)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The ten wellness services.
--
-- `required_room_type` is OTHER for the drips (they occupy a private treatment
-- room for the whole slot) and NULL for shots and add-ons, which are quick
-- in-chair procedures. `loyalty_eligible` is false throughout: the brief is
-- explicit that wellness treatments must not count toward haircut loyalty.
-- ---------------------------------------------------------------------------
insert into public.services (
  id, name, category, subcategory_id, description, ingredients, ingredients_verified,
  price_cents, duration_minutes, required_room_type, loyalty_eligible, is_active
)
select
  v.id::uuid, v.name, v.category::public.service_category, sc.id, v.description,
  v.ingredients, v.ingredients_verified,
  v.price_cents, v.duration_minutes, v.required_room_type::public.room_type,
  false, true
from (values
  -- ---- IV Drips ----------------------------------------------------------
  ('11111111-0000-0000-0000-000000000011', 'Korean Glass Skin Drip', 'WELLNESS', 'iv-drips',
   'Korean-style glutathione drip. Duration is a placeholder pending confirmation from the business.',
   'Glutathione, Lipotocin (Thioctic Acid), Korean Vitamin C', true,
   180000, 60, 'OTHER'),

  ('11111111-0000-0000-0000-000000000012', 'Korean Youthful Glowing Skin Drip', 'WELLNESS', 'iv-drips',
   'Also known as the Cinderella or Baby Face Drip. Duration is a placeholder pending confirmation from the business.',
   'Glutathione, Vitamin C, Alpha Lipoic Acid', true,
   160000, 60, 'OTHER'),

  ('11111111-0000-0000-0000-000000000013', 'Luminous Drip', 'WELLNESS', 'iv-drips',
   'Also known as Miracle White with Melanin Inhibitor. INGREDIENTS NOT SUPPLIED by the business - confirm before publishing. Duration is also a placeholder.',
   null, false,
   140000, 60, 'OTHER'),

  ('11111111-0000-0000-0000-000000000014', 'Immune Booster Drip', 'WELLNESS', 'iv-drips',
   'Vitamin and mineral drip. Duration is a placeholder pending confirmation from the business.',
   'Vitamin C, Zinc, Vitamin B12, Collagen', true,
   150000, 60, 'OTHER'),

  -- ---- Beauty Shots ------------------------------------------------------
  ('11111111-0000-0000-0000-000000000015', 'Anti-Aging Shot (Placenta)', 'WELLNESS', 'beauty-shots',
   'A beauty treatment marketed for skin rejuvenation and anti-aging. Duration is a placeholder pending confirmation from the business.',
   'Placenta', true,
   120000, 30, null),

  ('11111111-0000-0000-0000-000000000016', 'Rejuvenating Shot (Collagen)', 'WELLNESS', 'beauty-shots',
   'A beauty treatment marketed to support skin elasticity and improve the appearance of fine lines and wrinkles. Duration is a placeholder pending confirmation from the business.',
   'Collagen', true,
   120000, 30, null),

  -- ---- Add-ons -----------------------------------------------------------
  ('11111111-0000-0000-0000-000000000017', 'Placenta Add-on', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Placenta', true,
   50000, 15, null),

  ('11111111-0000-0000-0000-000000000018', 'Collagen Add-on', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Collagen', true,
   50000, 15, null),

  ('11111111-0000-0000-0000-000000000019', 'Vitamin C Add-on', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Vitamin C', true,
   30000, 15, null),

  ('11111111-0000-0000-0000-000000000020', 'Multivitamins Add-on (Vitamin B12)', 'WELLNESS', 'add-ons',
   'Optional add-on. Duration is a placeholder pending confirmation from the business.',
   'Vitamin B12', true,
   30000, 15, null)
) as v (id, name, category, slug, description, ingredients, ingredients_verified,
        price_cents, duration_minutes, required_room_type)
join public.service_subcategories sc on sc.slug = v.slug
where not exists (
  select 1 from public.services s where s.name = v.name
);

-- ---------------------------------------------------------------------------
-- 3. The wellness services need someone qualified to deliver them.
--
-- Without this the ten services exist but are unbookable - availability finds
-- no qualified stylist on any day - which is a subtler failure than being
-- absent, because the menu looks right. Ana takes the whole wellness list (she
-- is the senior therapist) and Bea takes the in-chair procedures. Cara stays
-- hair-only, which is what the qualification tests rely on.
--
-- `on conflict do nothing` because employee_services has a composite primary
-- key on (employee_id, service_id).
-- ---------------------------------------------------------------------------
insert into public.employee_services (employee_id, service_id)
select e.id, s.id
from public.employees e
cross join public.services s
join public.service_subcategories sc on sc.id = s.subcategory_id
where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons')
  and e.is_active
  and (
    e.full_name = 'Ana Reyes'
    or (e.full_name = 'Bea Santos' and sc.slug in ('beauty-shots', 'add-ons'))
  )
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4. Self-checks.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_bad   integer;
  v_ids   text;
begin
  -- All ten wellness services present, by name, whatever ids they carry.
  select count(*) into v_count
    from public.services s
    join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons');
  if v_count <> 10 then
    raise exception 'migration 28: expected 10 wellness services, found %', v_count;
  end if;

  -- Four drips, two shots, four add-ons - not ten of one kind.
  select count(*) into v_bad
    from public.services s join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug = 'iv-drips';
  if v_bad <> 4 then
    raise exception 'migration 28: expected 4 IV drips, found %', v_bad;
  end if;

  select count(*) into v_bad
    from public.services s join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug = 'beauty-shots';
  if v_bad <> 2 then
    raise exception 'migration 28: expected 2 beauty shots, found %', v_bad;
  end if;

  select count(*) into v_bad
    from public.services s join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug = 'add-ons';
  if v_bad <> 4 then
    raise exception 'migration 28: expected 4 add-ons, found %', v_bad;
  end if;

  -- The Luminous Drip must still be flagged unverified rather than presented
  -- as fact. This is the one row where inventing an answer would be easy.
  if not exists (
    select 1 from public.services
     where name = 'Luminous Drip' and ingredients_verified = false
  ) then
    raise exception 'migration 28: Luminous Drip should have ingredients_verified = false';
  end if;

  -- Nothing wellness may count toward haircut loyalty.
  select count(*) into v_bad
    from public.services s
    join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons')
     and s.loyalty_eligible;
  if v_bad > 0 then
    raise exception 'migration 28: % wellness service(s) wrongly loyalty_eligible', v_bad;
  end if;

  -- Every one is priced, active and bookable.
  select count(*) into v_bad
    from public.services s
    join public.service_subcategories sc on sc.id = s.subcategory_id
   where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons')
     and (not s.is_active or s.price_cents <= 0);
  if v_bad > 0 then
    raise exception 'migration 28: % wellness service(s) are inactive or unpriced', v_bad;
  end if;

  -- And each has at least one qualified stylist, or the menu is a lie.
  -- Skipped on a database with no employees yet: there is nothing to qualify,
  -- and demanding one would fail a fresh project for the wrong reason.
  if exists (select 1 from public.employees where is_active) then
    select string_agg(s.name, ', ') into v_ids
      from public.services s
      join public.service_subcategories sc on sc.id = s.subcategory_id
     where sc.slug in ('iv-drips', 'beauty-shots', 'add-ons')
       and not exists (select 1 from public.employee_services es where es.service_id = s.id);
    if v_ids is not null then
      raise exception 'migration 28: wellness service(s) with no qualified stylist: %', v_ids;
    end if;
  else
    raise notice 'migration 28: no active employees - skipping the qualification check';
  end if;
end $$;
