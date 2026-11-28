-- M2 · Discovery and Protein Explorer (plans/2026-11-13-m2-implementation-plan.md, slices S1, S2, S4, S9).
-- Requirement IDs: R-001, R-005, R-D01–R-D08, R-P01–R-P05, R-O03 (read side).
-- Expand-only: new nullable/defaulted columns, new tables, new functions. Nothing existing is altered or dropped.
-- Rollback: drop the functions and tables created here and the two venue columns.

-- ---------------------------------------------------------------------------
-- Venue attributes needed by independent filters (R-D02)
-- ---------------------------------------------------------------------------
alter table public.venues
  add column cuisines   text[] not null default '{}',
  add column price_band smallint check (price_band is null or price_band between 1 and 4);
create index venues_cuisines_gin on public.venues using gin (cuisines);

-- ---------------------------------------------------------------------------
-- Protein facts on three honest bases (R-P02, R-P03). Unknown stays null with a reason.
-- ---------------------------------------------------------------------------
create function app.protein_facts(p_revision_id uuid, p_include_estimates boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.food_revisions;
  pn public.nutrient_values;
  en public.nutrient_values;
  v_protein numeric;
  v_energy numeric;
  v_hidden_estimate boolean := false;
  v_label text;
  v_serving_g numeric;
  v_per_serving numeric;
  v_per_100g numeric;
  v_per_100kcal numeric;
  v_serving_reason text;
  v_100g_reason text;
  v_kcal_reason text;
  p public.portions;
begin
  select * into r from public.food_revisions where id = p_revision_id;
  if not found then return null; end if;
  select * into pn from public.nutrient_values where revision_id = r.id and nutrient_code = 'protein_g';
  select * into en from public.nutrient_values where revision_id = r.id and nutrient_code = 'energy_kcal';
  v_protein := pn.value;
  v_energy := en.value;
  -- Estimated figures are opt-in (R-P03): hidden by default, never shown as published.
  if pn.method = 'estimated' and not p_include_estimates then
    v_protein := null; v_hidden_estimate := true;
  end if;
  if en.method = 'estimated' and not p_include_estimates then
    v_energy := null;
  end if;

  if r.basis_kind = 'serving' then
    select * into p from public.portions
     where revision_id = r.id and unit = 'serving' order by (amount = 1) desc, label limit 1;
    v_label := coalesce(p.label, '1 serving');
    v_serving_g := case when p.grams is not null then p.grams / p.amount end;
    if v_protein is not null then
      v_per_serving := v_protein / r.basis_amount * coalesce(p.amount, 1);
      if v_serving_g is not null then
        v_per_100g := (v_protein / r.basis_amount) / v_serving_g * 100;
      else
        v_100g_reason := 'serving_weight_unknown';
      end if;
    end if;
  elsif r.basis_kind = 'mass' then
    select * into p from public.portions
     where revision_id = r.id and coalesce(grams, app.unit_to_grams(amount, unit)) is not null
     order by label limit 1;
    if found then
      v_label := p.label;
      v_serving_g := coalesce(p.grams, app.unit_to_grams(p.amount, p.unit));
      if v_protein is not null then v_per_serving := v_protein * v_serving_g / r.basis_amount; end if;
    else
      select label into v_label from public.portions where revision_id = r.id order by label limit 1;
      v_serving_reason := 'serving_weight_unknown';
    end if;
    if v_protein is not null then v_per_100g := v_protein * 100 / r.basis_amount; end if;
  else -- volume
    select * into p from public.portions
     where revision_id = r.id and coalesce(milliliters, app.unit_to_ml(amount, unit)) is not null
     order by label limit 1;
    if found then
      v_label := p.label;
      if v_protein is not null then
        v_per_serving := v_protein * coalesce(p.milliliters, app.unit_to_ml(p.amount, p.unit)) / r.basis_amount;
      end if;
    else
      v_serving_reason := 'serving_volume_unknown';
    end if;
    v_100g_reason := 'volume_basis';
  end if;

  if v_protein is null then
    v_serving_reason := coalesce(case when v_hidden_estimate then 'estimate_hidden' end, pn.missing_reason, 'not_provided');
    v_100g_reason := v_serving_reason;
    v_kcal_reason := v_serving_reason;
    v_per_serving := null; v_per_100g := null;
  elsif v_energy is null then
    v_kcal_reason := 'energy_not_provided';
  elsif v_energy = 0 then
    v_kcal_reason := 'energy_zero';
  else
    v_per_100kcal := v_protein / v_energy * 100;
  end if;

  return jsonb_build_object(
    'method', coalesce(pn.method, 'unknown'),
    'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
    'basisValue', v_protein,
    'servingLabel', v_label,
    'servingGrams', v_serving_g,
    'perServing', v_per_serving,
    'perServingReason', case when v_per_serving is null then v_serving_reason end,
    'per100g', v_per_100g,
    'per100gReason', case when v_per_100g is null then v_100g_reason end,
    'per100kcal', v_per_100kcal,
    'per100kcalReason', case when v_per_100kcal is null then v_kcal_reason end,
    'energyKcalPerServing', case when v_energy is not null and r.basis_kind = 'serving' then v_energy / r.basis_amount * coalesce(p.amount, 1)
                                 when v_energy is not null and r.basis_kind = 'mass' and v_serving_g is not null then v_energy * v_serving_g / r.basis_amount end,
    'energyMethod', en.method
  );
end;
$$;

-- Short, public description of where a number or claim came from (R-005).
create function app.source_summary(p_source_record_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'publisher', s.publisher, 'sourceType', s.source_type, 'observedAt', sr.observed_at,
    'summary', sr.evidence_summary, 'url', s.canonical_url, 'isDemo', s.is_demo)
  from public.source_records sr
  join public.sources s on s.id = sr.source_id
  where sr.id = p_source_record_id and s.access_scope = 'public';
$$;

-- ---------------------------------------------------------------------------
-- Catalog search (R-D01, R-D02, R-D04, R-D07, R-D08, R-P01–R-P03)
--
-- Strict dietary rule (owner decision 2026-11-13, docs/18):
--   view = 'matches'            -> only confirmed-compatible rows
--   view = 'needs_confirmation' -> only rows whose evidence is unknown/expired/disputed
--   rows that contain an excluded ingredient are returned in NEITHER view; only counted.
-- Eligibility always comes from app.eligibility, so the rule lives in one place.
-- ---------------------------------------------------------------------------
create function public.search_catalog(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_market_slug text := coalesce(p->>'market', 'boston');
  v_market uuid;
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_kinds text[] := case when p ? 'kinds' and jsonb_typeof(p->'kinds') = 'array'
                         then array(select jsonb_array_elements_text(p->'kinds')) end;
  v_diet text := coalesce(p->>'diet', 'none');
  v_excl text[] := case when p ? 'exclusions' and jsonb_typeof(p->'exclusions') = 'array'
                        then array(select jsonb_array_elements_text(p->'exclusions')) else '{}'::text[] end;
  v_view text := coalesce(p->>'view', 'matches');
  v_incl_cond boolean := coalesce((p->>'includeConditional')::boolean, false);
  v_hood text := nullif(p->>'neighborhood', '');
  v_lat double precision := (p->>'lat')::double precision;
  v_lon double precision := (p->>'lon')::double precision;
  v_radius integer := coalesce((p->>'radiusM')::integer, 5000);
  v_point extensions.geography;
  v_min_protein numeric := (p->>'minProtein')::numeric;
  v_basis text := coalesce(p->>'basis', 'serving');
  v_estimates boolean := coalesce(p->>'evidenceMode', 'published_calculated') = 'include_estimates';
  v_cuisine text := nullif(p->>'cuisine', '');
  v_max_price integer := (p->>'maxPriceBand')::integer;
  v_venue_type text := nullif(p->>'venueType', '');
  v_venue uuid := (p->>'venueId')::uuid;
  v_sort text := coalesce(p->>'sort', 'default');
  v_demo boolean := coalesce((p->>'includeDemo')::boolean, false);
  v_limit integer := coalesce((p->>'limit')::integer, 20);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_basis_key text;
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_view not in ('matches', 'needs_confirmation') then raise exception 'INVALID_VIEW' using errcode = 'PT422'; end if;
  if v_basis not in ('serving', '100g', '100kcal') then raise exception 'INVALID_BASIS' using errcode = 'PT422'; end if;
  if v_sort not in ('default', 'protein') then raise exception 'INVALID_SORT' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > 50 then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  if v_kinds is not null and not (v_kinds <@ array['dish', 'recipe', 'packaged', 'ingredient']) then
    raise exception 'INVALID_KIND' using errcode = 'PT422';
  end if;
  if (v_lat is null) <> (v_lon is null) then raise exception 'INVALID_LOCATION' using errcode = 'PT422'; end if;
  if v_lat is not null then
    if v_lat < -90 or v_lat > 90 or v_lon < -180 or v_lon > 180 or v_radius < 100 or v_radius > 50000 then
      raise exception 'INVALID_LOCATION' using errcode = 'PT422';
    end if;
    v_point := extensions.st_setsrid(extensions.st_makepoint(v_lon, v_lat), 4326)::extensions.geography;
  end if;
  if v_min_protein is not null and (v_min_protein < 0 or v_min_protein > 500) then
    raise exception 'INVALID_MIN_PROTEIN' using errcode = 'PT422';
  end if;
  select id into v_market from public.markets where slug = v_market_slug;
  if v_market is null then raise exception 'UNKNOWN_MARKET' using errcode = 'PT422'; end if;
  v_basis_key := case v_basis when 'serving' then 'perServing' when '100g' then 'per100g' else 'per100kcal' end;

  with base as (
    select fi.id as item_id, fi.kind, fi.is_demo, r.id as rev_id, r.name, r.brand, r.published_at,
           v.id as venue_id, v.slug as venue_slug, v.name as venue_name, v.neighborhood, v.locality,
           v.cuisines, v.price_band, v.venue_type,
           case when v_point is not null and v.location is not null
                then extensions.st_distance(v.location, v_point) end as distance_m,
           case when v_q is not null then extensions.similarity(r.name, v_q) else 0 end as relevance
      from public.food_items fi
      join public.food_revisions r on r.id = fi.current_revision_id
      left join public.dishes d on d.food_item_id = fi.id
      left join public.venues v on v.id = d.venue_id
     where fi.visibility = 'public' and fi.status = 'published' and r.published_at is not null
       and (v_demo or not fi.is_demo)
       and (v_kinds is null or fi.kind = any(v_kinds))
       -- A dish is only discoverable at an open, published venue in the selected market (no silent cross-market results).
       and (fi.kind <> 'dish' or (v.status = 'published' and v.market_id = v_market and d.availability_status <> 'retired'))
       and (v_q is null or r.name ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
            or v.name ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
            or v_q = any(v.cuisines)
            or to_tsvector('english', r.name || ' ' || coalesce(r.description, '')) @@ plainto_tsquery('english', v_q))
       and (v_hood is null or v.neighborhood = v_hood)
       and (v_point is null or (v.location is not null and extensions.st_dwithin(v.location, v_point, v_radius)))
       and (v_cuisine is null or v_cuisine = any(v.cuisines))
       and (v_max_price is null or v.price_band <= v_max_price)
       and (v_venue_type is null or v.venue_type = v_venue_type)
       and (v_venue is null or v.id = v_venue)
  ), facts as (
    select b.*, app.protein_facts(b.rev_id, v_estimates) as pf,
           app.eligibility(b.rev_id, v_diet, v_excl, v_incl_cond) as elig
      from base b
  ), grouped as (
    select f.*, (f.pf->>v_basis_key)::numeric as sort_protein,
           case f.elig->>'status'
             when 'excluded' then 'hidden'
             when 'eligible' then 'match'
             when 'conditional' then 'match'      -- only reachable when the person opted in to conditional dishes
             else 'needs_confirmation' end as grp
      from facts f
  ), filtered as (
    -- The minimum-protein filter never treats "unknown" as zero: rows that cannot be compared are set aside and counted.
    select g.*, (v_min_protein is not null and g.sort_protein is null) as not_comparable
      from grouped g
     where v_min_protein is null or g.sort_protein is null or g.sort_protein >= v_min_protein
  ), visible as (
    select * from filtered
     where grp = case v_view when 'matches' then 'match' else 'needs_confirmation' end
       and not not_comparable
  ), ordered as (
    select v.*, row_number() over (
             order by
               case when v_sort = 'protein' then v.sort_protein end desc nulls last,
               case when v_sort = 'default' and v_point is not null then v.distance_m end asc nulls last,
               case when v_sort = 'default' and v_q is not null then v.relevance end desc nulls last,
               v.published_at desc, v.item_id) as rn
      from visible v
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'foodItemId', o.item_id, 'revisionId', o.rev_id, 'kind', o.kind, 'name', o.name, 'brand', o.brand, 'isDemo', o.is_demo,
        'venue', case when o.venue_id is not null then jsonb_build_object(
            'id', o.venue_id, 'slug', o.venue_slug, 'name', o.venue_name, 'neighborhood', o.neighborhood,
            'locality', o.locality, 'cuisines', to_jsonb(o.cuisines), 'priceBand', o.price_band) end,
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'protein', o.pf,
        'eligibility', o.elig,
        'families', coalesce((
            select jsonb_agg(jsonb_build_object('family', fam.code, 'label', fam.label, 'presence', app.family_presence(o.rev_id, fam.code)) order by fam.code)
              from public.ingredient_families fam
             where app.family_presence(o.rev_id, fam.code) <> 'unknown'), '[]'::jsonb)
      ) order by o.rn)
      from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'nextOffset', case when (select count(*) from ordered) > v_offset + v_limit then v_offset + v_limit end,
    'counts', jsonb_build_object(
      'matches', (select count(*) from filtered where grp = 'match' and not not_comparable),
      'needsConfirmation', (select count(*) from filtered where grp = 'needs_confirmation' and not not_comparable),
      'hidden', (select count(*) from filtered where grp = 'hidden'),
      'notComparable', (select count(*) from filtered where not_comparable and grp <> 'hidden')),
    -- Why rows are hidden, without listing them as results.
    'hiddenReasons', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'family', x.family, 'count', x.n) order by x.n desc, x.family)
        from (select reason->>'code' as code, reason->>'family' as family, count(distinct f2.item_id) as n
                from filtered f2, jsonb_array_elements(f2.elig->'reasons') reason
               where f2.grp = 'hidden' and reason->>'code' in ('contains_excluded_family', 'contains_family', 'diet_incompatible')
               group by 1, 2) x), '[]'::jsonb),
    'applied', jsonb_build_object('diet', v_diet, 'exclusions', to_jsonb(v_excl), 'view', v_view, 'basis', v_basis,
                                  'sort', case when v_sort = 'protein' then 'protein'
                                               when v_point is not null then 'distance'
                                               when v_q is not null then 'relevance' else 'freshness' end,
                                  'market', v_market_slug)
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public detail builders (R-D03, R-005). Only published public content is returned.
-- ---------------------------------------------------------------------------
create function public.food_detail(p_food_item_id uuid, p_include_demo boolean default false, p_include_estimates boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  fi public.food_items;
  r public.food_revisions;
  v_result jsonb;
begin
  select * into fi from public.food_items
   where id = p_food_item_id and visibility = 'public' and status = 'published' and (p_include_demo or not is_demo);
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into r from public.food_revisions where id = fi.current_revision_id and published_at is not null;
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;

  select jsonb_build_object(
    'foodItemId', fi.id, 'revisionId', r.id, 'revisionNo', r.revision_no, 'kind', fi.kind, 'isDemo', fi.is_demo,
    'name', r.name, 'brand', r.brand, 'description', r.description, 'publishedAt', r.published_at,
    'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
    'protein', app.protein_facts(r.id, p_include_estimates),
    'venue', (select jsonb_build_object('id', v.id, 'slug', v.slug, 'name', v.name, 'neighborhood', v.neighborhood,
                     'locality', v.locality, 'region', v.region, 'priceBand', v.price_band, 'cuisines', to_jsonb(v.cuisines),
                     'menuSection', d.menu_section, 'availability', d.availability_status)
                from public.dishes d join public.venues v on v.id = d.venue_id
               where d.food_item_id = fi.id and v.status in ('published', 'temporarily_closed', 'closed')),
    'nutrients', (select jsonb_agg(jsonb_build_object(
                     'code', nd.code, 'name', nd.name, 'unit', nd.canonical_unit,
                     'value', case when nv.method = 'estimated' and not p_include_estimates then null else nv.value end,
                     'method', coalesce(nv.method, 'unknown'),
                     'missingReason', case when nv.revision_id is null then 'not_provided'
                                           when nv.method = 'estimated' and not p_include_estimates then 'estimate_hidden'
                                           else nv.missing_reason end,
                     'source', app.source_summary(nv.source_record_id)) order by nd.display_order)
                    from public.nutrient_definitions nd
                    left join public.nutrient_values nv on nv.nutrient_code = nd.code and nv.revision_id = r.id),
    'portions', coalesce((select jsonb_agg(jsonb_build_object('id', po.id, 'label', po.label, 'amount', po.amount, 'unit', po.unit,
                     'grams', coalesce(po.grams, app.unit_to_grams(po.amount, po.unit))) order by po.label)
                    from public.portions po where po.revision_id = r.id), '[]'::jsonb),
    'dietaryClaims', coalesce((select jsonb_agg(jsonb_build_object('diet', c.diet, 'outcome', c.outcome, 'evidenceTier', c.evidence_tier,
                     'modifications', c.modifications, 'checkedAt', c.checked_at, 'expiresAt', c.expires_at,
                     'expired', (c.expires_at is not null and c.expires_at <= now()), 'conflictState', c.conflict_state,
                     'source', app.source_summary(c.source_record_id)) order by c.diet)
                    from public.dietary_claims c where c.revision_id = r.id), '[]'::jsonb),
    'families', (select jsonb_agg(jsonb_build_object('family', fam.code, 'label', fam.label,
                     'presence', app.family_presence(r.id, fam.code),
                     'detail', s.detail, 'checkedAt', s.checked_at, 'expiresAt', s.expires_at,
                     'source', app.source_summary(s.source_record_id)) order by fam.code)
                    from public.ingredient_families fam
                    left join public.ingredient_family_statements s on s.revision_id = r.id and s.family = fam.code),
    'allergens', coalesce((select jsonb_agg(jsonb_build_object('allergen', a.allergen, 'presence', a.presence,
                     'crossContact', a.cross_contact, 'checkedAt', a.checked_at) order by a.allergen)
                    from public.allergen_statements a where a.revision_id = r.id), '[]'::jsonb),
    'prices', coalesce((select jsonb_agg(jsonb_build_object('amountMinor', dp.amount_minor, 'currency', dp.currency,
                     'servingDescription', dp.serving_description, 'checkedAt', dp.checked_at) order by dp.checked_at desc)
                    from public.dish_prices dp where dp.dish_id = fi.id), '[]'::jsonb),
    'recipe', (select jsonb_build_object('yieldServings', rr.yield_servings, 'prepMinutes', rr.prep_minutes,
                     'cookMinutes', rr.cook_minutes, 'equipment', to_jsonb(rr.equipment), 'trialCookedAt', rr.trial_cooked_at,
                     'ingredients', coalesce((select jsonb_agg(jsonb_build_object('position', ri.position, 'name', ir.name,
                           'foodItemId', ir.food_item_id, 'revisionId', ir.id, 'quantity', ri.quantity, 'unit', ri.unit,
                           'optional', ri.optional, 'includedByDefault', ri.included_by_default) order by ri.position)
                          from public.recipe_ingredients ri join public.food_revisions ir on ir.id = ri.ingredient_revision_id
                         where ri.recipe_revision_id = r.id), '[]'::jsonb),
                     'steps', coalesce((select jsonb_agg(jsonb_build_object('ordinal', st.ordinal, 'instruction', st.instruction,
                           'timerSeconds', st.timer_seconds) order by st.ordinal)
                          from public.recipe_steps st where st.recipe_revision_id = r.id), '[]'::jsonb))
                 from public.recipe_revisions rr where rr.food_revision_id = r.id)
  ) into v_result;
  return v_result;
end;
$$;

create function public.venue_detail(p_venue_id uuid, p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.venues;
begin
  select * into v from public.venues
   where id = p_venue_id and status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not is_demo);
  if not found then raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object(
    'id', v.id, 'slug', v.slug, 'name', v.name, 'neighborhood', v.neighborhood, 'street', v.street, 'locality', v.locality,
    'region', v.region, 'postalCode', v.postal_code, 'venueType', v.venue_type, 'status', v.status, 'isDemo', v.is_demo,
    'cuisines', to_jsonb(v.cuisines), 'priceBand', v.price_band, 'reviewedAt', v.reviewed_at,
    -- Coordinates are public venue facts, used only to build an external directions link (R-D05).
    'lat', case when v.location is not null then extensions.st_y(v.location::extensions.geometry) end,
    'lon', case when v.location is not null then extensions.st_x(v.location::extensions.geometry) end,
    'market', (select m.slug from public.markets m where m.id = v.market_id),
    'facts', coalesce((select jsonb_agg(jsonb_build_object('field', f.field, 'value', f.typed_value, 'checkedAt', f.checked_at,
                    'expired', (f.expires_at is not null and f.expires_at <= now()), 'source', app.source_summary(f.source_record_id)) order by f.field)
                 from public.venue_facts f where f.venue_id = v.id), '[]'::jsonb)
  );
end;
$$;

-- Compare up to three public foods on one basis (R-P04).
create function public.protein_compare(p_food_item_ids uuid[], p_include_demo boolean default false, p_include_estimates boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_food_item_ids is null or cardinality(p_food_item_ids) < 1 or cardinality(p_food_item_ids) > 3 then
    raise exception 'COMPARE_ONE_TO_THREE' using errcode = 'PT422';
  end if;
  return coalesce((
    select jsonb_agg(public.food_detail(x.id, p_include_demo, p_include_estimates) order by x.ord)
      from unnest(p_food_item_ids) with ordinality as x(id, ord)), '[]'::jsonb);
end;
$$;

-- Options for filter controls: only values that exist on discoverable venues.
create function public.catalog_filter_options(p_market text default 'boston', p_include_demo boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'neighborhoods', coalesce((select jsonb_agg(distinct v.neighborhood order by v.neighborhood)
        from public.venues v join public.markets m on m.id = v.market_id
       where m.slug = p_market and v.status = 'published' and v.neighborhood is not null and (p_include_demo or not v.is_demo)), '[]'::jsonb),
    'cuisines', coalesce((select jsonb_agg(distinct c order by c)
        from public.venues v join public.markets m on m.id = v.market_id, unnest(v.cuisines) c
       where m.slug = p_market and v.status = 'published' and (p_include_demo or not v.is_demo)), '[]'::jsonb),
    'families', (select jsonb_agg(jsonb_build_object('code', f.code, 'label', f.label) order by f.label) from public.ingredient_families f)
  );
$$;

-- ---------------------------------------------------------------------------
-- Corrections (R-D06): a member proposes a fix. Nothing public changes automatically.
-- ---------------------------------------------------------------------------
create table public.corrections (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid not null references auth.users (id) on delete cascade,
  food_item_id   uuid references public.food_items (id) on delete cascade,
  venue_id       uuid references public.venues (id) on delete cascade,
  field          text not null check (field in ('name', 'ingredients', 'dietary', 'egg', 'dairy', 'allergen', 'nutrition', 'portion', 'price', 'hours', 'closed', 'other')),
  proposed_value text not null check (length(proposed_value) between 3 and 1000),
  evidence_note  text check (evidence_note is null or length(evidence_note) <= 1000),
  state          text not null default 'open' check (state in ('open', 'accepted', 'rejected', 'duplicate')),
  decided_by     uuid references auth.users (id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 1000),
  created_at     timestamptz not null default now(),
  check (num_nonnulls(food_item_id, venue_id) = 1)
);
create index corrections_reporter_idx on public.corrections (reporter_id, created_at desc);
create index corrections_state_idx on public.corrections (state, created_at);
alter table public.corrections enable row level security;
alter table public.corrections force row level security;
revoke all on public.corrections from anon;
-- Members read only their own reports; editors read and decide all. No direct member inserts or edits.
create policy corrections_reporter_read on public.corrections for select to authenticated
  using (reporter_id = (select auth.uid()) or app.is_catalog_editor());
create policy corrections_editor_update on public.corrections for update to authenticated
  using (app.is_catalog_editor()) with check (app.is_catalog_editor());
revoke insert, update, delete on public.corrections from authenticated;
grant select on public.corrections to authenticated;
grant update (state, decided_by, decided_at, decision_note) on public.corrections to authenticated;

create function public.submit_correction(
  p_food_item_id uuid, p_venue_id uuid, p_field text, p_proposed_value text, p_evidence_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if num_nonnulls(p_food_item_id, p_venue_id) <> 1 then raise exception 'CHOOSE_ONE_TARGET' using errcode = 'PT422'; end if;
  if p_food_item_id is not null and not exists (
       select 1 from public.food_items where id = p_food_item_id and visibility = 'public' and status = 'published') then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  if p_venue_id is not null and not exists (
       select 1 from public.venues where id = p_venue_id and status in ('published', 'temporarily_closed', 'closed')) then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404';
  end if;
  -- docs/11: reports 20/day/account.
  if (select count(*) from public.corrections where reporter_id = v_uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'TOO_MANY_REPORTS' using errcode = 'PT429';
  end if;
  begin
    insert into public.corrections (reporter_id, food_item_id, venue_id, field, proposed_value, evidence_note)
    values (v_uid, p_food_item_id, p_venue_id, p_field, btrim(p_proposed_value), nullif(btrim(coalesce(p_evidence_note, '')), ''))
    returning id into v_id;
  exception when check_violation then
    raise exception 'INVALID_CORRECTION' using errcode = 'PT422';
  end;
  perform app.audit('correction_submitted', 'corrections', v_id, 'member report');
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rate limiting that works on serverless hosts (docs/11): a small fixed-window counter.
-- The key is an HMAC computed on the server with a secret salt, so a caller cannot
-- target someone else's bucket and no IP address is stored.
-- ---------------------------------------------------------------------------
create table public.rate_limit_windows (
  bucket       text not null check (bucket ~ '^[a-z0-9_:-]{8,120}$'),
  window_start timestamptz not null,
  hits         integer not null default 1 check (hits > 0),
  primary key (bucket, window_start)
);
alter table public.rate_limit_windows enable row level security;
alter table public.rate_limit_windows force row level security;
revoke all on public.rate_limit_windows from anon, authenticated;

create function public.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_bucket !~ '^[a-z0-9_:-]{8,120}$' or p_limit < 1 or p_limit > 10000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'INVALID_RATE_LIMIT' using errcode = 'PT422';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_windows as w (bucket, window_start) values (p_bucket, v_window)
    on conflict (bucket, window_start) do update set hits = w.hits + 1
    returning hits into v_hits;
  -- Opportunistic cleanup keeps the table small without a scheduler.
  if v_hits = 1 and random() < 0.05 then
    delete from public.rate_limit_windows where window_start < now() - interval '2 days';
  end if;
  return v_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- Saved dishes and places (R-D06). Saves are private rows owned by the member;
-- this returns only the caller's own saves, joined to what is currently public.
-- A saved item that was later withdrawn is counted, not shown.
-- ---------------------------------------------------------------------------
create function public.my_saves(p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  return jsonb_build_object(
    'foods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'foodItemId', fi.id, 'revisionId', r.id, 'kind', fi.kind,
        'name', r.name, 'brand', r.brand, 'isDemo', fi.is_demo,
        'venue', (select jsonb_build_object('id', v.id, 'name', v.name, 'neighborhood', v.neighborhood)
                    from public.dishes d join public.venues v on v.id = d.venue_id where d.food_item_id = fi.id),
        'protein', app.protein_facts(r.id, false)) order by s.created_at desc, s.id)
      from public.saves s
      join public.food_items fi on fi.id = s.food_item_id and fi.visibility = 'public' and fi.status = 'published'
                               and (p_include_demo or not fi.is_demo)
      join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
      where s.owner_id = v_uid), '[]'::jsonb),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'id', v.id, 'name', v.name, 'neighborhood', v.neighborhood,
        'locality', v.locality, 'cuisines', to_jsonb(v.cuisines), 'priceBand', v.price_band, 'isDemo', v.is_demo)
        order by s.created_at desc, s.id)
      from public.saves s
      join public.venues v on v.id = s.venue_id and v.status in ('published', 'temporarily_closed')
                          and (p_include_demo or not v.is_demo)
      where s.owner_id = v_uid), '[]'::jsonb),
    'total', (select count(*) from public.saves s where s.owner_id = v_uid));
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit rows and account deletion (R-007). audit_events.actor_id is declared
-- "on delete set null", but the append-only trigger also blocked that system
-- update, so a member with any audit row could not be deleted. The only change
-- now allowed is clearing actor_id; every other update and every delete is
-- still refused.
-- ---------------------------------------------------------------------------
create function app.audit_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.actor_id is null and old.actor_id is not null
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
    return new;
  end if;
  raise exception 'Table % is append-only', tg_table_name using errcode = 'PT403';
end;
$$;
drop trigger audit_events_append_only on public.audit_events;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function app.audit_events_guard();
revoke execute on function app.audit_events_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grants: everything closed, then exactly what guests and members need.
-- ---------------------------------------------------------------------------
revoke execute on function
  app.protein_facts(uuid, boolean), app.source_summary(uuid),
  public.search_catalog(jsonb), public.food_detail(uuid, boolean, boolean), public.venue_detail(uuid, boolean),
  public.protein_compare(uuid[], boolean, boolean), public.catalog_filter_options(text, boolean),
  public.submit_correction(uuid, uuid, text, text, text), public.rate_limit_hit(text, integer, integer),
  public.my_saves(boolean)
  from public, anon, authenticated;

grant execute on function
  public.search_catalog(jsonb), public.food_detail(uuid, boolean, boolean), public.venue_detail(uuid, boolean),
  public.protein_compare(uuid[], boolean, boolean), public.catalog_filter_options(text, boolean),
  public.rate_limit_hit(text, integer, integer)
  to anon, authenticated;
grant execute on function public.submit_correction(uuid, uuid, text, text, text), public.my_saves(boolean) to authenticated;
