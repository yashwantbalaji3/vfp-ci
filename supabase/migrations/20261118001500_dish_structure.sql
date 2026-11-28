-- Dish structure and nutrition bases for drafted menus (docs/58, owner direction 18 Nov 19:19 UTC).
--
-- 1. Every drafted dish can be classified: a complete meal, a build-your-own meal, or one of its parts
--    (component, base, protein, topping or sauce), a side, a drink or a dessert. A part can belong to one
--    build-your-own meal, so its parts are never counted as meals of their own. The classification says
--    how it was decided (the source's own section or label, or a person) and is append-only: a new row
--    replaces the old one, and the history stays.
-- 2. Options on a meal (add tofu, change the base, remove cheese, a bigger size), each with its source.
-- 3. A published nutrition figure says what kind of figure it is: one published value, a published
--    range (low to high, never collapsed to one number) or the restaurant's own estimate. Only a single
--    published value can be verified for the public catalog; ranges and estimates stay drafts or private
--    transcription checks. USDA estimates are never staged as published facts, and unknown stays unknown.
-- Nothing here publishes anything, and nothing is readable outside the founder's screens.

-- 1. Classification.
create table staging.dish_structure (
  id             bigint generated always as identity primary key,
  dish_id        uuid not null,
  place_id       uuid not null,
  dish_type      text not null check (dish_type in ('complete_meal', 'customizable_meal', 'component', 'base', 'protein',
                                                    'topping_sauce', 'side', 'beverage', 'dessert')),
  parent_dish_id uuid,
  section        text check (section is null or length(section) between 1 and 120),
  portion_label  text check (portion_label is null or length(portion_label) between 1 and 40),
  basis          text not null check (basis in ('source_section', 'source_label', 'person')),
  evidence       text check (evidence is null or length(evidence) between 1 and 300),
  created_by     uuid not null,
  created_at     timestamptz not null default clock_timestamp(),
  foreign key (dish_id, place_id) references staging.dishes (id, place_id),
  foreign key (parent_dish_id, place_id) references staging.dishes (id, place_id),
  check (parent_dish_id is null or parent_dish_id <> dish_id),
  -- Meals stand on their own; only parts, sides and drinks can sit inside a build-your-own meal.
  check (parent_dish_id is null or dish_type not in ('complete_meal', 'customizable_meal'))
);
create index dish_structure_dish on staging.dish_structure (dish_id, created_at desc, id desc);
alter table staging.dish_structure enable row level security;
alter table staging.dish_structure force row level security;
revoke all on staging.dish_structure from public, anon, authenticated;
create trigger dish_structure_append_only before update or delete on staging.dish_structure
  for each row execute function staging.guard_confirmations_append_only();

-- The current classification of a dish: its newest row.
create function staging.current_structure(p_dish uuid)
returns staging.dish_structure
language sql
stable
set search_path = ''
as $$
  select s.* from staging.dish_structure s where s.dish_id = p_dish order by s.created_at desc, s.id desc limit 1;
$$;
revoke all on function staging.current_structure(uuid) from public, anon, authenticated;

-- 2. Options on a meal.
create table staging.dish_options (
  id                bigint generated always as identity primary key,
  dish_id           uuid not null,
  place_id          uuid not null,
  option_kind       text not null check (option_kind in ('add', 'remove', 'swap', 'size')),
  label             text not null check (length(label) between 1 and 120),
  component_dish_id uuid,
  price_delta_usd   text check (price_delta_usd is null or price_delta_usd ~ '^-?[0-9]{1,3}(\.[0-9]{2})?$'),
  source_page_id    uuid not null references staging.source_pages (id),
  checked_on        date not null,
  created_by        uuid not null,
  created_at        timestamptz not null default clock_timestamp(),
  foreign key (dish_id, place_id) references staging.dishes (id, place_id),
  foreign key (component_dish_id, place_id) references staging.dishes (id, place_id),
  unique (dish_id, option_kind, label)
);
alter table staging.dish_options enable row level security;
alter table staging.dish_options force row level security;
revoke all on staging.dish_options from public, anon, authenticated;
create trigger dish_options_append_only before update or delete on staging.dish_options
  for each row execute function staging.guard_confirmations_append_only();

alter table staging.events drop constraint events_action_check;
alter table staging.events add constraint events_action_check
  check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact',
                    'set_place_status', 'prepare_publication', 'link_catalog', 'unlink_catalog', 'request_correction',
                    'confirm_transcription', 'classify_dish', 'add_dish_option'));

create function staging.classify_dish(p_actor uuid, p_dish uuid, p_type text, p_parent uuid default null,
                                      p_section text default null, p_portion text default null,
                                      p_basis text default 'source_section', p_evidence text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
  v_parent staging.dish_structure;
  v_id bigint;
begin
  perform staging.require_role(p_actor, 'curator');
  select place_id into v_place from staging.dishes where id = p_dish;
  if v_place is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_parent is not null then
    v_parent := staging.current_structure(p_parent);
    if v_parent.dish_type is distinct from 'customizable_meal' then
      raise exception 'STAGING_PARENT_NOT_CUSTOMIZABLE' using errcode = 'PT422';
    end if;
  end if;
  -- A build-your-own meal that still has parts cannot become a part itself.
  if p_type not in ('complete_meal', 'customizable_meal') and exists (
       select 1 from staging.dishes d where d.place_id = v_place
          and (staging.current_structure(d.id)).parent_dish_id = p_dish) then
    raise exception 'STAGING_HAS_PARTS' using errcode = 'PT422';
  end if;
  insert into staging.dish_structure (dish_id, place_id, dish_type, parent_dish_id, section, portion_label, basis, evidence, created_by)
  values (p_dish, v_place, p_type, p_parent, nullif(trim(p_section), ''), nullif(trim(p_portion), ''), p_basis,
          nullif(trim(p_evidence), ''), p_actor)
  returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'classify_dish', v_place, jsonb_build_object('dishId', p_dish, 'type', p_type, 'parent', p_parent, 'basis', p_basis));
  return v_id;
end;
$$;
revoke all on function staging.classify_dish(uuid, uuid, text, uuid, text, text, text, text) from public, anon, authenticated;

create function staging.add_dish_option(p_actor uuid, p_dish uuid, p_kind text, p_label text, p_source uuid, p_checked_on date,
                                        p_component uuid default null, p_price_delta text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
  v_id bigint;
begin
  perform staging.require_role(p_actor, 'curator');
  select place_id into v_place from staging.dishes where id = p_dish;
  if v_place is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_checked_on > (now() at time zone 'America/New_York')::date then
    raise exception 'STAGING_FUTURE_DATE' using errcode = 'PT422';
  end if;
  if staging.source_access_state((select url from staging.source_pages where id = p_source)) = 'prohibited' then
    raise exception 'STAGING_SOURCE_PROHIBITED' using errcode = 'PT422';
  end if;
  insert into staging.dish_options (dish_id, place_id, option_kind, label, component_dish_id, price_delta_usd, source_page_id, checked_on, created_by)
  values (p_dish, v_place, p_kind, trim(p_label), p_component, p_price_delta, p_source, p_checked_on, p_actor)
  returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'add_dish_option', v_place, jsonb_build_object('dishId', p_dish, 'kind', p_kind, 'label', trim(p_label)));
  return v_id;
end;
$$;
revoke all on function staging.add_dish_option(uuid, uuid, text, text, uuid, date, uuid, text) from public, anon, authenticated;

-- 3. Nutrition bases. A value without a basis is a single published value, as before.
create or replace function staging.fact_value_valid(p_kind text, v jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(v) = 'object' and case p_kind
    when 'address' then coalesce(length(v ->> 'street'), 0) between 1 and 200 and coalesce(length(v ->> 'postcode'), 0) between 5 and 10
    when 'operating_status' then v ->> 'status' in ('operating', 'closed', 'temporarily_closed')
    when 'weekly_hours' then jsonb_typeof(v -> 'periods') = 'array'
    when 'menu_item' then (v ->> 'listed') in ('true', 'false')
    when 'price' then coalesce(v ->> 'usd', '') ~ '^[0-9]{1,4}(\.[0-9]{2})?$'
    when 'dietary_status' then v ->> 'claim' in ('vegan', 'vegetarian', 'egg_free') and v ->> 'status' in ('yes', 'no')
    when 'allergen_statement' then v ->> 'statement' in ('contains', 'may_contain', 'free_from') and jsonb_typeof(v -> 'allergens') = 'array'
    when 'published_nutrition' then v ->> 'nutrient' in ('protein_g', 'energy_kcal', 'fat_g', 'carb_g', 'fiber_g', 'sodium_mg')
      and v ->> 'per' in ('serving', '100g')
      and (v ->> 'portion' is null or length(v ->> 'portion') between 1 and 40)
      and case coalesce(v ->> 'basis', 'published')
            when 'published' then coalesce(v ->> 'amount', '') ~ '^[0-9]+(\.[0-9]+)?$' and v ->> 'low' is null and v ->> 'high' is null
            when 'restaurant_estimate' then coalesce(v ->> 'amount', '') ~ '^[0-9]+(\.[0-9]+)?$' and v ->> 'low' is null and v ->> 'high' is null
            when 'published_range' then v ->> 'amount' is null
              and coalesce(v ->> 'low', '') ~ '^[0-9]+(\.[0-9]+)?$' and coalesce(v ->> 'high', '') ~ '^[0-9]+(\.[0-9]+)?$'
              and (v ->> 'low')::numeric < (v ->> 'high')::numeric
            else false end
    when 'serving_size' then coalesce(v ->> 'grams', '') ~ '^[0-9]+(\.[0-9]+)?$' and (v ->> 'grams')::numeric > 0
    when 'listed_ingredients' then jsonb_typeof(v -> 'items') = 'array'
      and jsonb_array_length(v -> 'items') between 1 and 40
      and not exists (select 1 from jsonb_array_elements(v -> 'items') e
                       where jsonb_typeof(e) <> 'string' or length(trim(e #>> '{}')) not between 1 and 80)
    else false end;
$$;

-- Is this fact a single published figure (or not a nutrition figure at all)? Only those can be verified.
create function staging.single_published_value(f staging.facts)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select f.kind <> 'published_nutrition' or f.is_unknown or coalesce(f.value ->> 'basis', 'published') = 'published';
$$;
revoke all on function staging.single_published_value(staging.facts) from public, anon, authenticated;

create function staging.guard_nutrition_basis()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'verified' and old.status <> 'verified' and not staging.single_published_value(new) then
    raise exception 'STAGING_NOT_A_SINGLE_PUBLISHED_VALUE' using errcode = 'PT422';
  end if;
  return new;
end;
$$;
create trigger facts_nutrition_basis before update on staging.facts for each row execute function staging.guard_nutrition_basis();
revoke all on function staging.guard_nutrition_basis() from public, anon, authenticated;

-- 4. The founder's screens show the structure, the options and what kind of figure each one is.
create or replace function public.menu_review_fact_json(f staging.facts, p_me uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select staging.source_access_state((select p.url from staging.source_pages p where p.id = f.source_page_id)) as access,
           exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription') as transcribed,
           staging.single_published_value(f) as single
  )
  select jsonb_build_object(
    'factId', f.id, 'kind', f.kind, 'subject', f.subject, 'value', f.value, 'unknown', f.is_unknown,
    'unknownReason', f.unknown_reason, 'status', f.status, 'confidence', f.confidence,
    'sourceId', f.source_page_id, 'checkedOn', f.checked_on, 'access', s.access,
    'confirmAs', case when f.status <> 'submitted' or f.entered_by = p_me then null
                      when s.access = 'cleared' and s.single then 'verify'
                      when s.access = 'private_pilot' and not s.transcribed then 'transcription' end,
    'canConfirm', f.status = 'submitted' and f.entered_by <> p_me
                  and ((s.access = 'cleared' and s.single) or (s.access = 'private_pilot' and not s.transcribed)),
    'canReject', f.status = 'submitted' and f.entered_by <> p_me,
    'statuses', jsonb_build_object(
      'extracted', true,
      'transcriptionConfirmed', s.transcribed or f.status = 'verified',
      'dietaryVerified', f.status = 'verified' and f.kind in ('dietary_status', 'allergen_statement'),
      'nutritionVerified', f.status = 'verified' and f.kind in ('published_nutrition', 'serving_size'),
      'reuseEligible', s.access = 'cleared',
      'publicationApproved', exists (select 1 from staging.publication_changes pc join public.catalog_changes cc on cc.id = pc.change_id
                                      where f.id = any (pc.fact_ids) and cc.state = 'published')))
  from s;
$$;
revoke all on function public.menu_review_fact_json(staging.facts, uuid) from public, anon, authenticated;

create or replace function public.menu_review_place(p_place uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  p staging.places;
begin
  perform app.require_founder();
  select * into p from staging.places where id = p_place;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object(
    'placeId', p.id, 'label', p.label, 'area', p.area, 'city', p.city,
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('sourceId', s.id, 'url', s.url, 'host', staging.url_host(s.url), 'kind', s.page_kind,
                                          'publisher', s.publisher, 'retrievedAt', s.retrieved_at,
                                          'access', staging.source_access_state(s.url)) order by s.retrieved_at, s.url)
        from staging.source_pages s
       where s.id in (select f.source_page_id from staging.facts f where f.place_id = p.id)), '[]'::jsonb),
    'placeFacts', coalesce((
      select jsonb_agg(public.menu_review_fact_json(f, v_me) order by f.kind, f.entered_at)
        from staging.facts f where f.place_id = p.id and f.dish_id is null and f.status in ('submitted', 'verified')), '[]'::jsonb),
    'dishes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dishId', d.id, 'label', d.label,
               'structure', (select case when st.id is null then null else jsonb_build_object(
                                 'type', st.dish_type, 'parentDishId', st.parent_dish_id, 'section', st.section,
                                 'portion', st.portion_label, 'basis', st.basis, 'evidence', st.evidence) end
                               from staging.current_structure(d.id) st),
               'options', coalesce((select jsonb_agg(jsonb_build_object('kind', o.option_kind, 'label', o.label,
                                                                        'componentDishId', o.component_dish_id,
                                                                        'priceDeltaUsd', o.price_delta_usd, 'sourceId', o.source_page_id)
                                                     order by o.option_kind, o.label)
                                      from staging.dish_options o where o.dish_id = d.id), '[]'::jsonb),
               'facts', coalesce((select jsonb_agg(public.menu_review_fact_json(f, v_me) order by f.kind, f.subject nulls first, f.entered_at)
                                    from staging.facts f where f.dish_id = d.id and f.status in ('submitted', 'verified')), '[]'::jsonb),
               'corrections', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'subject', c.subject, 'corrected', c.corrected, 'at', c.at))
                                          from staging.open_corrections() c join staging.facts cf on cf.id = c.fact_id
                                         where cf.dish_id = d.id), '[]'::jsonb))
             order by d.label)
        from staging.dishes d where d.place_id = p.id), '[]'::jsonb));
end;
$$;

-- Rollback: drop the facts_nutrition_basis trigger, staging.guard_nutrition_basis,
-- staging.single_published_value, staging.add_dish_option, staging.classify_dish, staging.current_structure
-- and the dish_options and dish_structure tables; re-run fact_value_valid and menu_review_place from
-- 20261118001200 and menu_review_fact_json from 20261118001400. Events are append-only, so events_action_check keeps
-- the two new actions once any have been recorded. Nothing else changes.
