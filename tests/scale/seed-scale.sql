-- Scale-test data for R1 acceptance test 7. LOCAL DATABASE ONLY (the runner refuses anything else).
-- Everything here is invented and marked is_demo = true. It is made by copying the existing
-- demo places and dishes many times with new ids, moved to random points around the demo
-- market, and by creating invented members who review them. Run `supabase db reset` afterwards.
--
-- Result: about 400 places, 2,000 dishes, 500 members, 20,000 public reviews, 5,000 follows.
\set ON_ERROR_STOP on
begin;
-- Copies are inserted already published, so the guards that protect published rows from edits
-- are switched off for this session only.
set local session_replication_role = replica;

create function pg_temp.m(p_id uuid, p_n integer) returns uuid language sql immutable as $$
  -- Shaped like an ordinary random id (version 4), because the app refuses addresses that are not.
  select (substr(h, 1, 12) || '4' || substr(h, 14, 3) || '8' || substr(h, 18))::uuid from (select md5(p_id::text || ':' || p_n::text) as h) x;
$$;

-- 5 demo places x 80 copies = 400 places, scattered within roughly 8 km.
insert into public.venues (id, market_id, slug, name, neighborhood, street, locality, region, postal_code, location, timezone, venue_type, status, is_demo, reviewed_at, created_at, cuisines, price_band)
select pg_temp.m(v.id, n), v.market_id, v.slug || '-scale-' || n, 'Scale test place ' || n || ' (' || v.name || ')', v.neighborhood, v.street, v.locality, v.region, v.postal_code,
       extensions.st_setsrid(extensions.st_makepoint(
         extensions.st_x(v.location::extensions.geometry) + (random() - 0.5) * 0.16,
         extensions.st_y(v.location::extensions.geometry) + (random() - 0.5) * 0.12), 4326)::extensions.geography,
       v.timezone, v.venue_type, v.status, true, v.reviewed_at, v.created_at, v.cuisines, v.price_band
  from public.venues v cross join generate_series(1, 80) n
 where v.is_demo and v.slug not like '%-scale-%';

-- 13 demo dishes x 154 copies = 2,002 dishes, each with its numbers, dietary claims and ingredient statements.
create temporary table scale_dish on commit drop as
select fi.id as item, fi.current_revision_id as rev, d.venue_id as venue, n,
       pg_temp.m(fi.id, n) as new_item, pg_temp.m(fi.current_revision_id, n) as new_rev, pg_temp.m(d.venue_id, ((n - 1) % 80) + 1) as new_venue
  from public.food_items fi join public.dishes d on d.food_item_id = fi.id cross join generate_series(1, 154) n
 where fi.is_demo and fi.kind = 'dish' and fi.status = 'published';

insert into public.food_items (id, kind, owner_id, visibility, current_revision_id, status, is_demo, version, created_at)
select s.new_item, fi.kind, null, fi.visibility, s.new_rev, fi.status, true, 1, fi.created_at from scale_dish s join public.food_items fi on fi.id = s.item;
insert into public.food_revisions (id, food_item_id, revision_no, name, description, preparation_state, brand, gtin, basis_kind, basis_amount, basis_unit, created_at, published_at)
select s.new_rev, s.new_item, 1, r.name || ' (scale ' || s.n || ')', r.description, r.preparation_state, r.brand, null, r.basis_kind, r.basis_amount, r.basis_unit, r.created_at, r.published_at
  from scale_dish s join public.food_revisions r on r.id = s.rev;
insert into public.dishes (food_item_id, venue_id, menu_section, availability_status)
select s.new_item, s.new_venue, d.menu_section, d.availability_status from scale_dish s join public.dishes d on d.food_item_id = s.item;
insert into public.portions (id, revision_id, label, amount, unit, grams, milliliters, source_record_id)
select pg_temp.m(p.id, s.n), s.new_rev, p.label, p.amount, p.unit, p.grams, p.milliliters, p.source_record_id from scale_dish s join public.portions p on p.revision_id = s.rev;
insert into public.nutrient_values (revision_id, nutrient_code, value, lower_value, upper_value, source_record_id, method, missing_reason, assumptions)
select s.new_rev, v.nutrient_code, v.value, v.lower_value, v.upper_value, v.source_record_id, v.method, v.missing_reason, v.assumptions from scale_dish s join public.nutrient_values v on v.revision_id = s.rev;
insert into public.dietary_claims (id, revision_id, diet, outcome, evidence_tier, source_record_id, modifications, checked_at, expires_at, conflict_state)
select pg_temp.m(c.id, s.n), s.new_rev, c.diet, c.outcome, c.evidence_tier, c.source_record_id, c.modifications, c.checked_at, c.expires_at, c.conflict_state from scale_dish s join public.dietary_claims c on c.revision_id = s.rev;
insert into public.ingredient_family_statements (id, revision_id, family, presence, source_record_id, detail, checked_at, expires_at)
select pg_temp.m(f.id, s.n), s.new_rev, f.family, f.presence, f.source_record_id, f.detail, f.checked_at, f.expires_at from scale_dish s join public.ingredient_family_statements f on f.revision_id = s.rev;
insert into public.dish_prices (id, dish_id, amount_minor, currency, serving_description, checked_at, source_record_id)
select pg_temp.m(p.id, s.n), s.new_item, p.amount_minor, p.currency, p.serving_description, p.checked_at, p.source_record_id from scale_dish s join public.dish_prices p on p.dish_id = s.item;

-- 500 invented members with public profiles, already past first-post approval.
create temporary table scale_member on commit drop as
select n, pg_temp.m('00000000-0000-4000-8000-0000005ca1e0'::uuid, n) as id from generate_series(1, 500) n;
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'scale-' || n || '@example.test', '{}', '{}', now(), now() from scale_member;
insert into public.profiles_public (user_id, handle, display_name, bio, taste_tags, discoverable, show_tastes, show_diet)
select id, 'scale_member_' || n, 'Scale member ' || n || ' (invented)', 'Invented profile for the scale test.', '{}', true, false, false from scale_member;
insert into public.member_standing (user_id, first_public_approved_at, is_demo) select id, now(), true from scale_member;

-- 20,000 public reviews: each member reviews 20 places and 20 dishes.
insert into public.reviews (author_id, venue_id, rating, body, audience, publication_state, published_at, created_at)
select m.id, pg_temp.m(v.id, ((m.n * 7 + k) % 80) + 1), 1 + ((m.n + k) % 5), 'Invented scale-test review ' || k, 'public', 'visible', now() - (k || ' hours')::interval, now() - (k || ' hours')::interval
  from scale_member m cross join generate_series(1, 20) k
  join lateral (select id from public.venues where is_demo and slug not like '%-scale-%' order by id offset (k % 5) limit 1) v on true;
insert into public.reviews (author_id, food_item_id, rating, body, audience, publication_state, published_at, created_at)
select m.id, pg_temp.m(d.item, ((m.n * 11 + k * 7) % 154) + 1), 1 + ((m.n + 2 * k) % 5), 'Invented scale-test dish review ' || k, 'public', 'visible', now() - (k || ' hours')::interval, now() - (k || ' hours')::interval
  from scale_member m cross join generate_series(1, 20) k
  join lateral (select distinct item from scale_dish order by item offset (k % 13) limit 1) d on true;

-- Each member follows 10 others.
insert into public.follows (follower_id, followed_id)
select m.id, f.id from scale_member m cross join generate_series(1, 10) k join scale_member f on f.n = ((m.n + k * 37 - 1) % 500) + 1 where f.id <> m.id
on conflict do nothing;
commit;
analyze public.venues, public.food_items, public.food_revisions, public.dishes, public.reviews, public.follows, public.profiles_public, public.nutrient_values, public.dietary_claims, public.ingredient_family_statements;
