-- Pilot publication pipeline: from facts the founder has VERIFIED in staging to a DRAFT public place
-- and its dishes, which a publisher then checks in the existing two-person editor (owner direction
-- 2026-11-16 07:55 UTC, item 4; plan docs/29).
--
-- What this adds, and the safeguards:
--   * staging.prepare_publication(curator, place) builds a publication from VERIFIED facts only.
--     Submitted, rejected, replaced or unknown facts are never used as facts; an unknown dietary
--     status stays unknown ("needs confirmation"); unknown nutrition stays null, never zero.
--   * It writes only DRAFT public rows (venue status 'draft', food items status 'draft') and two-person
--     catalog changes in the 'submitted' state. Draft rows are invisible to every public read: a test
--     compares search, map, filters, counts and detail pages before and after.
--   * Publishing is the existing editor review (public.editor_review_change) by a publisher who is
--     not the person who prepared it, with its source and rights checks and publish gate.
--   * REAL-DATA LOCK: approving a pilot change is refused ('PUBLICATION_LOCKED') unless the platform
--     switch 'pilot_publication' is on. It is off, nothing in the app or the scripts can turn it on,
--     and turning it on is the founder's separate publication decision.
--   * At approval every staged fact used must still be verified (not replaced since); a dish cannot
--     go public before its place; facts from pages whose rights are 'denied' or that are not the
--     restaurant's own are left out with a reason.
--   * Everything is recorded: staging.publications and staging.publication_changes are permanent,
--     and staging.events logs each preparation.
--
-- Rollback (local): drop the two tables and the functions created here, restore
-- public.editor_review_change from 20261115000700, restore the switch and event-action checks, and
-- delete the 'pilot_publication' switch and the licence row ...b003.

-- ---------------------------------------------------------------------------
-- 1. The real-data lock and the licence for restated restaurant facts
-- ---------------------------------------------------------------------------
alter table app.platform_switches drop constraint platform_switches_name_check;
alter table app.platform_switches add constraint platform_switches_name_check
  check (name in ('social_public', 'real_catalog_entry', 'pilot_publication'));
insert into app.platform_switches (name, enabled) values ('pilot_publication', false);

create function app.pilot_publication_enabled()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select w.enabled from app.platform_switches w where w.name = 'pilot_publication'), false);
$$;
revoke all on function app.pilot_publication_enabled() from public, anon, authenticated;

insert into public.licenses (id, label, checked_at, permitted_uses, attribution)
values ('00000000-0000-4000-8000-00000000b003',
        'Facts from a restaurant''s own published pages, restated in our own words; no text, photos or logos copied', now(),
        array['display', 'store'], 'Checked with the restaurant''s own pages');

alter table staging.events drop constraint events_action_check;
alter table staging.events add constraint events_action_check
  check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact',
                    'set_place_status', 'prepare_publication'));

-- ---------------------------------------------------------------------------
-- 2. Permanent record of each publication
-- ---------------------------------------------------------------------------
create table staging.publications (
  id             uuid primary key default gen_random_uuid(),
  place_id       uuid not null references staging.places (id),
  venue_id       uuid not null references public.venues (id),
  prepared_by    uuid not null,
  prepared_at    timestamptz not null default now(),
  content        jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$')
);
create index staging_publications_place_idx on staging.publications (place_id);

create table staging.publication_changes (
  publication_id uuid not null references staging.publications (id),
  change_id      uuid primary key references public.catalog_changes (id),
  kind           text not null check (kind in ('venue', 'dish')),
  dish_id        uuid references staging.dishes (id),
  fact_ids       uuid[] not null check (cardinality(fact_ids) > 0),
  source_records uuid[] not null,
  check ((kind = 'dish') = (dish_id is not null))
);
create index staging_publication_changes_pub_idx on staging.publication_changes (publication_id);

do $$
declare t text;
begin
  foreach t in array array['publications', 'publication_changes'] loop
    execute format('alter table staging.%I enable row level security', t);
    execute format('alter table staging.%I force row level security', t);
    execute format('revoke all on staging.%I from public, anon, authenticated', t);
    execute format('create policy %I on staging.%I for all to postgres using (true) with check (true)', t || '_owner', t);
    execute format('create trigger %I before update or delete on staging.%I for each row execute function staging.guard_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on staging.%I for each statement execute function staging.guard_no_truncate()', t || '_no_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- The one current verified fact of a kind (latest review wins); unknown facts are returned too, so
-- the caller can keep "unknown" explicit.
create function staging.verified_fact(p_place uuid, p_dish uuid, p_kind text, p_subject text default null)
returns staging.facts
language sql
stable
security definer
set search_path = ''
as $$
  select f.* from staging.facts f
   where f.place_id = p_place and f.dish_id is not distinct from p_dish and f.kind = p_kind
     and f.subject is not distinct from p_subject and f.status = 'verified'
   order by f.reviewed_at desc, f.entered_at desc limit 1;
$$;

-- "Mon-Sat 08:00-22:00; Sun 08:00-21:00" (staged periods) into MAP-2 weekly periods (0 = Sunday).
-- A close at or before the open means the period runs past midnight. Anything unreadable gives null.
create function staging.weekly_from_periods(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  names constant text[] := array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  x jsonb;
  tok text;
  a int;
  b int;
  d int;
  v_open time;
  v_close time;
  out jsonb := '[]'::jsonb;
begin
  if p is null or coalesce(jsonb_typeof(p -> 'periods'), '') <> 'array' or jsonb_array_length(p -> 'periods') = 0 then return null; end if;
  for x in select * from jsonb_array_elements(p -> 'periods') loop
    begin
      v_open := (x ->> 'open')::time; v_close := (x ->> 'close')::time;
    exception when others then return null;
    end;
    if v_open is null or v_close is null or coalesce(x ->> 'days', '') = '' then return null; end if;
    foreach tok in array regexp_split_to_array(lower(x ->> 'days'), '\s*,\s*') loop
      a := array_position(names, left(split_part(tok, '-', 1), 3)) - 1;
      b := case when position('-' in tok) > 0 then array_position(names, left(split_part(tok, '-', 2), 3)) - 1 else a end;
      if a is null or b is null then return null; end if;
      d := a;
      loop
        out := out || jsonb_build_object('day', d, 'opens', to_char(v_open, 'HH24:MI'),
                                         'closes', to_char(v_close, 'HH24:MI'), 'closesNextDay', v_close <= v_open);
        exit when d = b;
        d := (d + 1) % 7;
      end loop;
    end loop;
  end loop;
  return jsonb_build_object('weekly', out, 'exceptions', '[]'::jsonb);
end;
$$;

-- Staged allergen words to the catalog's list. Unlisted words give null (left out, never guessed).
create function staging.catalog_allergen(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case lower(btrim(p))
    when 'milk' then 'milk' when 'dairy' then 'milk' when 'egg' then 'egg' when 'eggs' then 'egg'
    when 'peanut' then 'peanut' when 'peanuts' then 'peanut' when 'tree_nut' then 'tree_nut' when 'tree_nuts' then 'tree_nut'
    when 'soy' then 'soy' when 'wheat' then 'wheat' when 'gluten' then 'gluten' when 'sesame' then 'sesame'
    when 'fish' then 'fish' when 'shellfish' then 'shellfish' when 'mustard' then 'mustard' when 'celery' then 'celery'
    when 'lupin' then 'lupin' when 'sulfite' then 'sulfite' when 'sulfites' then 'sulfite' end;
$$;

create function staging.area_words(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_area when 'central_square' then 'Central Square' when 'harvard_square' then 'Harvard Square'
                     else initcap(replace(p_area, '_', ' ')) end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Prepare a publication (curator). Writes only drafts; publishes nothing.
-- ---------------------------------------------------------------------------
create function staging.prepare_publication(p_actor uuid, p_place uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pl staging.places;
  pg staging.source_pages;
  f staging.facts;
  f2 staging.facts;
  dsh staging.dishes;
  v_market public.markets;
  v_pub uuid := gen_random_uuid();
  v_venue uuid := gen_random_uuid();
  v_change uuid;
  v_item uuid;
  v_rev uuid;
  v_records jsonb := '{}'::jsonb;      -- staged page id -> public source record id
  v_left jsonb := '[]'::jsonb;         -- what was left out, and why
  v_dishes jsonb := '[]'::jsonb;
  v_facts uuid[];
  v_recs uuid[];
  v_hours jsonb;
  v_name text;
  v_expires timestamptz;
  v_rec uuid;
  v_claims jsonb;
  v_nutr jsonb;
  v_allerg jsonb;
  v_price integer;
  v_grams numeric;
  a text;
  v_content jsonb;
  v_has_protein boolean;
  v_days integer;
begin
  perform staging.require_role(p_actor, 'curator');
  select * into pl from staging.places where id = p_place for update;
  if not found then raise exception 'STAGING_NOT_FOUND' using errcode = 'PT404'; end if;
  if pl.pilot_status = 'rejected' then raise exception 'PLACE_REJECTED' using errcode = 'PT409'; end if;
  -- One publication at a time per place; a place already published is changed by a later slice.
  if exists (select 1 from staging.publications p join staging.publication_changes pc on pc.publication_id = p.id
               join public.catalog_changes ch on ch.id = pc.change_id
              where p.place_id = pl.id and ch.state in ('draft', 'submitted', 'published')) then
    raise exception 'PUBLICATION_EXISTS' using errcode = 'PT409';
  end if;

  -- The place itself needs a verified address and a verified "operating" status.
  f := staging.verified_fact(pl.id, null, 'address');
  f2 := staging.verified_fact(pl.id, null, 'operating_status');
  if f.id is null or f.is_unknown or f2.id is null or f2.is_unknown or f2.value ->> 'status' <> 'operating' then
    raise exception 'PLACE_NOT_READY' using errcode = 'PT422',
      detail = concat_ws(',', case when f.id is null or f.is_unknown then 'address_not_verified' end,
                              case when f2.id is null or f2.is_unknown or f2.value ->> 'status' <> 'operating' then 'operating_status_not_verified' end);
  end if;

  -- Public source records, one per staged page that may be used: the restaurant's own pages only,
  -- and never one whose rights are denied.
  for pg in select distinct sp.* from staging.source_pages sp join staging.facts x on x.source_page_id = sp.id
             where x.place_id = pl.id and x.status = 'verified' loop
    if not staging.is_restaurant_own(pg.page_kind) or pg.rights_status = 'denied' then continue; end if;
    with s as (
      insert into public.sources (publisher, source_type, canonical_url, license_id, access_scope, is_demo, retrieved_at)
      values (pg.publisher, case when pg.page_kind = 'restaurant_nutrition_guide' then 'operator_statement' else 'menu' end,
              pg.url, '00000000-0000-4000-8000-00000000b003', 'public', false, pg.retrieved_at)
      returning id)
    insert into public.source_records (source_id, observed_at, evidence_summary, rights_status)
    select s.id, pg.retrieved_at, 'Read on the restaurant''s own page; facts restated in our own words', 'unreviewed' from s
    returning id into v_rec;
    v_records := v_records || jsonb_build_object(pg.id::text, v_rec);
  end loop;
  if not (v_records ? f.source_page_id::text) or not (v_records ? f2.source_page_id::text) then
    raise exception 'PLACE_NOT_READY' using errcode = 'PT422', detail = 'place_source_not_usable';
  end if;

  -- The draft place: invisible until the venue change is approved.
  select * into v_market from public.markets m where m.slug = 'boston';
  v_name := btrim(regexp_replace(pl.label, '\s*\([^)]*\)\s*$', ''));
  insert into public.venues (id, market_id, slug, name, neighborhood, street, locality, region, postal_code, location, timezone, venue_type, status, is_demo)
  values (v_venue, v_market.id,
          left(trim(both '-' from regexp_replace(lower(v_name || ' ' || staging.area_words(pl.area)), '[^a-z0-9]+', '-', 'g')), 100) || '-' || left(v_pub::text, 8),
          v_name, staging.area_words(pl.area), f.value ->> 'street', pl.city, 'MA', f.value ->> 'postcode', null,
          v_market.default_timezone, 'restaurant', 'draft', false);

  v_facts := array[f.id, f2.id];
  v_recs := array[(v_records ->> f.source_page_id::text)::uuid, (v_records ->> f2.source_page_id::text)::uuid];
  f := staging.verified_fact(pl.id, null, 'weekly_hours');
  if f.id is not null and not f.is_unknown and v_records ? f.source_page_id::text then
    v_hours := staging.weekly_from_periods(f.value);
    if v_hours is not null then
      v_hours := app.clean_hours(v_hours);
      v_facts := v_facts || f.id;
      v_recs := v_recs || (v_records ->> f.source_page_id::text)::uuid;
    else
      v_left := v_left || jsonb_build_object('factId', f.id, 'reason', 'hours_unreadable');
    end if;
  elsif f.id is not null and not f.is_unknown then
    v_left := v_left || jsonb_build_object('factId', f.id, 'reason', 'source_not_usable');
  end if;

  insert into public.catalog_changes (kind, is_new, venue_id, author_id, state, summary, source_record_id, payload, submitted_at)
  values ('venue', true, v_venue, p_actor, 'submitted',
          left('Pilot: ' || v_name || ', ' || staging.area_words(pl.area) || ', from facts the founder verified', 500),
          v_recs[1],
          jsonb_strip_nulls(jsonb_build_object('name', v_name, 'neighborhood', staging.area_words(pl.area),
            'street', (select x.value ->> 'street' from staging.facts x where x.id = v_facts[1]), 'locality', pl.city, 'region', 'MA',
            'postalCode', (select x.value ->> 'postcode' from staging.facts x where x.id = v_facts[1]),
            'venueType', 'restaurant', 'status', 'published', 'structuredHours', v_hours)),
          now())
  returning id into v_change;
  v_content := jsonb_build_object('place', jsonb_build_object('stagedPlaceId', pl.id, 'venueId', v_venue, 'changeId', v_change,
                                  'name', v_name, 'factIds', to_jsonb(v_facts), 'hours', v_hours is not null));
  -- Remember the change; written to publication_changes once the publication row exists.
  v_dishes := jsonb_build_array(jsonb_build_object('kind', 'venue', 'changeId', v_change, 'factIds', to_jsonb(v_facts), 'records', to_jsonb(v_recs)));

  select coalesce(fr.expire_days, fr.review_days) into v_days from app.freshness_rules fr where fr.subject = 'dish';
  v_expires := now() + make_interval(days => coalesce(v_days, 90));

  -- Dishes: only those the founder confirmed are on the current menu.
  for dsh in select * from staging.dishes where place_id = pl.id order by created_at, label loop
    f := staging.verified_fact(pl.id, dsh.id, 'menu_item');
    if f.id is null or f.is_unknown or f.value ->> 'listed' <> 'true' or not (v_records ? f.source_page_id::text) then
      v_left := v_left || jsonb_build_object('stagedDishId', dsh.id, 'reason', 'not_confirmed_on_menu');
      continue;
    end if;
    v_facts := array[f.id];
    v_rec := (v_records ->> f.source_page_id::text)::uuid;
    v_recs := array[v_rec];
    v_item := gen_random_uuid(); v_rev := gen_random_uuid();
    insert into public.food_items (id, kind, visibility, status, is_demo) values (v_item, 'dish', 'public', 'draft', false);
    insert into public.food_revisions (id, food_item_id, revision_no, name, preparation_state, basis_kind, basis_amount, basis_unit)
    values (v_rev, v_item, 1, dsh.label, 'prepared', 'serving', 1, 'serving');
    insert into public.dishes (food_item_id, venue_id) values (v_item, v_venue);

    -- Serving weight only when verified; otherwise "1 serving" with no grams invented.
    f2 := staging.verified_fact(pl.id, dsh.id, 'serving_size');
    v_grams := null;
    if f2.id is not null and not f2.is_unknown and v_records ? f2.source_page_id::text then
      v_grams := (f2.value ->> 'grams')::numeric;
      v_facts := v_facts || f2.id; v_recs := v_recs || (v_records ->> f2.source_page_id::text)::uuid;
    end if;
    insert into public.portions (revision_id, label, amount, unit, grams, source_record_id)
    values (v_rev, '1 serving', 1, 'serving', v_grams, case when v_grams is not null then (v_records ->> f2.source_page_id::text)::uuid end);

    -- Dietary status: a verified yes or no only. Unknown is simply not stated, so the dish shows
    -- "needs confirmation" and passes no filter.
    v_claims := '{}'::jsonb;
    for f2 in select (staging.verified_fact(pl.id, dsh.id, 'dietary_status', c)).* from unnest(array['vegetarian', 'vegan', 'egg_free']) c loop
      continue when f2.id is null;
      if f2.is_unknown then v_claims := v_claims || jsonb_build_object(f2.subject, 'unknown'); continue; end if;
      if not (v_records ? f2.source_page_id::text) then
        v_left := v_left || jsonb_build_object('factId', f2.id, 'reason', 'source_not_usable'); continue;
      end if;
      v_rec := (v_records ->> f2.source_page_id::text)::uuid;
      if f2.subject in ('vegetarian', 'vegan') then
        insert into public.dietary_claims (revision_id, diet, outcome, evidence_tier, source_record_id, checked_at, expires_at, conflict_state)
        values (v_rev, f2.subject, case when f2.value ->> 'status' = 'yes' then 'compatible' else 'incompatible' end, 'documented',
                v_rec, f2.checked_on, v_expires, 'none');
      else
        insert into public.ingredient_family_statements (revision_id, family, presence, source_record_id, detail, checked_at, expires_at)
        values (v_rev, 'egg', case when f2.value ->> 'status' = 'yes' then 'absent_by_statement' else 'present' end, v_rec,
                'Stated on the restaurant''s own page', f2.checked_on, v_expires);
      end if;
      v_claims := v_claims || jsonb_build_object(f2.subject, f2.value ->> 'status');
      v_facts := v_facts || f2.id; v_recs := v_recs || v_rec;
    end loop;

    -- Allergen statements, in the catalog's words. "May contain" is cross-contact, not presence.
    v_allerg := '[]'::jsonb;
    for f2 in select x.* from staging.facts x where x.place_id = pl.id and x.dish_id = dsh.id and x.kind = 'allergen_statement'
                 and x.status = 'verified' and not x.is_unknown order by x.reviewed_at loop
      if not (v_records ? f2.source_page_id::text) then
        v_left := v_left || jsonb_build_object('factId', f2.id, 'reason', 'source_not_usable'); continue;
      end if;
      v_rec := (v_records ->> f2.source_page_id::text)::uuid;
      for a in select staging.catalog_allergen(e) from jsonb_array_elements_text(f2.value -> 'allergens') e loop
        if a is null then continue; end if;
        insert into public.allergen_statements (revision_id, allergen, presence, cross_contact, source_record_id, checked_at)
        values (v_rev, a,
                case f2.value ->> 'statement' when 'contains' then 'present' when 'free_from' then 'absent_by_statement' else 'unknown' end,
                case when f2.value ->> 'statement' = 'may_contain' then 'reported' else 'unknown' end, v_rec, f2.checked_on)
        on conflict (revision_id, allergen) do update
          set presence = case when public.allergen_statements.presence = 'present' or excluded.presence = 'present' then 'present'
                              when excluded.presence = 'unknown' then public.allergen_statements.presence else excluded.presence end,
              cross_contact = case when excluded.cross_contact = 'reported' then 'reported' else public.allergen_statements.cross_contact end;
        v_allerg := v_allerg || jsonb_build_object('allergen', a, 'statement', f2.value ->> 'statement');
      end loop;
      if exists (select 1 from jsonb_array_elements_text(f2.value -> 'allergens') e where staging.catalog_allergen(e) is null) then
        v_left := v_left || jsonb_build_object('factId', f2.id, 'reason', 'allergen_word_not_in_catalog');
      end if;
      v_facts := v_facts || f2.id; v_recs := v_recs || v_rec;
    end loop;

    -- Nutrition: the restaurant's own figure per serving, method 'published'. Unknown stays null.
    v_nutr := '{}'::jsonb;
    v_has_protein := false;
    for f2 in select x.* from staging.facts x where x.place_id = pl.id and x.dish_id = dsh.id and x.kind = 'published_nutrition'
                 and x.status = 'verified' and x.id = (staging.verified_fact(pl.id, dsh.id, 'published_nutrition', x.subject)).id loop
      if f2.is_unknown then
        insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason)
        values (v_rev, f2.subject, null, 'unknown', 'not_provided') on conflict do nothing;
        v_facts := v_facts || f2.id;
        v_has_protein := v_has_protein or f2.subject = 'protein_g';
        v_nutr := v_nutr || jsonb_build_object(f2.subject, null);
        continue;
      end if;
      if f2.value ->> 'per' <> 'serving' then
        v_left := v_left || jsonb_build_object('factId', f2.id, 'reason', 'per_100g_needs_serving_weight'); continue;
      end if;
      if not (v_records ? f2.source_page_id::text) then
        v_left := v_left || jsonb_build_object('factId', f2.id, 'reason', 'source_not_usable'); continue;
      end if;
      v_rec := (v_records ->> f2.source_page_id::text)::uuid;
      insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id, assumptions)
      values (v_rev, f2.subject, (f2.value ->> 'amount')::numeric, 'published', v_rec,
              'As published by the restaurant for one serving; not measured by us');
      v_has_protein := v_has_protein or f2.subject = 'protein_g';
      v_nutr := v_nutr || jsonb_build_object(f2.subject, (f2.value ->> 'amount')::numeric);
      v_facts := v_facts || f2.id; v_recs := v_recs || v_rec;
    end loop;
    if not v_has_protein then
      insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason)
      values (v_rev, 'protein_g', null, 'unknown', 'not_provided');
    end if;

    -- A price only when it was read on the same page as the menu listing (the change's source).
    v_price := null;
    f2 := staging.verified_fact(pl.id, dsh.id, 'price');
    if f2.id is not null and not f2.is_unknown then
      if f2.source_page_id = f.source_page_id then
        v_price := round((f2.value ->> 'usd')::numeric * 100)::integer;
        v_facts := v_facts || f2.id;
      else
        v_left := v_left || jsonb_build_object('factId', f2.id, 'reason', 'price_on_other_page');
      end if;
    end if;

    insert into public.catalog_changes (kind, is_new, food_item_id, draft_revision_id, author_id, state, summary, source_record_id, payload, submitted_at, touches_evidence)
    values ('food', true, v_item, v_rev, p_actor, 'submitted',
            left('Pilot: ' || dsh.label || ' at ' || v_name || ', from facts the founder verified', 500),
            (v_recs)[1], case when v_price is not null then jsonb_build_object('dish', jsonb_build_object('priceCents', v_price)) else '{}'::jsonb end,
            now(), true)
    returning id into v_change;
    update public.catalog_changes set draft_snapshot = app.editor_evidence(v_rev) where id = v_change;
    v_dishes := v_dishes || jsonb_build_object('kind', 'dish', 'changeId', v_change, 'stagedDishId', dsh.id, 'foodItemId', v_item,
                                               'name', dsh.label, 'factIds', to_jsonb(v_facts), 'records', to_jsonb(v_recs),
                                               'dietary', v_claims, 'nutrition', v_nutr, 'allergens', v_allerg, 'priceCents', v_price,
                                               'servingGrams', v_grams);
  end loop;

  v_content := v_content || jsonb_build_object('changes', v_dishes, 'leftOut', v_left);
  insert into staging.publications (id, place_id, venue_id, prepared_by, content, content_sha256)
  values (v_pub, pl.id, v_venue, p_actor, v_content, encode(extensions.digest(v_content::text, 'sha256'), 'hex'));
  insert into staging.publication_changes (publication_id, change_id, kind, dish_id, fact_ids, source_records)
  select v_pub, (c ->> 'changeId')::uuid, c ->> 'kind', (c ->> 'stagedDishId')::uuid,
         array(select jsonb_array_elements_text(c -> 'factIds')::uuid),
         array(select distinct jsonb_array_elements_text(c -> 'records')::uuid)
    from jsonb_array_elements(v_dishes) c;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'prepare_publication', pl.id, jsonb_build_object('publicationId', v_pub, 'changes', jsonb_array_length(v_dishes), 'leftOut', jsonb_array_length(v_left)));
  return jsonb_build_object('publicationId', v_pub, 'venueId', v_venue) || v_content;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The checks a pilot change must pass when a publisher approves it
-- ---------------------------------------------------------------------------
create function staging.guard_pilot_review(p_change uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pc staging.publication_changes;
  v_venue uuid;
begin
  select * into pc from staging.publication_changes where change_id = p_change;
  if not found then return; end if;   -- an ordinary editor change: nothing to add
  if not app.pilot_publication_enabled() then
    raise exception 'PUBLICATION_LOCKED' using errcode = 'PT409',
      detail = 'Publishing real restaurants is switched off until the founder approves publication';
  end if;
  if exists (select 1 from staging.facts f where f.id = any (pc.fact_ids) and f.status <> 'verified') then
    raise exception 'STAGED_FACT_CHANGED' using errcode = 'PT409';
  end if;
  if pc.kind = 'dish' then
    select p.venue_id into v_venue from staging.publications p where p.id = pc.publication_id;
    if not exists (select 1 from public.venues v where v.id = v_venue and v.status in ('published', 'temporarily_closed')) then
      raise exception 'VENUE_NOT_PUBLISHED' using errcode = 'PT409';
    end if;
  end if;
  -- The publisher has just confirmed the rights check for this change: clear its records.
  update public.source_records set rights_status = 'cleared' where id = any (pc.source_records);
end;
$$;

-- Hook the guard into the existing review, just before the publisher's source/rights checks.
do $$
declare
  v_def text := pg_catalog.pg_get_functiondef('public.editor_review_change(uuid, text, text, boolean, boolean)'::regprocedure);
  v_anchor text := '  if not coalesce(p_source_checked, false) or not coalesce(p_rights_ok, false) then';
begin
  if position(v_anchor in v_def) = 0 then raise exception 'editor_review_change anchor not found'; end if;
  v_def := replace(v_def, v_anchor, '  perform staging.guard_pilot_review(ch.id);  -- pilot publication' || E'\n' || v_anchor);
  execute v_def;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Reading a publication (founder and scripts; closed to visitors and members)
-- ---------------------------------------------------------------------------
create function staging.publication_status(p_publication uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'publicationId', p.id, 'placeId', p.place_id, 'venueId', p.venue_id, 'preparedAt', p.prepared_at,
    'contentSha256', p.content_sha256, 'locked', not app.pilot_publication_enabled(),
    'venueStatus', (select v.status from public.venues v where v.id = p.venue_id),
    'changes', (select jsonb_agg(jsonb_build_object('changeId', pc.change_id, 'kind', pc.kind, 'state', ch.state,
                                                    'staleFacts', (select count(*) from staging.facts f where f.id = any (pc.fact_ids) and f.status <> 'verified'))
                                 order by pc.kind desc, ch.created_at)
                  from staging.publication_changes pc join public.catalog_changes ch on ch.id = pc.change_id
                 where pc.publication_id = p.id),
    'leftOut', p.content -> 'leftOut')
  from staging.publications p where p.id = p_publication;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'staging' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
