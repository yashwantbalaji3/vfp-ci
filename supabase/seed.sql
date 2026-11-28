-- SYNTHETIC LOCAL DEMO DATA ONLY. Every venue, food, dish and recipe here is invented,
-- marked is_demo = true, and must never appear in production or count toward launch
-- catalog thresholds (CLAUDE.md). Coordinates are synthetic points near Boston for
-- radius tests; names start with "Demo" so nobody mistakes them for real places.
-- Fixed UUIDs let tests refer to fixtures (see tests/fixtures/ids.ts).

-- Centre, 25-mile radius and area as in migrations 20261124000100 (docs/83) and 20261125000600.
insert into public.markets (id, slug, name, country_code, default_timezone, state, center, radius_m, coverage_geometry)
values ('00000000-0000-4000-8000-00000000a001', 'boston', 'Boston area', 'US', 'America/New_York', 'planned',
        extensions.st_setsrid(extensions.st_makepoint(-71.0589, 42.3601), 4326)::extensions.geography, 40234,
        extensions.st_multi(extensions.st_buffer(extensions.st_setsrid(extensions.st_makepoint(-71.0589, 42.3601), 4326)::extensions.geography, 40234)::extensions.geometry)::extensions.geography)
-- Migration 20261125000600 already adds this same row on a clean database.
on conflict do nothing;

insert into public.licenses (id, label, checked_at, permitted_uses, attribution)
values ('00000000-0000-4000-8000-00000000b001', 'Synthetic fixture for local development (no real-world claim)', now(),
        array['display', 'store', 'derive'], 'Synthetic demo data');

insert into public.sources (id, publisher, source_type, license_id, access_scope, is_demo, retrieved_at)
values ('00000000-0000-4000-8000-00000000b101', 'Synthetic demo fixtures', 'synthetic_fixture',
        '00000000-0000-4000-8000-00000000b001', 'public', true, now());

insert into public.source_records (id, source_id, external_id, observed_at, evidence_summary, rights_status)
values ('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b101', 'demo-1', now(),
        'Synthetic values for automated tests. Not a real food fact.', 'cleared');

insert into public.venues (id, market_id, slug, name, neighborhood, locality, region, location, timezone, venue_type, status, is_demo, reviewed_at) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001', 'demo-central-kitchen', 'Demo Central Kitchen', 'Central Square', 'Cambridge', 'MA',
   extensions.st_setsrid(extensions.st_makepoint(-71.1040, 42.3655), 4326)::extensions.geography, 'America/New_York', 'restaurant', 'published', true, now()),
  ('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000a001', 'demo-davis-noodle-bar', 'Demo Davis Noodle Bar', 'Davis Square', 'Somerville', 'MA',
   extensions.st_setsrid(extensions.st_makepoint(-71.1226, 42.3967), 4326)::extensions.geography, 'America/New_York', 'restaurant', 'published', true, now()),
  ('00000000-0000-4000-8000-00000000c003', '00000000-0000-4000-8000-00000000a001', 'demo-back-bay-garden-cafe', 'Demo Back Bay Garden Café', 'Back Bay', 'Boston', 'MA',
   extensions.st_setsrid(extensions.st_makepoint(-71.0810, 42.3503), 4326)::extensions.geography, 'America/New_York', 'cafe', 'published', true, now());

-- Helper used only while seeding.
create function pg_temp.food(
  p_item uuid, p_rev uuid, p_kind text, p_name text, p_basis text, p_amount numeric, p_unit text,
  p_nutrients jsonb, p_venue uuid default null
) returns void language plpgsql as $$
declare k text; v jsonb;
begin
  insert into public.food_items (id, kind, visibility, status, is_demo) values (p_item, p_kind, 'public', 'approved', true);
  insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit, description)
  values (p_rev, p_item, 1, p_name, p_basis, p_amount, p_unit, 'Synthetic demo item for local development.');
  for k, v in select * from jsonb_each(p_nutrients) loop
    if jsonb_typeof(v) = 'null' then
      insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason, source_record_id)
      values (p_rev, k, null, 'published', 'not_provided', '00000000-0000-4000-8000-00000000b201');
    else
      insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id)
      values (p_rev, k, (v #>> '{}')::numeric, case when p_kind = 'recipe' then 'calculated' else 'published' end, '00000000-0000-4000-8000-00000000b201');
    end if;
  end loop;
  if p_venue is not null then
    insert into public.dishes (food_item_id, venue_id, menu_section) values (p_item, p_venue, 'Demo menu');
  end if;
end $$;

create function pg_temp.claim(p_rev uuid, p_diet text, p_outcome text, p_tier text default 'documented', p_days integer default 60)
returns void language sql as $$
  insert into public.dietary_claims (revision_id, diet, outcome, evidence_tier, source_record_id, checked_at, expires_at)
  values (p_rev, p_diet, p_outcome, p_tier, '00000000-0000-4000-8000-00000000b201', now(), now() + make_interval(days => p_days));
$$;

create function pg_temp.fam(p_rev uuid, p_family text, p_presence text, p_detail text default null)
returns void language sql as $$
  insert into public.ingredient_family_statements (revision_id, family, presence, source_record_id, detail, checked_at, expires_at)
  values (p_rev, p_family, p_presence, case when p_presence = 'unknown' then null else '00000000-0000-4000-8000-00000000b201'::uuid end,
          p_detail, now(), now() + interval '60 days');
$$;

-- F01 / F07: 12 g protein per 100 g ingredient.
select pg_temp.food('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000111', 'ingredient', 'Demo firm tofu',
  'mass', 100, 'g', '{"energy_kcal": 144, "protein_g": 12, "carb_g": 3, "fat_g": 8, "fiber_g": 2, "sodium_mg": 10}');
insert into public.portions (id, revision_id, label, amount, unit, grams, source_record_id) values
  ('00000000-0000-4000-8000-000000000121', '00000000-0000-4000-8000-000000000111', '150 g', 150, 'g', 150, '00000000-0000-4000-8000-00000000b201');
select pg_temp.fam('00000000-0000-4000-8000-000000000111', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000000111', 'dairy', 'absent_by_statement');
select pg_temp.claim('00000000-0000-4000-8000-000000000111', 'vegan', 'compatible');

-- F02: 24 g protein per stated serving, no gram weight.
select pg_temp.food('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000211', 'dish', 'Demo chickpea power bowl',
  'serving', 1, 'serving', '{"energy_kcal": 610, "protein_g": 24, "carb_g": null, "fat_g": null, "fiber_g": null, "sodium_mg": null}',
  '00000000-0000-4000-8000-00000000c001');
insert into public.portions (id, revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000221', '00000000-0000-4000-8000-000000000211', '1 bowl (stated serving)', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000211', 'vegan', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000000211', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000000211', 'dairy', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000000211', 'honey', 'absent_by_statement');

-- F10: 10 g protein per 100 g with a 2 oz portion (no gram value stored on the portion).
select pg_temp.food('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000311', 'ingredient', 'Demo roasted peanuts snack mix',
  'mass', 100, 'g', '{"energy_kcal": 500, "protein_g": 10, "carb_g": 40, "fat_g": 30, "fiber_g": 5, "sodium_mg": 300}');
insert into public.portions (id, revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000321', '00000000-0000-4000-8000-000000000311', '2 oz', 2, 'oz', '00000000-0000-4000-8000-00000000b201');

-- F11: a "bowl" portion with no gram mapping on a mass basis -> unquantified log.
select pg_temp.food('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000411', 'dish', 'Demo house dal',
  'mass', 100, 'g', '{"energy_kcal": 120, "protein_g": 7, "carb_g": 15, "fat_g": 4, "fiber_g": 4, "sodium_mg": 250}',
  '00000000-0000-4000-8000-00000000c003');
insert into public.portions (id, revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000411', '1 bowl', 1, 'bowl', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000411', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000000411', 'dairy', 'present', 'Finished with ghee');
select pg_temp.fam('00000000-0000-4000-8000-000000000411', 'egg', 'absent_by_statement');

-- Unknown protein dish (protein null with reason).
select pg_temp.food('00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000511', 'dish', 'Demo mushroom toast',
  'serving', 1, 'serving', '{"energy_kcal": null, "protein_g": null}', '00000000-0000-4000-8000-00000000c003');
insert into public.portions (id, revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000521', '00000000-0000-4000-8000-000000000511', '1 plate', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000511', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000000511', 'egg', 'unknown', 'Bread recipe not confirmed');

-- Hidden-egg fixtures for egg-free vegetarian tests (doc 14 v1.1).
select pg_temp.food('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000611', 'dish', 'Demo egg noodle stir-fry',
  'serving', 1, 'serving', '{"protein_g": 18}', '00000000-0000-4000-8000-00000000c002');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000611', '1 plate', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000611', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000000611', 'egg', 'present', 'Egg noodles');

select pg_temp.food('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000711', 'dish', 'Demo veggie burger',
  'serving', 1, 'serving', '{"protein_g": 21}', '00000000-0000-4000-8000-00000000c001');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000711', '1 burger', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000711', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000000711', 'egg', 'unknown', 'Patty binder not confirmed');

select pg_temp.food('00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000811', 'dish', 'Demo paneer tikka',
  'serving', 1, 'serving', '{"protein_g": 26}', '00000000-0000-4000-8000-00000000c001');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000811', '1 plate', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000811', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000000811', 'egg', 'absent_by_statement', 'Operator confirmed no egg in marinade');
select pg_temp.fam('00000000-0000-4000-8000-000000000811', 'dairy', 'present', 'Paneer and yogurt');
select pg_temp.fam('00000000-0000-4000-8000-000000000811', 'animal_rennet', 'absent_by_statement', 'Paneer is acid-set');

-- Labeled "vegetarian" by a venue but contains fish sauce: must never qualify.
select pg_temp.food('00000000-0000-4000-8000-000000000901', '00000000-0000-4000-8000-000000000911', 'dish', 'Demo green papaya salad',
  'serving', 1, 'serving', '{"protein_g": 6}', '00000000-0000-4000-8000-00000000c002');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000000911', '1 plate', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000000911', 'vegetarian', 'compatible', 'community_report');
select pg_temp.fam('00000000-0000-4000-8000-000000000911', 'fish_sauce', 'present', 'Dressing contains fish sauce');

-- F06: 20 g protein and 200 kcal on the same basis.
select pg_temp.food('00000000-0000-4000-8000-000000001001', '00000000-0000-4000-8000-000000001011', 'packaged', 'Demo protein crispbread',
  'serving', 1, 'serving', '{"energy_kcal": 200, "protein_g": 20}');
insert into public.portions (revision_id, label, amount, unit, grams, source_record_id) values
  ('00000000-0000-4000-8000-000000001011', '1 pack', 1, 'serving', 50, '00000000-0000-4000-8000-00000000b201');

-- Recipe ingredients and a demo recipe (F04 is tested in TypeScript; this exercises recipe eligibility).
select pg_temp.food('00000000-0000-4000-8000-000000001101', '00000000-0000-4000-8000-000000001111', 'ingredient', 'Demo dry red lentils',
  'mass', 100, 'g', '{"energy_kcal": 350, "protein_g": 24}');
select pg_temp.fam('00000000-0000-4000-8000-000000001111', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001111', 'dairy', 'absent_by_statement');
select pg_temp.food('00000000-0000-4000-8000-000000001201', '00000000-0000-4000-8000-000000001211', 'ingredient', 'Demo vegetable stock',
  'volume', 100, 'ml', '{"energy_kcal": 5, "protein_g": 0.2}');
select pg_temp.fam('00000000-0000-4000-8000-000000001211', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001211', 'dairy', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001211', 'animal_stock', 'absent_by_statement');
select pg_temp.food('00000000-0000-4000-8000-000000001301', '00000000-0000-4000-8000-000000001311', 'ingredient', 'Demo butter',
  'mass', 100, 'g', '{"energy_kcal": 717, "protein_g": 0.9}');
select pg_temp.fam('00000000-0000-4000-8000-000000001311', 'dairy', 'present');

select pg_temp.food('00000000-0000-4000-8000-000000001401', '00000000-0000-4000-8000-000000001411', 'recipe', 'Demo red lentil soup',
  'serving', 1, 'serving', '{}');   -- numbers are calculated from the ingredients in the M4 section below
update public.food_revisions
   set description = 'A plain red lentil soup simmered in vegetable stock. Butter is optional and is left out unless you add it.'
 where id = '00000000-0000-4000-8000-000000001411';
insert into public.recipe_revisions (food_revision_id, yield_servings, prep_minutes, cook_minutes, equipment, rights_record_id, trial_cooked_at)
values ('00000000-0000-4000-8000-000000001411', 4, 10, 25, array['pot'], '00000000-0000-4000-8000-00000000b201', now());
insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit, grams, optional, included_by_default) values
  ('00000000-0000-4000-8000-000000001411', '00000000-0000-4000-8000-000000001111', 1, 200, 'g', 200, false, true),
  ('00000000-0000-4000-8000-000000001411', '00000000-0000-4000-8000-000000001211', 2, 1000, 'ml', null, false, true),
  ('00000000-0000-4000-8000-000000001411', '00000000-0000-4000-8000-000000001311', 3, 15, 'g', 15, true, false);
insert into public.recipe_steps (recipe_revision_id, ordinal, instruction, timer_seconds) values
  ('00000000-0000-4000-8000-000000001411', 1, 'Rinse the lentils until the water runs clear.', null),
  ('00000000-0000-4000-8000-000000001411', 2, 'Simmer lentils in the stock until soft.', 1500),
  ('00000000-0000-4000-8000-000000001411', 3, 'Season to taste and serve.', null);
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000001411', '1 bowl (1/4 of the pot)', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000001411', 'vegan', 'compatible', 'curator_assessment');

-- ---------------------------------------------------------------------------
-- M2 discovery fixtures: venue attributes, two more demo venues and six more demo dishes
-- covering confirmed, unconfirmed, conditional, contains-egg and estimated-nutrition cases.
-- ---------------------------------------------------------------------------
update public.venues set cuisines = array['indian', 'bowls'], price_band = 2 where id = '00000000-0000-4000-8000-00000000c001';
update public.venues set cuisines = array['thai', 'noodles'], price_band = 2 where id = '00000000-0000-4000-8000-00000000c002';
update public.venues set cuisines = array['cafe', 'indian'], price_band = 1 where id = '00000000-0000-4000-8000-00000000c003';

insert into public.venues (id, market_id, slug, name, neighborhood, locality, region, location, timezone, venue_type, status, is_demo, reviewed_at, cuisines, price_band) values
  ('00000000-0000-4000-8000-00000000c004', '00000000-0000-4000-8000-00000000a001', 'demo-harvard-tofu-house', 'Demo Harvard Tofu House', 'Harvard Square', 'Cambridge', 'MA',
   extensions.st_setsrid(extensions.st_makepoint(-71.1190, 42.3736), 4326)::extensions.geography, 'America/New_York', 'restaurant', 'published', true, now(), array['korean', 'tofu'], 2),
  ('00000000-0000-4000-8000-00000000c005', '00000000-0000-4000-8000-00000000a001', 'demo-allston-dosa-corner', 'Demo Allston Dosa Corner', 'Allston', 'Boston', 'MA',
   extensions.st_setsrid(extensions.st_makepoint(-71.1312, 42.3539), 4326)::extensions.geography, 'America/New_York', 'restaurant', 'published', true, now(), array['south-indian'], 1);

select pg_temp.food('00000000-0000-4000-8000-000000001501', '00000000-0000-4000-8000-000000001511', 'dish', 'Demo soft tofu stew',
  'serving', 1, 'serving', '{"energy_kcal": 410, "protein_g": 22}', '00000000-0000-4000-8000-00000000c004');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000001511', '1 pot', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000001511', 'vegan', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000001511', 'egg', 'absent_by_statement', 'Served without the usual egg');
select pg_temp.fam('00000000-0000-4000-8000-000000001511', 'dairy', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001511', 'animal_stock', 'absent_by_statement', 'Kelp and mushroom broth');

select pg_temp.food('00000000-0000-4000-8000-000000001601', '00000000-0000-4000-8000-000000001611', 'dish', 'Demo tofu bibimbap',
  'serving', 1, 'serving', '{"energy_kcal": 640, "protein_g": 25}', '00000000-0000-4000-8000-00000000c004');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000001611', '1 bowl', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000001611', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000001611', 'egg', 'present', 'Topped with a fried egg');
select pg_temp.fam('00000000-0000-4000-8000-000000001611', 'dairy', 'absent_by_statement');

select pg_temp.food('00000000-0000-4000-8000-000000001701', '00000000-0000-4000-8000-000000001711', 'dish', 'Demo masala dosa',
  'serving', 1, 'serving', '{"energy_kcal": 380, "protein_g": 9}', '00000000-0000-4000-8000-00000000c005');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000001711', '1 dosa', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000001711', 'vegetarian', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000001711', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001711', 'dairy', 'unknown', 'Griddle fat not confirmed (oil or ghee)');

select pg_temp.food('00000000-0000-4000-8000-000000001801', '00000000-0000-4000-8000-000000001811', 'dish', 'Demo idli sambar',
  'serving', 1, 'serving', '{"energy_kcal": 290, "protein_g": 11}', '00000000-0000-4000-8000-00000000c005');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000001811', '3 idli with sambar', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000001811', 'vegan', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000001811', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001811', 'dairy', 'absent_by_statement');

-- Estimated nutrition: hidden unless the person opts in to estimates (R-P03).
select pg_temp.food('00000000-0000-4000-8000-000000001901', '00000000-0000-4000-8000-000000001911', 'dish', 'Demo tempeh rice bowl',
  'serving', 1, 'serving', '{"protein_g": 28}', '00000000-0000-4000-8000-00000000c001');
update public.nutrient_values
   set method = 'estimated', lower_value = 24, upper_value = 32, assumptions = 'Synthetic estimate from a typical tempeh portion; not a published value.'
 where revision_id = '00000000-0000-4000-8000-000000001911' and nutrient_code = 'protein_g';
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000001911', '1 bowl', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
select pg_temp.claim('00000000-0000-4000-8000-000000001911', 'vegan', 'compatible');
select pg_temp.fam('00000000-0000-4000-8000-000000001911', 'egg', 'absent_by_statement');
select pg_temp.fam('00000000-0000-4000-8000-000000001911', 'dairy', 'absent_by_statement');

-- Conditional dish: suitable only with a requested change.
select pg_temp.food('00000000-0000-4000-8000-000000002001', '00000000-0000-4000-8000-000000002011', 'dish', 'Demo peanut noodles',
  'serving', 1, 'serving', '{"energy_kcal": 560, "protein_g": 17}', '00000000-0000-4000-8000-00000000c002');
insert into public.portions (revision_id, label, amount, unit, source_record_id) values
  ('00000000-0000-4000-8000-000000002011', '1 bowl', 1, 'serving', '00000000-0000-4000-8000-00000000b201');
insert into public.dietary_claims (revision_id, diet, outcome, evidence_tier, source_record_id, modifications, checked_at, expires_at)
values ('00000000-0000-4000-8000-000000002011', 'vegetarian', 'conditional', 'documented', '00000000-0000-4000-8000-00000000b201',
        'Ask for the dressing without fish sauce.', now(), now() + interval '60 days');
select pg_temp.fam('00000000-0000-4000-8000-000000002011', 'egg', 'absent_by_statement', 'Rice noodles');
select pg_temp.fam('00000000-0000-4000-8000-000000002011', 'dairy', 'absent_by_statement');

insert into public.dish_prices (dish_id, amount_minor, serving_description, checked_at, source_record_id) values
  ('00000000-0000-4000-8000-000000000201', 1350, '1 bowl', now(), '00000000-0000-4000-8000-00000000b201'),
  ('00000000-0000-4000-8000-000000000801', 1500, '1 plate', now(), '00000000-0000-4000-8000-00000000b201'),
  ('00000000-0000-4000-8000-000000001501', 1400, '1 pot', now(), '00000000-0000-4000-8000-00000000b201'),
  ('00000000-0000-4000-8000-000000001701', 1100, '1 dosa', now(), '00000000-0000-4000-8000-00000000b201');

-- ---------------------------------------------------------------------------
-- M4 recipe library: eleven original demo recipes written for this project, plus the
-- lentil soup above (twelve in all). Nothing here is copied from a book, site or database.
-- Ingredient nutrition figures are rounded, invented demo values per 100 g. They exist so
-- the ingredient-level calculation, scaling and substitutions can be exercised honestly.
-- Fixed ids: ingredient item 41NNNN / revision 42NNNN, recipe item 43NNNN / revision 44NNNN,
-- recipe line 45RRPP (RR = recipe number, PP = position).
-- ---------------------------------------------------------------------------
create function pg_temp.id(p_prefix text, p_n integer) returns uuid language sql as $$
  select ('00000000-0000-4000-8000-000000' || p_prefix || lpad(p_n::text, 4, '0'))::uuid;
$$;

-- One demo ingredient per 100 g, with a statement for every ingredient family and its own
-- vegetarian and vegan evidence, so a substituted recipe can be re-checked ingredient by ingredient.
create function pg_temp.ing(
  p_n integer, p_name text, p_nutrients jsonb,
  p_present text[] default '{}', p_unknown text[] default '{}',
  p_allergens text[] default '{}', p_allergens_unknown text[] default '{}'
) returns void language plpgsql as $$
declare
  v_rev uuid := pg_temp.id('42', p_n);
  f record;
  a text;
begin
  perform pg_temp.food(pg_temp.id('41', p_n), v_rev, 'ingredient', p_name, 'mass', 100, 'g', p_nutrients);
  for f in select code, non_vegan, non_vegetarian from public.ingredient_families loop
    perform pg_temp.fam(v_rev, f.code,
      case when f.code = any(p_present) then 'present' when f.code = any(p_unknown) then 'unknown' else 'absent_by_statement' end);
  end loop;
  perform pg_temp.claim(v_rev, 'vegan',
    case when exists (select 1 from public.ingredient_families x where x.code = any(p_present) and x.non_vegan) then 'incompatible'
         when cardinality(p_unknown) > 0 then 'unknown' else 'compatible' end);
  perform pg_temp.claim(v_rev, 'vegetarian',
    case when exists (select 1 from public.ingredient_families x where x.code = any(p_present) and x.non_vegetarian) then 'incompatible'
         else 'compatible' end);
  foreach a in array p_allergens loop
    insert into public.allergen_statements (revision_id, allergen, presence, source_record_id, checked_at)
    values (v_rev, a, 'present', '00000000-0000-4000-8000-00000000b201', now());
  end loop;
  foreach a in array p_allergens_unknown loop
    insert into public.allergen_statements (revision_id, allergen, presence, source_record_id, checked_at)
    values (v_rev, a, 'unknown', '00000000-0000-4000-8000-00000000b201', now());
  end loop;
end $$;

create function pg_temp.rec(
  p_n integer, p_name text, p_description text, p_servings numeric, p_prep integer, p_cook integer,
  p_meals text[], p_cuisine text, p_equipment text[], p_serving_note text, p_vegan text, p_vegetarian text
) returns void language plpgsql as $$
declare v_rev uuid := pg_temp.id('44', p_n);
begin
  perform pg_temp.food(pg_temp.id('43', p_n), v_rev, 'recipe', p_name, 'serving', 1, 'serving', '{}');
  update public.food_revisions set description = p_description where id = v_rev;
  insert into public.recipe_revisions (food_revision_id, yield_servings, prep_minutes, cook_minutes, equipment, rights_record_id,
                                       trial_cooked_at, meal_types, cuisine, serving_note)
  values (v_rev, p_servings, p_prep, p_cook, p_equipment, '00000000-0000-4000-8000-00000000b202', null, p_meals, p_cuisine, p_serving_note);
  insert into public.portions (revision_id, label, amount, unit, source_record_id)
  values (v_rev, '1 serving', 1, 'serving', '00000000-0000-4000-8000-00000000b202');
  perform pg_temp.claim(v_rev, 'vegan', p_vegan, 'curator_assessment');
  perform pg_temp.claim(v_rev, 'vegetarian', p_vegetarian, 'curator_assessment');
end $$;

-- One ingredient line. p_group marks an approved substitution group; the default line has p_default = true.
create function pg_temp.line(
  p_recipe integer, p_pos integer, p_ing integer, p_qty numeric, p_unit text, p_grams numeric,
  p_prep text default null, p_optional boolean default false, p_group text default null,
  p_default boolean default true, p_sub_note text default null
) returns void language sql as $$
  insert into public.recipe_ingredients (id, recipe_revision_id, ingredient_revision_id, position, quantity, unit, grams,
                                         optional, included_by_default, substitution_group, prep_note, substitution_note)
  values (('00000000-0000-4000-8000-00000045' || lpad(p_recipe::text, 2, '0') || lpad(p_pos::text, 2, '0'))::uuid,
          pg_temp.id('44', p_recipe), pg_temp.id('42', p_ing), p_pos, p_qty, p_unit, p_grams,
          case when p_group is not null then not p_default else p_optional end, p_default, p_group, p_prep, p_sub_note);
$$;

create function pg_temp.step(p_recipe integer, p_ordinal integer, p_title text, p_text text, p_timer integer default null)
returns void language sql as $$
  insert into public.recipe_steps (recipe_revision_id, ordinal, title, instruction, timer_seconds)
  values (pg_temp.id('44', p_recipe), p_ordinal, p_title, p_text, p_timer);
$$;

-- Stores the recipe's per-serving numbers exactly as the ingredient-level calculation gives them.
create function pg_temp.calc_rev(p_rev uuid) returns void language sql as $$
  insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason, source_record_id, assumptions)
  select p_rev, n.key, (n.value ->> 'value')::numeric, 'calculated',
         case when n.value ->> 'value' is null then 'incomplete_recipe' end,
         '00000000-0000-4000-8000-00000000b202',
         'Sum of the ingredient amounts divided by the number of servings. No adjustment for cooking losses.'
    from jsonb_each(app.recipe_variant_nutrients(p_rev, '{}'::jsonb)) n;
$$;
create function pg_temp.calc(p_recipe integer) returns void language sql as $$
  select pg_temp.calc_rev(pg_temp.id('44', p_recipe));
$$;

insert into public.source_records (id, source_id, external_id, observed_at, evidence_summary, rights_status)
values ('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b101', 'demo-recipes-m4', now(),
        'Original demo recipe written for this project. Nutrition is calculated from invented demo ingredient values, not from a tested kitchen batch.',
        'cleared');

-- Ingredients (per 100 g): energy, protein, carbohydrate, fat, fiber.
select pg_temp.ing(1, 'Demo extra-firm tofu', '{"energy_kcal":144,"protein_g":15,"carb_g":3,"fat_g":8.5,"fiber_g":2}', '{}', '{}', '{soy}');
select pg_temp.ing(2, 'Demo onion', '{"energy_kcal":40,"protein_g":1.1,"carb_g":9.3,"fat_g":0.1,"fiber_g":1.7}');
select pg_temp.ing(3, 'Demo tomato', '{"energy_kcal":18,"protein_g":0.9,"carb_g":3.9,"fat_g":0.2,"fiber_g":1.2}');
select pg_temp.ing(4, 'Demo spinach', '{"energy_kcal":23,"protein_g":2.9,"carb_g":3.6,"fat_g":0.4,"fiber_g":2.2}');
select pg_temp.ing(5, 'Demo sunflower oil', '{"energy_kcal":884,"protein_g":0,"carb_g":0,"fat_g":100,"fiber_g":0}');
select pg_temp.ing(6, 'Demo olive oil', '{"energy_kcal":884,"protein_g":0,"carb_g":0,"fat_g":100,"fiber_g":0}');
select pg_temp.ing(7, 'Demo garlic', '{"energy_kcal":149,"protein_g":6.4,"carb_g":33,"fat_g":0.5,"fiber_g":2.1}');
select pg_temp.ing(8, 'Demo fresh ginger', '{"energy_kcal":80,"protein_g":1.8,"carb_g":18,"fat_g":0.8,"fiber_g":2}');
select pg_temp.ing(9, 'Demo ground turmeric', '{"energy_kcal":312,"protein_g":9.7,"carb_g":67,"fat_g":3.3,"fiber_g":22.7}');
select pg_temp.ing(10, 'Demo ground cumin', '{"energy_kcal":375,"protein_g":17.8,"carb_g":44,"fat_g":22,"fiber_g":10.5}');
select pg_temp.ing(11, 'Demo garam masala', '{"energy_kcal":380,"protein_g":14,"carb_g":50,"fat_g":15,"fiber_g":20}');
select pg_temp.ing(12, 'Demo salt', '{"energy_kcal":0,"protein_g":0,"carb_g":0,"fat_g":0,"fiber_g":0}');
select pg_temp.ing(13, 'Demo rolled oats', '{"energy_kcal":379,"protein_g":13.2,"carb_g":67.7,"fat_g":6.5,"fiber_g":10.1}', '{}', '{}', '{}', '{gluten}');
select pg_temp.ing(14, 'Demo unsweetened soy milk', '{"energy_kcal":33,"protein_g":3.3,"carb_g":1.2,"fat_g":1.8,"fiber_g":0.4}', '{}', '{}', '{soy}');
select pg_temp.ing(15, 'Demo whole milk', '{"energy_kcal":61,"protein_g":3.2,"carb_g":4.8,"fat_g":3.3,"fiber_g":0}', '{dairy}', '{}', '{milk}');
select pg_temp.ing(16, 'Demo peanut butter', '{"energy_kcal":598,"protein_g":22,"carb_g":22,"fat_g":51,"fiber_g":5}', '{}', '{}', '{peanut}');
select pg_temp.ing(17, 'Demo chia seeds', '{"energy_kcal":486,"protein_g":16.5,"carb_g":42,"fat_g":30.7,"fiber_g":34.4}');
select pg_temp.ing(18, 'Demo maple syrup', '{"energy_kcal":260,"protein_g":0,"carb_g":67,"fat_g":0.1,"fiber_g":0}');
select pg_temp.ing(19, 'Demo honey', '{"energy_kcal":304,"protein_g":0.3,"carb_g":82,"fat_g":0,"fiber_g":0.2}', '{honey}');
select pg_temp.ing(20, 'Demo banana', '{"energy_kcal":89,"protein_g":1.1,"carb_g":22.8,"fat_g":0.3,"fiber_g":2.6}');
select pg_temp.ing(21, 'Demo Greek-style yogurt', '{"energy_kcal":73,"protein_g":9.9,"carb_g":3.9,"fat_g":1.9,"fiber_g":0}', '{dairy}', '{}', '{milk}');
select pg_temp.ing(22, 'Demo high-protein soy yogurt', '{"energy_kcal":70,"protein_g":6,"carb_g":3,"fat_g":2.7,"fiber_g":0.8}', '{}', '{}', '{soy}');
select pg_temp.ing(23, 'Demo walnuts', '{"energy_kcal":654,"protein_g":15.2,"carb_g":13.7,"fat_g":65.2,"fiber_g":6.7}', '{}', '{}', '{tree_nut}');
select pg_temp.ing(24, 'Demo mixed berries', '{"energy_kcal":50,"protein_g":0.9,"carb_g":12,"fat_g":0.3,"fiber_g":3.5}');
select pg_temp.ing(25, 'Demo eggs', '{"energy_kcal":143,"protein_g":12.6,"carb_g":0.7,"fat_g":9.5,"fiber_g":0}', '{egg}', '{}', '{egg}');
select pg_temp.ing(26, 'Demo canned white beans', '{"energy_kcal":114,"protein_g":7,"carb_g":20,"fat_g":0.5,"fiber_g":5.5}');
select pg_temp.ing(27, 'Demo red bell pepper', '{"energy_kcal":31,"protein_g":1,"carb_g":6,"fat_g":0.3,"fiber_g":2.1}');
select pg_temp.ing(28, 'Demo canned chopped tomatoes', '{"energy_kcal":24,"protein_g":1.2,"carb_g":4,"fat_g":0.2,"fiber_g":1}');
select pg_temp.ing(29, 'Demo smoked paprika', '{"energy_kcal":282,"protein_g":14,"carb_g":54,"fat_g":13,"fiber_g":35}');
select pg_temp.ing(30, 'Demo canned chickpeas', '{"energy_kcal":139,"protein_g":7,"carb_g":20,"fat_g":2.6,"fiber_g":6}');
select pg_temp.ing(31, 'Demo paneer', '{"energy_kcal":280,"protein_g":18,"carb_g":3.4,"fat_g":22,"fiber_g":0}', '{dairy}', '{}', '{milk}');
select pg_temp.ing(32, 'Demo single cream', '{"energy_kcal":195,"protein_g":2.7,"carb_g":3.7,"fat_g":19,"fiber_g":0}', '{dairy}', '{}', '{milk}');
select pg_temp.ing(33, 'Demo coconut milk', '{"energy_kcal":197,"protein_g":2,"carb_g":2.8,"fat_g":21,"fiber_g":0}');
select pg_temp.ing(34, 'Demo split red lentils', '{"energy_kcal":352,"protein_g":24,"carb_g":60,"fat_g":1.5,"fiber_g":11}');
select pg_temp.ing(35, 'Demo ghee', '{"energy_kcal":900,"protein_g":0,"carb_g":0,"fat_g":100,"fiber_g":0}', '{dairy}', '{}', '{milk}');
select pg_temp.ing(36, 'Demo basmati rice', '{"energy_kcal":356,"protein_g":8,"carb_g":78,"fat_g":0.6,"fiber_g":1.3}');
select pg_temp.ing(37, 'Demo broccoli', '{"energy_kcal":34,"protein_g":2.8,"carb_g":6.6,"fat_g":0.4,"fiber_g":2.6}');
select pg_temp.ing(38, 'Demo soy sauce', '{"energy_kcal":53,"protein_g":8.1,"carb_g":4.9,"fat_g":0.6,"fiber_g":0.8}', '{}', '{}', '{soy,wheat}');
select pg_temp.ing(39, 'Demo toasted sesame oil', '{"energy_kcal":884,"protein_g":0,"carb_g":0,"fat_g":100,"fiber_g":0}', '{}', '{}', '{sesame}');
select pg_temp.ing(40, 'Demo sesame seeds', '{"energy_kcal":573,"protein_g":17.7,"carb_g":23.4,"fat_g":49.7,"fiber_g":11.8}', '{}', '{}', '{sesame}');
select pg_temp.ing(41, 'Demo cornstarch', '{"energy_kcal":381,"protein_g":0.3,"carb_g":91,"fat_g":0.1,"fiber_g":0.9}');
select pg_temp.ing(42, 'Demo wheat noodles', '{"energy_kcal":350,"protein_g":12,"carb_g":71,"fat_g":1.5,"fiber_g":3}', '{}', '{}', '{wheat,gluten}');
select pg_temp.ing(43, 'Demo egg noodles', '{"energy_kcal":384,"protein_g":14,"carb_g":71,"fat_g":4.4,"fiber_g":3.3}', '{egg}', '{}', '{egg,wheat,gluten}');
select pg_temp.ing(44, 'Demo fresh market noodles', '{"energy_kcal":280,"protein_g":9,"carb_g":55,"fat_g":2,"fiber_g":2}', '{}', '{egg}', '{wheat,gluten}', '{egg}');
select pg_temp.ing(45, 'Demo shelled edamame', '{"energy_kcal":121,"protein_g":11.9,"carb_g":8.9,"fat_g":5.2,"fiber_g":5.2}', '{}', '{}', '{soy}');
select pg_temp.ing(46, 'Demo carrot', '{"energy_kcal":41,"protein_g":0.9,"carb_g":9.6,"fat_g":0.2,"fiber_g":2.8}');
select pg_temp.ing(47, 'Demo cucumber', '{"energy_kcal":15,"protein_g":0.7,"carb_g":3.6,"fat_g":0.1,"fiber_g":0.5}');
select pg_temp.ing(48, 'Demo lime juice', '{"energy_kcal":25,"protein_g":0.4,"carb_g":8.4,"fat_g":0.1,"fiber_g":0.4}');
select pg_temp.ing(49, 'Demo lemon juice', '{"energy_kcal":22,"protein_g":0.4,"carb_g":6.9,"fat_g":0.2,"fiber_g":0.3}');
select pg_temp.ing(50, 'Demo quinoa', '{"energy_kcal":368,"protein_g":14.1,"carb_g":64.2,"fat_g":6.1,"fiber_g":7}');
select pg_temp.ing(51, 'Demo tahini', '{"energy_kcal":595,"protein_g":17,"carb_g":21.2,"fat_g":53.8,"fiber_g":9.3}', '{}', '{}', '{sesame}');
select pg_temp.ing(52, 'Demo flat-leaf parsley', '{"energy_kcal":36,"protein_g":3,"carb_g":6.3,"fat_g":0.8,"fiber_g":3.3}');
select pg_temp.ing(53, 'Demo water', '{"energy_kcal":0,"protein_g":0,"carb_g":0,"fat_g":0,"fiber_g":0}');
select pg_temp.ing(54, 'Demo fresh coriander', '{"energy_kcal":23,"protein_g":2.1,"carb_g":3.7,"fat_g":0.5,"fiber_g":2.8}');
select pg_temp.ing(55, 'Demo green chili', '{"energy_kcal":40,"protein_g":2,"carb_g":9,"fat_g":0.2,"fiber_g":1.5}');

-- 1. Masala tofu scramble -----------------------------------------------------
select pg_temp.rec(1, 'Demo masala tofu scramble',
  'Crumbled tofu cooked soft with onion, tomato and warm spices. A savoury breakfast that is ready in the time it takes to make toast.',
  2, 10, 12, '{breakfast}', 'indian', array['large frying pan', 'wooden spoon'], 'One serving is half the pan.', 'compatible', 'compatible');
select pg_temp.line(1, 1, 1, 400, 'g', 400, 'drained and patted dry');
select pg_temp.line(1, 2, 5, 1, 'tbsp', 14);
select pg_temp.line(1, 3, 2, 1, 'medium', 110, 'finely chopped');
select pg_temp.line(1, 4, 55, 1, 'small', 10, 'finely chopped', true);
select pg_temp.line(1, 5, 3, 1, 'medium', 120, 'chopped');
select pg_temp.line(1, 6, 9, 0.5, 'tsp', 1.5);
select pg_temp.line(1, 7, 10, 1, 'tsp', 2.5);
select pg_temp.line(1, 8, 12, 0.5, 'tsp', 3);
select pg_temp.line(1, 9, 4, 60, 'g', 60, 'roughly chopped');
select pg_temp.line(1, 10, 54, 10, 'g', 10, 'chopped, to finish', true);
select pg_temp.step(1, 1, 'Crumble the tofu', 'Crumble the tofu into a bowl with your hands. Aim for uneven pieces about the size of a pea, with a few larger ones.');
select pg_temp.step(1, 2, 'Soften the onion', 'Warm the oil in the pan over medium heat. Add the onion and the chili, if using, and cook until soft and just turning golden. Stir now and then.', 300);
select pg_temp.step(1, 3, 'Add tomato and spices', 'Add the tomato, turmeric, cumin and salt. Cook until the tomato breaks down and the pan looks jammy.', 180);
select pg_temp.step(1, 4, 'Cook the tofu', 'Stir in the tofu so every piece turns yellow. Cook, stirring gently, until it is hot all the way through and most of the liquid has gone.', 240);
select pg_temp.step(1, 5, 'Wilt the spinach', 'Fold in the spinach and cook for one minute, just until it wilts. Taste and add a pinch more salt if it needs it.', 60);
select pg_temp.step(1, 6, 'Serve', 'Scatter over the coriander, if using, and serve straight away.');
select pg_temp.calc(1);

-- 2. Peanut butter overnight oats ---------------------------------------------
select pg_temp.rec(2, 'Demo peanut butter overnight oats',
  'Oats, chia and peanut butter stirred together the night before. Nothing to cook: the fridge does the work while you sleep.',
  1, 5, 0, '{breakfast}', 'everyday', array['jar or bowl with a lid', 'spoon'], 'Makes one jar. Rest it in the fridge for at least 6 hours.', 'compatible', 'compatible');
select pg_temp.line(2, 1, 13, 50, 'g', 50);
select pg_temp.line(2, 2, 17, 1, 'tbsp', 12);
select pg_temp.line(2, 3, 14, 180, 'ml', 185, null, false, 'milk', true);
select pg_temp.line(2, 4, 15, 180, 'ml', 186, null, false, 'milk', false, 'Whole milk is dairy, so the oats are no longer vegan.');
select pg_temp.line(2, 5, 16, 1, 'tbsp', 16);
select pg_temp.line(2, 6, 18, 1, 'tsp', 7, null, false, 'sweetener', true);
select pg_temp.line(2, 7, 19, 1, 'tsp', 7, null, false, 'sweetener', false, 'Honey is not vegan.');
select pg_temp.line(2, 8, 20, 0.5, 'medium', 60, 'sliced, to serve');
select pg_temp.step(2, 1, 'Mix', 'Put the oats and chia seeds in the jar. Pour in the milk, add the peanut butter and the sweetener, and stir well until no dry pockets remain.');
select pg_temp.step(2, 2, 'Rest', 'Put the lid on and leave in the fridge overnight, or for at least 6 hours. The oats and chia will soak up the liquid and thicken.');
select pg_temp.step(2, 3, 'Serve', 'Stir once more. Loosen with a splash of milk if it is thicker than you like, then top with the sliced banana.');
select pg_temp.calc(2);

-- 3. Yogurt bowl with walnuts and berries -------------------------------------
select pg_temp.rec(3, 'Demo yogurt bowl with walnuts and berries',
  'Thick yogurt with toasted walnuts, berries and a little sweetness. Five minutes, one bowl, and a good amount of protein.',
  1, 5, 3, '{breakfast,snack}', 'mediterranean', array['small frying pan', 'bowl'], 'Makes one bowl.', 'incompatible', 'compatible');
select pg_temp.line(3, 1, 23, 20, 'g', 20, 'roughly chopped');
select pg_temp.line(3, 2, 21, 200, 'g', 200, null, false, 'yogurt', true);
select pg_temp.line(3, 3, 22, 200, 'g', 200, null, false, 'yogurt', false, 'A dairy-free yogurt. Choose maple syrup as well to make the bowl vegan.');
select pg_temp.line(3, 4, 24, 80, 'g', 80);
select pg_temp.line(3, 5, 17, 1, 'tsp', 4);
select pg_temp.line(3, 6, 19, 1, 'tsp', 7, null, false, 'sweetener', true);
select pg_temp.line(3, 7, 18, 1, 'tsp', 7, null, false, 'sweetener', false, 'A plant-based sweetener in place of honey.');
select pg_temp.step(3, 1, 'Toast the walnuts', 'Put the walnuts in a dry pan over medium heat. Shake the pan often until they smell toasty. Tip them out so they stop cooking.', 180);
select pg_temp.step(3, 2, 'Build the bowl', 'Spoon the yogurt into a bowl. Top with the berries, the walnuts and the chia seeds.');
select pg_temp.step(3, 3, 'Finish', 'Drizzle the sweetener over the top and eat straight away.');
select pg_temp.calc(3);

-- 4. Baked eggs in pepper and tomato sauce ------------------------------------
select pg_temp.rec(4, 'Demo baked eggs in pepper and tomato sauce',
  'A smoky pepper and tomato sauce with eggs set gently on top, made in one pan. Good with bread for scooping.',
  2, 10, 20, '{breakfast,dinner}', 'mediterranean', array['deep frying pan with a lid', 'wooden spoon'], 'One serving is half the pan.', 'incompatible', 'compatible');
select pg_temp.line(4, 1, 6, 1, 'tbsp', 14);
select pg_temp.line(4, 2, 2, 1, 'medium', 110, 'thinly sliced');
select pg_temp.line(4, 3, 27, 1, 'large', 150, 'thinly sliced');
select pg_temp.line(4, 4, 7, 2, 'cloves', 6, 'finely chopped');
select pg_temp.line(4, 5, 29, 1, 'tsp', 2.5);
select pg_temp.line(4, 6, 10, 1, 'tsp', 2.5);
select pg_temp.line(4, 7, 28, 400, 'g', 400);
select pg_temp.line(4, 8, 12, 0.5, 'tsp', 3);
select pg_temp.line(4, 9, 25, 4, 'large', 200, null, false, 'protein', true);
select pg_temp.line(4, 10, 26, 240, 'g', 240, 'drained and rinsed', false, 'protein', false, 'White beans in place of the eggs make the dish vegan. Stir them into the sauce and warm through for 5 minutes.');
select pg_temp.line(4, 11, 52, 10, 'g', 10, 'chopped, to finish', true);
select pg_temp.step(4, 1, 'Soften the vegetables', 'Warm the oil in the pan over medium heat. Add the onion and pepper and cook until soft and sweet. Stir now and then.', 420);
select pg_temp.step(4, 2, 'Add garlic and spices', 'Stir in the garlic, smoked paprika and cumin and cook for one minute, until fragrant.', 60);
select pg_temp.step(4, 3, 'Simmer the sauce', 'Pour in the chopped tomatoes and add the salt. Simmer until the sauce thickens enough to hold a dip made with the back of a spoon.', 480);
select pg_temp.step(4, 4, 'Add the eggs or beans', 'If using eggs, make four dips in the sauce and crack an egg into each. Put the lid on and cook until the whites are set and the yolks are as soft as you like. If using beans, stir them in, put the lid on and warm through.', 300);
select pg_temp.step(4, 5, 'Serve', 'Take the pan off the heat. Scatter over the parsley, if using, and bring the pan to the table.');
select pg_temp.calc(4);

-- 5. Chana masala --------------------------------------------------------------
select pg_temp.rec(5, 'Demo chana masala',
  'Chickpeas simmered in a gently spiced onion and tomato gravy. Made from cupboard staples and even better the next day.',
  4, 10, 25, '{dinner,lunch}', 'indian', array['large pot', 'wooden spoon'], 'One serving is a quarter of the pot. Serve with rice or flatbread.', 'compatible', 'compatible');
select pg_temp.line(5, 1, 5, 2, 'tbsp', 28);
select pg_temp.line(5, 2, 2, 2, 'medium', 220, 'finely chopped');
select pg_temp.line(5, 3, 7, 3, 'cloves', 9, 'finely chopped');
select pg_temp.line(5, 4, 8, 15, 'g', 15, 'grated');
select pg_temp.line(5, 5, 11, 2, 'tsp', 5);
select pg_temp.line(5, 6, 10, 1, 'tsp', 2.5);
select pg_temp.line(5, 7, 9, 0.5, 'tsp', 1.5);
select pg_temp.line(5, 8, 28, 400, 'g', 400);
select pg_temp.line(5, 9, 30, 480, 'g', 480, 'drained and rinsed');
select pg_temp.line(5, 10, 53, 200, 'ml', 200);
select pg_temp.line(5, 11, 12, 1, 'tsp', 6);
select pg_temp.line(5, 12, 49, 1, 'tbsp', 15);
select pg_temp.line(5, 13, 54, 15, 'g', 15, 'chopped, to finish', true);
select pg_temp.step(5, 1, 'Brown the onions', 'Warm the oil in the pot over medium heat. Add the onions and cook until deep golden. This is where the flavour comes from, so give it time and stir now and then.', 480);
select pg_temp.step(5, 2, 'Add garlic, ginger and spices', 'Stir in the garlic and ginger and cook for one minute. Add the garam masala, cumin and turmeric and stir for 30 seconds so the spices toast without burning.', 90);
select pg_temp.step(5, 3, 'Make the gravy', 'Add the chopped tomatoes and salt. Cook until the tomatoes darken and the oil starts to show at the edges.', 300);
select pg_temp.step(5, 4, 'Simmer the chickpeas', 'Add the chickpeas and the water. Bring to a gentle bubble, then simmer without a lid until the gravy coats the chickpeas. Crush a few against the side of the pot to thicken it.', 600);
select pg_temp.step(5, 5, 'Finish and serve', 'Stir in the lemon juice. Taste, adjust the salt, and scatter over the coriander, if using.');
select pg_temp.calc(5);

-- 6. Spinach and paneer curry -------------------------------------------------
select pg_temp.rec(6, 'Demo spinach and paneer curry',
  'A bright green spinach sauce with golden cubes of paneer. Tofu and coconut milk are approved swaps if you cook without dairy.',
  3, 15, 20, '{dinner}', 'indian', array['large frying pan', 'blender', 'pot'], 'One serving is a third of the pan. Serve with rice or flatbread.', 'incompatible', 'compatible');
select pg_temp.line(6, 1, 4, 400, 'g', 400, 'washed');
select pg_temp.line(6, 2, 5, 1, 'tbsp', 14);
select pg_temp.line(6, 3, 31, 250, 'g', 250, 'cut into 2 cm cubes', false, 'protein', true);
select pg_temp.line(6, 4, 1, 280, 'g', 280, 'pressed dry and cut into 2 cm cubes', false, 'protein', false, 'Extra-firm tofu in place of paneer. Choose coconut milk as well to make the curry vegan.');
select pg_temp.line(6, 5, 2, 1, 'medium', 110, 'chopped');
select pg_temp.line(6, 6, 7, 3, 'cloves', 9, 'chopped');
select pg_temp.line(6, 7, 8, 10, 'g', 10, 'grated');
select pg_temp.line(6, 8, 3, 1, 'medium', 120, 'chopped');
select pg_temp.line(6, 9, 11, 1.5, 'tsp', 4);
select pg_temp.line(6, 10, 10, 1, 'tsp', 2.5);
select pg_temp.line(6, 11, 12, 0.75, 'tsp', 4);
select pg_temp.line(6, 12, 32, 4, 'tbsp', 60, null, false, 'cream', true);
select pg_temp.line(6, 13, 33, 4, 'tbsp', 60, null, false, 'cream', false, 'Coconut milk in place of cream. It adds a faint sweetness.');
select pg_temp.step(6, 1, 'Blanch the spinach', 'Bring a pot of water to the boil. Push the spinach under for one minute, then drain and rinse under cold water so it stays green. Squeeze out most of the water.', 60);
select pg_temp.step(6, 2, 'Brown the cubes', 'Warm the oil in the frying pan over medium-high heat. Add the paneer or tofu cubes and turn them until golden on most sides. Lift them out onto a plate.', 300);
select pg_temp.step(6, 3, 'Cook the base', 'In the same pan, cook the onion until soft. Add the garlic, ginger and tomato and cook until the tomato collapses. Stir in the garam masala, cumin and salt.', 360);
select pg_temp.step(6, 4, 'Blend', 'Tip the onion mixture and the spinach into the blender. Blend until smooth, adding a splash of water if the blades stick.');
select pg_temp.step(6, 5, 'Simmer together', 'Pour the sauce back into the pan and bring to a gentle simmer. Stir in the cream or coconut milk, then return the cubes to the pan and warm through.', 240);
select pg_temp.step(6, 6, 'Serve', 'Taste and adjust the salt. Serve hot.');
select pg_temp.calc(6);

-- 7. Red lentil dal with spinach ----------------------------------------------
select pg_temp.rec(7, 'Demo red lentil dal with spinach',
  'Soft red lentils finished with sizzling garlic and cumin. Comforting, inexpensive and naturally high in protein.',
  3, 5, 25, '{dinner,lunch}', 'indian', array['medium pot', 'small frying pan', 'whisk or spoon'], 'One serving is a third of the pot. Serve with rice or flatbread.', 'compatible', 'compatible');
select pg_temp.line(7, 1, 34, 240, 'g', 240, 'rinsed until the water runs clear');
select pg_temp.line(7, 2, 53, 900, 'ml', 900);
select pg_temp.line(7, 3, 9, 0.5, 'tsp', 1.5);
select pg_temp.line(7, 4, 12, 1, 'tsp', 6);
select pg_temp.line(7, 5, 3, 1, 'medium', 120, 'chopped');
select pg_temp.line(7, 6, 4, 100, 'g', 100, 'roughly chopped');
select pg_temp.line(7, 7, 5, 1.5, 'tbsp', 21, null, false, 'fat', true);
select pg_temp.line(7, 8, 35, 1.5, 'tbsp', 21, null, false, 'fat', false, 'Ghee gives a richer finish. It is dairy, so the dal is no longer vegan.');
select pg_temp.line(7, 9, 7, 3, 'cloves', 9, 'thinly sliced');
select pg_temp.line(7, 10, 10, 1.5, 'tsp', 4);
select pg_temp.line(7, 11, 49, 1, 'tbsp', 15);
select pg_temp.step(7, 1, 'Simmer the lentils', 'Put the lentils, water and turmeric in the pot. Bring to the boil, skim off any foam, then turn the heat down and simmer until the lentils fall apart. Stir now and then so they do not catch.', 1080);
select pg_temp.step(7, 2, 'Add tomato and spinach', 'Stir in the salt, the tomato and the spinach. Simmer until the spinach is soft. Whisk briefly if you like a smoother dal.', 240);
select pg_temp.step(7, 3, 'Sizzle the garlic and cumin', 'Warm the oil or ghee in the small pan over medium heat. Add the garlic and cook until pale gold, then add the cumin and take the pan off the heat after a few seconds.', 90);
select pg_temp.step(7, 4, 'Finish', 'Pour the hot garlic and cumin over the dal. It will sizzle. Stir in the lemon juice, taste and adjust the salt.');
select pg_temp.calc(7);

-- 8. Sesame tofu and broccoli stir-fry ----------------------------------------
select pg_temp.rec(8, 'Demo sesame tofu and broccoli stir-fry',
  'Crisp-edged tofu and bright broccoli in a glossy soy, ginger and sesame sauce, served over rice.',
  2, 15, 15, '{dinner}', 'asian', array['wok or large frying pan', 'pot with a lid', 'small bowl'], 'One serving is half the pan with half the rice.', 'compatible', 'compatible');
select pg_temp.line(8, 1, 36, 150, 'g', 150, 'rinsed');
select pg_temp.line(8, 2, 1, 400, 'g', 400, 'pressed dry and cut into 2 cm cubes');
select pg_temp.line(8, 3, 41, 1, 'tbsp', 8);
select pg_temp.line(8, 4, 5, 1, 'tbsp', 14);
select pg_temp.line(8, 5, 37, 300, 'g', 300, 'cut into small florets');
select pg_temp.line(8, 6, 7, 2, 'cloves', 6, 'finely chopped');
select pg_temp.line(8, 7, 8, 10, 'g', 10, 'grated');
select pg_temp.line(8, 8, 38, 2, 'tbsp', 30);
select pg_temp.line(8, 9, 18, 1, 'tsp', 7);
select pg_temp.line(8, 10, 39, 1, 'tsp', 4.5);
select pg_temp.line(8, 11, 40, 1, 'tbsp', 9);
select pg_temp.step(8, 1, 'Start the rice', 'Put the rice in the pot with 300 ml of water and a pinch of salt. Bring to the boil, put the lid on, turn the heat to its lowest and cook without lifting the lid.', 720);
select pg_temp.step(8, 2, 'Coat the tofu', 'While the rice cooks, toss the tofu cubes with the cornstarch until lightly coated. Mix the soy sauce and maple syrup with 2 tablespoons of water in the small bowl.');
select pg_temp.step(8, 3, 'Crisp the tofu', 'Heat the oil in the wok over medium-high heat. Add the tofu in one layer and leave it alone for a couple of minutes before turning, so it crisps. Cook until golden on most sides, then lift out.', 420);
select pg_temp.step(8, 4, 'Cook the broccoli', 'Add the broccoli to the wok with a splash of water. Stir-fry until bright green and just tender. Add the garlic and ginger for the last 30 seconds.', 240);
select pg_temp.step(8, 5, 'Bring it together', 'Return the tofu to the wok and pour in the sauce. Toss for a minute until everything is glossy. Take off the heat and stir in the sesame oil.', 60);
select pg_temp.step(8, 6, 'Serve', 'Fluff the rice with a fork. Spoon the stir-fry over it and scatter with the sesame seeds.');
select pg_temp.calc(8);

-- 9. Peanut noodle bowl with edamame ------------------------------------------
select pg_temp.rec(9, 'Demo peanut noodle bowl with edamame',
  'Cool noodles in a creamy peanut and lime sauce with edamame and crunchy vegetables. A fast lunch that travels well.',
  2, 15, 8, '{lunch,dinner}', 'asian', array['pot', 'colander', 'mixing bowl', 'whisk or fork'], 'One serving is one bowl.', 'compatible', 'compatible');
select pg_temp.line(9, 1, 42, 160, 'g', 160, null, false, 'noodles', true);
select pg_temp.line(9, 2, 43, 160, 'g', 160, null, false, 'noodles', false, 'Egg noodles contain egg, so the bowl is no longer vegan or egg-free.');
select pg_temp.line(9, 3, 44, 300, 'g', 300, null, false, 'noodles', false, 'Fresh noodles sometimes contain egg and this has not been confirmed. Check the label before relying on it.');
select pg_temp.line(9, 4, 45, 200, 'g', 200);
select pg_temp.line(9, 5, 16, 3, 'tbsp', 48);
select pg_temp.line(9, 6, 38, 1.5, 'tbsp', 22);
select pg_temp.line(9, 7, 48, 1, 'tbsp', 15);
select pg_temp.line(9, 8, 18, 1, 'tsp', 7);
select pg_temp.line(9, 9, 39, 1, 'tsp', 4.5);
select pg_temp.line(9, 10, 53, 3, 'tbsp', 45, 'warm');
select pg_temp.line(9, 11, 46, 1, 'medium', 80, 'shredded');
select pg_temp.line(9, 12, 47, 100, 'g', 100, 'cut into thin sticks');
select pg_temp.step(9, 1, 'Cook the noodles and edamame', 'Bring a pot of water to the boil. Cook the noodles for the time on the packet, adding the edamame for the last 2 minutes.', 360);
select pg_temp.step(9, 2, 'Cool', 'Drain the noodles and edamame and rinse under cold water until cool. Shake off as much water as you can.');
select pg_temp.step(9, 3, 'Whisk the sauce', 'In the mixing bowl, whisk the peanut butter, soy sauce, lime juice, maple syrup, sesame oil and warm water until smooth and pourable.');
select pg_temp.step(9, 4, 'Toss and serve', 'Add the noodles, edamame, carrot and cucumber to the bowl and toss until everything is coated. Divide between two bowls.');
select pg_temp.calc(9);

-- 10. Chickpea and quinoa bowl ------------------------------------------------
select pg_temp.rec(10, 'Demo chickpea and quinoa bowl with lemon tahini',
  'Fluffy quinoa, chickpeas and a crisp tomato and cucumber salad under a lemony tahini dressing.',
  2, 15, 15, '{lunch}', 'mediterranean', array['small pot with a lid', 'mixing bowl', 'small bowl'], 'One serving is one bowl.', 'compatible', 'compatible');
select pg_temp.line(10, 1, 50, 120, 'g', 120, 'rinsed well');
select pg_temp.line(10, 2, 53, 240, 'ml', 240);
select pg_temp.line(10, 3, 30, 240, 'g', 240, 'drained and rinsed');
select pg_temp.line(10, 4, 3, 2, 'medium', 240, 'diced');
select pg_temp.line(10, 5, 47, 150, 'g', 150, 'diced');
select pg_temp.line(10, 6, 52, 20, 'g', 20, 'chopped');
select pg_temp.line(10, 7, 51, 2, 'tbsp', 30);
select pg_temp.line(10, 8, 49, 2, 'tbsp', 30);
select pg_temp.line(10, 9, 6, 1, 'tbsp', 14);
select pg_temp.line(10, 10, 7, 1, 'clove', 3, 'finely grated');
select pg_temp.line(10, 11, 12, 0.5, 'tsp', 3);
select pg_temp.step(10, 1, 'Cook the quinoa', 'Put the quinoa and water in the pot with a pinch of the salt. Bring to the boil, put the lid on, turn the heat down low and cook until the water is absorbed.', 720);
select pg_temp.step(10, 2, 'Rest', 'Take the pot off the heat and leave it covered. This finishes the quinoa and keeps it fluffy.', 300);
select pg_temp.step(10, 3, 'Make the dressing', 'In the small bowl, stir the tahini, lemon juice, olive oil, garlic and the rest of the salt. Add water a spoonful at a time until it pours like cream.');
select pg_temp.step(10, 4, 'Assemble', 'Fluff the quinoa with a fork and divide between two bowls. Top with the chickpeas, tomato, cucumber and parsley, then spoon over the dressing.');
select pg_temp.calc(10);

-- 11. Crispy spiced chickpeas -------------------------------------------------
select pg_temp.rec(11, 'Demo crispy spiced chickpeas',
  'Chickpeas roasted until they rattle, with smoked paprika and cumin. A crunchy snack or a topping for soups and salads.',
  4, 5, 25, '{snack}', 'everyday', array['oven', 'baking tray', 'clean tea towel'], 'One serving is a small handful, a quarter of the tray.', 'compatible', 'compatible');
select pg_temp.line(11, 1, 30, 480, 'g', 480, 'drained and rinsed');
select pg_temp.line(11, 2, 6, 1, 'tbsp', 14);
select pg_temp.line(11, 3, 29, 1, 'tsp', 2.5);
select pg_temp.line(11, 4, 10, 1, 'tsp', 2.5);
select pg_temp.line(11, 5, 12, 0.5, 'tsp', 3);
select pg_temp.step(11, 1, 'Heat the oven', 'Heat the oven to 200°C (400°F). Rub the chickpeas dry in the tea towel. The drier they are, the crisper they get.');
select pg_temp.step(11, 2, 'Season', 'Tip the chickpeas onto the tray. Add the olive oil, smoked paprika, cumin and salt, and roll them around until evenly coated. Spread into one layer.');
select pg_temp.step(11, 3, 'Roast', 'Roast until deep golden and crisp, shaking the tray halfway through.', 1500);
select pg_temp.step(11, 4, 'Cool', 'Leave on the tray for 5 minutes. They crisp up further as they cool.', 300);
select pg_temp.calc(11);

-- The lentil soup above joins the library as the twelfth recipe. Its stock has no
-- carbohydrate, fat or fiber figure, so those stay unknown for the soup on purpose.
update public.recipe_revisions set meal_types = '{lunch,dinner}', cuisine = 'everyday',
       serving_note = 'One serving is one bowl, a quarter of the pot.'
 where food_revision_id = '00000000-0000-4000-8000-000000001411';
update public.recipe_steps set title = t.title
  from (values (1, 'Rinse'), (2, 'Simmer'), (3, 'Season and serve')) as t(ordinal, title)
 where recipe_revision_id = '00000000-0000-4000-8000-000000001411' and recipe_steps.ordinal = t.ordinal;
select pg_temp.calc_rev('00000000-0000-4000-8000-000000001411');

-- Publish every demo revision (seed runs as the database owner, outside the member-facing gate).
update public.food_revisions set published_at = now() where published_at is null;
update public.food_items fi
   set current_revision_id = r.id, status = 'published'
  from public.food_revisions r
 where r.food_item_id = fi.id and fi.is_demo;

-- ---------------------------------------------------------------------------
-- M5 demo social content: four invented accounts with invented reviews, a ranking,
-- lists and one editorial collection. LOCAL TESTING ONLY.
--   * Every account is flagged member_standing.is_demo = true. Demo accounts and all
--     their content are hidden, and never counted in any rating, unless demo content
--     is switched on (ALLOW_DEMO_CONTENT, local development only).
--   * Names, handles and texts say "demo" so nobody can mistake them for real people.
--   * The accounts have no password and no sign-in identity: nobody can log in as them.
-- Fixed ids: account 5100NN, list 5200NN.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('00000000-0000-4000-8000-0000005100' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'demo-account-' || n || '@example.invalid', '{}', '{"demo": true}', now(), now()
  from unnest(array['01', '02', '03', '04']) as n;

insert into public.profiles_public (user_id, handle, display_name, bio, taste_tags, discoverable, show_tastes, show_diet) values
  ('00000000-0000-4000-8000-000000510001', 'demo_maya', 'Maya (demo account)', 'Invented profile for local testing. Likes tofu and anything with peanuts.', '{tofu,peanut,spicy}', true, true, false),
  ('00000000-0000-4000-8000-000000510002', 'demo_arjun', 'Arjun (demo account)', 'Invented profile for local testing. Always looking for a good dosa.', '{south indian,breakfast}', true, true, false),
  ('00000000-0000-4000-8000-000000510003', 'demo_lena', 'Lena (demo account)', 'Invented profile for local testing.', '{}', true, false, false),
  ('00000000-0000-4000-8000-000000510004', 'demo_editorial', 'Editorial team (demo)', 'Invented team account that holds the demo editorial collections.', '{}', false, false, false);

-- Local testing only: let signed-out visitors read approved public social pages, so
-- the guest journeys can be tested. The migration leaves this switch off, and this
-- seed file is never run against a hosted database.
update app.platform_switches set enabled = true, updated_at = now() where name = 'social_public';

insert into public.member_standing (user_id, first_public_approved_at, is_demo)
select ('00000000-0000-4000-8000-0000005100' || n)::uuid, now(), true from unnest(array['01', '02', '03', '04']) as n;
insert into public.role_assignments (user_id, role) values ('00000000-0000-4000-8000-000000510004', 'publisher');

insert into public.follows (follower_id, followed_id) values
  ('00000000-0000-4000-8000-000000510001', '00000000-0000-4000-8000-000000510002'),
  ('00000000-0000-4000-8000-000000510003', '00000000-0000-4000-8000-000000510001');

-- Reviews: restaurants and dishes are rated separately.
insert into public.reviews (author_id, venue_id, food_item_id, rating, body, visit_date, audience, publication_state, published_at) values
  ('00000000-0000-4000-8000-000000510001', '00000000-0000-4000-8000-00000000c004', null, 5, 'Demo review: quick, friendly, and the tofu is made in house.', current_date - 12, 'public', 'visible', now() - interval '6 days'),
  ('00000000-0000-4000-8000-000000510001', null, '00000000-0000-4000-8000-000000001501', 5, 'Demo review: the stew arrives bubbling. Ask for it without the egg.', current_date - 12, 'public', 'visible', now() - interval '6 days'),
  ('00000000-0000-4000-8000-000000510001', null, '00000000-0000-4000-8000-000000001901', 4, 'Demo review: filling, and the tempeh is properly crisp.', current_date - 20, 'public', 'visible', now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000510001', '00000000-0000-4000-8000-00000000c005', null, 4, 'Demo review: small room, short wait, good chutneys.', current_date - 30, 'public', 'visible', now() - interval '2 days'),
  ('00000000-0000-4000-8000-000000510002', '00000000-0000-4000-8000-00000000c005', null, 5, 'Demo review: my regular breakfast stop.', current_date - 5, 'public', 'visible', now() - interval '4 days'),
  ('00000000-0000-4000-8000-000000510002', null, '00000000-0000-4000-8000-000000001701', 5, 'Demo review: crisp all the way to the edge.', current_date - 5, 'public', 'visible', now() - interval '4 days'),
  ('00000000-0000-4000-8000-000000510002', null, '00000000-0000-4000-8000-000000001801', 4, 'Demo review: soft idli, sambar on the mild side.', current_date - 9, 'public', 'visible', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000510002', '00000000-0000-4000-8000-00000000c004', null, 3, 'Demo review: good food, but loud at peak time.', current_date - 40, 'public', 'visible', now() - interval '8 days'),
  ('00000000-0000-4000-8000-000000510003', null, '00000000-0000-4000-8000-000000001601', 4, 'Demo review: generous vegetables. Comes with an egg unless you ask.', current_date - 3, 'public', 'visible', now() - interval '5 hours'),
  ('00000000-0000-4000-8000-000000510003', null, '00000000-0000-4000-8000-000000002001', 2, 'Demo review: too sweet for me.', current_date - 15, 'public', 'visible', now() - interval '7 days'),
  ('00000000-0000-4000-8000-000000510003', '00000000-0000-4000-8000-00000000c003', null, 4, 'Demo review: calm spot for a long lunch.', current_date - 18, 'public', 'visible', now() - interval '9 days');
insert into public.review_revisions (review_id, revision_no, rating, body, visit_date, audience)
select r.id, 1, r.rating, r.body, r.visit_date, r.audience from public.reviews r
 where r.author_id::text like '00000000-0000-4000-8000-0000005100%';

-- One published ranking (a fixed copy of the private order).
insert into public.ranking_entries (owner_id, venue_id, position) values
  ('00000000-0000-4000-8000-000000510001', '00000000-0000-4000-8000-00000000c004', 1),
  ('00000000-0000-4000-8000-000000510001', '00000000-0000-4000-8000-00000000c005', 2);
insert into public.ranking_publications (owner_id, snapshot, publication_state, published_at) values
  ('00000000-0000-4000-8000-000000510001', '["00000000-0000-4000-8000-00000000c004", "00000000-0000-4000-8000-00000000c005"]', 'visible', now() - interval '2 days');

-- Lists: one personal, two editorial collections.
insert into public.food_lists (id, owner_id, title, description, visibility, publication_state, is_editorial, published_at) values
  ('00000000-0000-4000-8000-000000520001', '00000000-0000-4000-8000-000000510002', 'Demo list: breakfast worth getting up for', 'Invented list for local testing.', 'public', 'visible', false, now() - interval '3 days'),
  ('00000000-0000-4000-8000-000000520002', '00000000-0000-4000-8000-000000510004', 'Demo collection: high-protein lunches', 'An invented editorial collection for local testing. Dishes and recipes with 20 g of protein or more.', 'public', 'visible', true, now() - interval '5 days'),
  ('00000000-0000-4000-8000-000000520003', '00000000-0000-4000-8000-000000510004', 'Demo collection: cook it this week', 'An invented editorial collection for local testing. Recipes from the demo library.', 'public', 'visible', true, now() - interval '4 days');
insert into public.food_list_items (list_id, venue_id, food_item_id, position, note) values
  ('00000000-0000-4000-8000-000000520001', null, '00000000-0000-4000-8000-000000001701', 1, 'Demo note: get there before 9.'),
  ('00000000-0000-4000-8000-000000520001', null, '00000000-0000-4000-8000-000000001801', 2, null),
  ('00000000-0000-4000-8000-000000520001', '00000000-0000-4000-8000-00000000c005', null, 3, null),
  ('00000000-0000-4000-8000-000000520002', null, '00000000-0000-4000-8000-000000000201', 1, null),
  ('00000000-0000-4000-8000-000000520002', null, '00000000-0000-4000-8000-000000001501', 2, null),
  ('00000000-0000-4000-8000-000000520002', null, '00000000-0000-4000-8000-000000001901', 3, null),
  ('00000000-0000-4000-8000-000000520002', null, '00000000-0000-4000-8000-000000001601', 4, null),
  ('00000000-0000-4000-8000-000000520003', null, '00000000-0000-4000-8000-000000430001', 1, null),
  ('00000000-0000-4000-8000-000000520003', null, '00000000-0000-4000-8000-000000430005', 2, null),
  ('00000000-0000-4000-8000-000000520003', null, '00000000-0000-4000-8000-000000430007', 3, null),
  ('00000000-0000-4000-8000-000000520003', null, '00000000-0000-4000-8000-000000430004', 4, null);

-- Local testing only (R1): register the digest of the fixed local rate-limit key that
-- scripts/write-local-env.mjs writes to .env.local. A hosted database gets its own
-- random secret through the deployment runbook and never runs this seed file.
select app.register_server_key('rate_limit', encode(sha256(convert_to('local-development-only-rate-limit-key-0000', 'UTF8')), 'hex'));

-- MAP-2: invented opening hours for the demo places, published as if checked by two editors
-- (seed runs as the database owner). Demo Allston Dosa Corner deliberately has none, so
-- "Hours need confirmation" can be seen. Patterns are shared with tests/map/seed-map-demo.sql.
create function pg_temp.demo_hours(p_pattern text) returns jsonb language sql immutable as $$
  select case p_pattern
    when 'all_day' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', case when d = 0 then '12:00' else '11:00' end,
                                           'closes', case when d = 0 then '21:00' else '22:00' end)) from generate_series(0, 6) d))
    when 'split' then jsonb_build_object('weekly',
      (select jsonb_agg(x) from generate_series(0, 6) d,
              lateral (values (jsonb_build_object('day', d, 'opens', '11:30', 'closes', '14:30')),
                              (jsonb_build_object('day', d, 'opens', '17:00', 'closes', '22:00'))) v(x) where d <> 1))
    when 'late' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', '17:00', 'closes', '02:00', 'closesNextDay', true)) from generate_series(0, 6) d))
    when 'breakfast' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', '07:00', 'closes', '15:00')) from generate_series(0, 6) d))
    when 'always' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', '00:00', 'closes', '00:00', 'closesNextDay', true)) from generate_series(0, 6) d))
  end;
$$;
select app.publish_hours('00000000-0000-4000-8000-00000000c001', pg_temp.demo_hours('all_day'), '00000000-0000-4000-8000-00000000b201', null, null, null);
select app.publish_hours('00000000-0000-4000-8000-00000000c002', pg_temp.demo_hours('late'), '00000000-0000-4000-8000-00000000b201', null, null, null);
select app.publish_hours('00000000-0000-4000-8000-00000000c003',
  pg_temp.demo_hours('breakfast') || jsonb_build_object('exceptions', jsonb_build_array(
    jsonb_build_object('startsOn', '2026-11-26', 'kind', 'closed', 'reason', 'Thanksgiving (demo)'),
    jsonb_build_object('startsOn', '2026-12-24', 'kind', 'special_hours', 'opens', '07:00', 'closes', '12:00', 'reason', 'Christmas Eve (demo)'))),
  '00000000-0000-4000-8000-00000000b201', null, null, null);
select app.publish_hours('00000000-0000-4000-8000-00000000c004', pg_temp.demo_hours('split'), '00000000-0000-4000-8000-00000000b201', null, null, null);
