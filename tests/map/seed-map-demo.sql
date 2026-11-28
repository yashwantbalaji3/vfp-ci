-- MAP-1 demo places for looking at the map. LOCAL DATABASE ONLY (scripts/map-demo.mjs refuses anything else).
-- Everything here is invented and marked is_demo = true: 58 made-up places, two near each approximate
-- neighbourhood or square centre in public.geo_areas, each with 3 dishes copied from the ordinary demo
-- dishes (so their dietary evidence, protein numbers and sources are the same invented records).
-- Addresses are "Example Street". Nothing here is a real restaurant. Run `supabase db reset` to remove it.
\set ON_ERROR_STOP on
begin;
-- Copies are inserted already published, so the guards that protect published rows are off for this session only.
set local session_replication_role = replica;

create function pg_temp.m(p_id uuid, p_n integer) returns uuid language sql immutable as $$
  select (substr(h, 1, 12) || '4' || substr(h, 14, 3) || '8' || substr(h, 18))::uuid from (select md5('map-demo:' || p_id::text || ':' || p_n::text) as h) x;
$$;

create temporary table md_src_venue on commit drop as
select row_number() over (order by id) - 1 as k, * from public.venues where is_demo and slug not like '%-scale-%' and slug not like 'map-demo-%';

create temporary table md_place on commit drop as
select row_number() over (order by a.slug, j) as n, a.slug as area_slug, a.name as area_name, a.context as city, j,
       extensions.st_x(a.center::extensions.geometry) + (case j when 1 then 0.0021 else -0.0017 end) as lon,
       extensions.st_y(a.center::extensions.geometry) + (case j when 1 then 0.0012 else -0.0014 end) as lat
  from public.geo_areas a cross join generate_series(1, 2) j
 where a.kind = 'neighborhood';

create temporary table md_venue on commit drop as
select p.*, pg_temp.m(s.id, p.n::int) as id, s.id as src, s.market_id, s.cuisines, s.price_band, s.venue_type, s.timezone, s.region,
       'map-demo-' || p.area_slug || '-' || p.j as slug,
       'Demo ' || p.area_name || ' ' || (array['Green Table', 'Lentil House', 'Tofu Bar', 'Grain Bowl', 'Garden Counter', 'Bean Kitchen', 'Noodle Room'])[1 + (p.n::int % 7)] as name
  from md_place p join md_src_venue s on s.k = p.n % (select count(*) from md_src_venue);

insert into public.venues (id, market_id, slug, name, neighborhood, street, locality, region, location, timezone, venue_type, status, is_demo, reviewed_at, cuisines, price_band)
select id, market_id, slug, name, area_name, (10 + n) || ' Example Street (invented)', city, region,
       extensions.st_setsrid(extensions.st_makepoint(lon, lat), 4326)::extensions.geography, timezone, venue_type, 'published', true, now(), cuisines, price_band
  from md_venue;

create temporary table md_src_dish on commit drop as
select row_number() over (order by fi.id) - 1 as k, fi.id as item, fi.current_revision_id as rev, d.venue_id
  from public.food_items fi join public.dishes d on d.food_item_id = fi.id join public.venues v on v.id = d.venue_id
 where fi.is_demo and fi.kind = 'dish' and fi.status = 'published' and v.slug not like '%-scale-%' and v.slug not like 'map-demo-%';

create temporary table md_dish on commit drop as
select v.id as new_venue, v.n, t, s.item, s.rev,
       pg_temp.m(s.item, (v.n * 10 + t)::int) as new_item, pg_temp.m(s.rev, (v.n * 10 + t)::int) as new_rev
  from md_venue v cross join generate_series(0, 2) t
  join md_src_dish s on s.k = (v.n * 3 + t) % (select count(*) from md_src_dish);

insert into public.food_items (id, kind, owner_id, visibility, current_revision_id, status, is_demo, version, created_at)
select s.new_item, fi.kind, null, fi.visibility, s.new_rev, fi.status, true, 1, fi.created_at from md_dish s join public.food_items fi on fi.id = s.item;
insert into public.food_revisions (id, food_item_id, revision_no, name, description, preparation_state, brand, gtin, basis_kind, basis_amount, basis_unit, created_at, published_at)
select s.new_rev, s.new_item, 1, r.name, r.description, r.preparation_state, r.brand, null, r.basis_kind, r.basis_amount, r.basis_unit, r.created_at, r.published_at
  from md_dish s join public.food_revisions r on r.id = s.rev;
insert into public.dishes (food_item_id, venue_id, menu_section, availability_status)
select s.new_item, s.new_venue, d.menu_section, d.availability_status from md_dish s join public.dishes d on d.food_item_id = s.item;
insert into public.portions (id, revision_id, label, amount, unit, grams, milliliters, source_record_id)
select pg_temp.m(p.id, (s.n * 10 + s.t)::int), s.new_rev, p.label, p.amount, p.unit, p.grams, p.milliliters, p.source_record_id from md_dish s join public.portions p on p.revision_id = s.rev;
insert into public.nutrient_values (revision_id, nutrient_code, value, lower_value, upper_value, source_record_id, method, missing_reason, assumptions)
select s.new_rev, v.nutrient_code, v.value, v.lower_value, v.upper_value, v.source_record_id, v.method, v.missing_reason, v.assumptions from md_dish s join public.nutrient_values v on v.revision_id = s.rev;
insert into public.dietary_claims (id, revision_id, diet, outcome, evidence_tier, source_record_id, modifications, checked_at, expires_at, conflict_state)
select pg_temp.m(c.id, (s.n * 10 + s.t)::int), s.new_rev, c.diet, c.outcome, c.evidence_tier, c.source_record_id, c.modifications, c.checked_at, c.expires_at, c.conflict_state from md_dish s join public.dietary_claims c on c.revision_id = s.rev;
insert into public.ingredient_family_statements (id, revision_id, family, presence, source_record_id, detail, checked_at, expires_at)
select pg_temp.m(f.id, (s.n * 10 + s.t)::int), s.new_rev, f.family, f.presence, f.source_record_id, f.detail, f.checked_at, f.expires_at from md_dish s join public.ingredient_family_statements f on f.revision_id = s.rev;
insert into public.dish_prices (id, dish_id, amount_minor, currency, serving_description, checked_at, source_record_id)
select pg_temp.m(p.id, (s.n * 10 + s.t)::int), s.new_item, p.amount_minor, p.currency, p.serving_description, p.checked_at, p.source_record_id from md_dish s join public.dish_prices p on p.dish_id = s.item;
commit;
analyze public.venues, public.food_items, public.food_revisions, public.dishes;
select count(*) as demo_places_added from public.venues where slug like 'map-demo-%';
