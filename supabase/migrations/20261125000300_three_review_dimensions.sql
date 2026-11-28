-- Three separate review dimensions (owner decision 25 Nov 2026 14:25 UTC):
--   1. Founder source review: the founder compared a fact with the restaurant's original evidence and confirmed the
--      database says what the source says. Recorded per fact in staging.fact_confirmations (level 'transcription'),
--      as before, or as status 'verified' on a cleared source. Nothing new is stored and no record is rewritten.
--   2. Dietary verification: a claim is supported by an explicit restaurant-published statement that the founder
--      source-reviewed, or by a current documented staff confirmation (docs/89). Unknowns and conflicts stay open.
--   3. Nutrition verification: restaurant-published figures and labelled estimates stay distinct; reviewing an
--      estimate never makes it a measurement (staging.single_published_value already refuses 'verified' for one).
-- Dimensions 2 and 3 are derived on read (src/contracts/review-queue.ts), never stored, so no historical record
-- changes meaning.
--
-- What changes here, and why:
--   * staging.fact_found_ok(f): the evidence rule that used to be staging.member_fact_ok (source private-pilot or
--     cleared, text found on the saved page or verified). Unchanged logic, new name.
--   * staging.fact_reviewed(f): the founder source-reviewed this fact (transcription confirmation or verified).
--   * staging.member_fact_ok(f): unchanged rule, now written as fact_found_ok. Deliberately NOT narrowed to reviewed
--     facts: hiding an unreviewed ingredient list or allergen statement would hide a warning (for example "egg" from
--     a strict egg-free member). Members keep seeing every fact found on the saved page, labelled as not verified.
--   * staging.tester_meal_checks: evidence checks now use fact_found_ok (so they no longer depend on the mode), and
--     one new check, 'reviewed': the menu item, a price and the restaurant's diet label the meal is stated under
--     were each source-reviewed by the founder. 'reviewedDiets' lists the claims that passed.
--   * staging.tester_meal_all_pass: also requires 'reviewed'. An earlier "include" decision whose meal was not
--     source-reviewed stops counting as included until it is (stricter; decisions themselves are kept as written).
-- Switches, enrolment and publication are not touched.
--
-- Rollback: restore staging.member_fact_ok and staging.tester_meal_checks / tester_meal_all_pass from
-- 20261122000600 and 20261123000200 (create or replace with those bodies), then drop staging.fact_found_ok and
-- staging.fact_reviewed.

create function staging.fact_found_ok(f staging.facts)
returns boolean language sql stable security definer set search_path = '' as $$
  select f.status in ('submitted', 'verified')
     and not f.is_unknown
     and f.kind in ('menu_item', 'price', 'dietary_status', 'listed_ingredients', 'allergen_statement', 'published_nutrition', 'serving_size')
     and staging.source_access_state((select p.url from staging.source_pages p where p.id = f.source_page_id)) in ('private_pilot', 'cleared')
     and not exists (select 1 from staging.source_pages p where p.id = f.source_page_id and p.is_demo)
     and (f.status = 'verified' or (select mc.result from staging.current_machine_check(f.id) mc where mc.id is not null) = 'found');
$$;
revoke all on function staging.fact_found_ok(staging.facts) from public, anon, authenticated;

create function staging.fact_reviewed(f staging.facts)
returns boolean language sql stable security definer set search_path = '' as $$
  select f.status = 'verified'
      or exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription');
$$;
revoke all on function staging.fact_reviewed(staging.facts) from public, anon, authenticated;

create or replace function staging.member_fact_ok(f staging.facts)
returns boolean language sql stable security definer set search_path = '' as $$
  select staging.fact_found_ok(f);
$$;
revoke all on function staging.member_fact_ok(staging.facts) from public, anon, authenticated;

create or replace function staging.tester_meal_checks(p_dish uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select * from staging.dishes where id = p_dish),
  ok as (
    select f.*, staging.fact_reviewed(f) as reviewed
      from staging.facts f where f.dish_id = p_dish and f.status in ('submitted', 'verified') and staging.fact_found_ok(f)
  ),
  item as (select max(checked_on) as checked_on from ok where kind = 'menu_item'),
  diets as (
    select subject,
           bool_or(value ->> 'status' = 'yes') filter (where id in (select id from ok)) as yes,
           bool_or(value ->> 'status' = 'yes') filter (where id in (select id from ok where reviewed)) as yes_reviewed,
           bool_or(value ->> 'status' = 'no') as no
      from staging.facts
     where dish_id = p_dish and kind = 'dietary_status' and status in ('submitted', 'verified') and not is_unknown
       and subject in ('vegetarian', 'vegan')
     group by subject
  )
  select jsonb_build_object(
    'meal', coalesce((select st.dish_type = 'complete_meal' from staging.current_structure(p_dish) st), false),
    'rights', exists (select 1 from ok where kind = 'menu_item'),
    'stated', exists (select 1 from diets where yes and not coalesce(no, false)),
    'statedDiets', coalesce((select jsonb_agg(subject order by subject) from diets where yes and not coalesce(no, false)), '[]'::jsonb),
    'place', exists (
      select 1 from d
        join staging.member_beta_places b on b.place_id = d.place_id
        join staging.live_catalog_links l on l.staging_place = d.place_id
        join public.place_listings pl on pl.candidate_id = l.candidate_id and pl.visibility = 'preview'),
    'fresh', coalesce((select checked_on >= (now() at time zone 'America/New_York')::date - 120 from item), false),
    'price', exists (select 1 from ok where kind = 'price'),
    'open', not exists (
      select 1 from staging.facts f, d
       where f.place_id = d.place_id and f.dish_id is null and f.kind = 'operating_status'
         and f.status in ('submitted', 'verified') and not f.is_unknown
         and f.value ->> 'status' in ('closed', 'permanently_closed', 'temporarily_closed')),
    'reviewed', exists (select 1 from ok where kind = 'menu_item' and reviewed)
            and exists (select 1 from ok where kind = 'price' and reviewed)
            and exists (select 1 from diets where yes_reviewed and not coalesce(no, false)),
    'reviewedDiets', coalesce((select jsonb_agg(subject order by subject) from diets where yes_reviewed and not coalesce(no, false)), '[]'::jsonb),
    'checkedOn', (select checked_on from item));
$$;
revoke all on function staging.tester_meal_checks(uuid) from public, anon, authenticated;

create or replace function staging.tester_meal_all_pass(c jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce((c ->> 'meal')::boolean and (c ->> 'rights')::boolean and (c ->> 'stated')::boolean and (c ->> 'place')::boolean
                  and (c ->> 'fresh')::boolean and (c ->> 'price')::boolean and (c ->> 'open')::boolean
                  and (c ->> 'reviewed')::boolean, false);
$$;
revoke all on function staging.tester_meal_all_pass(jsonb) from public, anon, authenticated;
