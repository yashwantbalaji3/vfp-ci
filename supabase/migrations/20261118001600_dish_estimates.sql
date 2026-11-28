-- USDA protein estimates for drafted complete meals (docs/58, owner direction 18 Nov 2026 20:56 UTC).
--
-- A drafted complete meal that has no protein figure from the restaurant can be linked to a nutrition
-- engine model (docs/24): ingredient lines that point at sealed USDA FoodData Central foods, with typical
-- gram ranges and written assumptions. The link records which evidence named the ingredients (the
-- restaurant's own listed ingredients, or the dish's printed name). A meal whose ingredients are not
-- known well enough is linked to no model at all and carries a reason instead: unknown stays unknown.
--
-- * An estimate is never staged as a published nutrition fact and never confirms or verifies anything.
-- * A meal with any restaurant protein figure (single value, range or the restaurant's own estimate)
--   cannot get a USDA estimate: the restaurant's figure wins.
-- * Only "editorial_typical" models can be linked, so every result is an estimated range (or unknown),
--   never "calculated". The model stays a draft until a second person reviews its assumptions.
-- * Dietary status is never derived from an estimate, a model or a dish name.
-- * The founder's menu review shows the range beside the published facts, labelled as a USDA estimate
--   with its assumptions. Nothing here is public.
--
-- The protein arithmetic moves out of app.nie_calculate into app.nie_protein_math so that a draft
-- model can be previewed with exactly the same rules; nie_calculate still records results only for
-- published models and gives the same answers as before.

-- 1. The arithmetic, shared by previews and recorded calculations.
create function app.nie_protein_math(p_model uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m app.nie_dish_models;
  l app.nie_model_lines;
  s jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_central numeric := 0;
  v_low numeric := 0;
  v_high numeric := 0;
  v_reason text;
  v_c numeric; v_lo numeric; v_hi numeric; v_alt_lo numeric; v_alt_hi numeric;
  v_any_typical boolean := false;
  v_state text;
  v_conf text;
  v_ratio numeric;
begin
  select * into m from app.nie_dish_models where id = p_model;
  if m.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;

  for l in select * from app.nie_model_lines where model_id = m.id order by line_no loop
    v_any_typical := v_any_typical or l.amount_basis = 'typical';
    v_c  := app.nie_line_amount(l.usda_release_id, l.fdc_id, l.usda_state, l.weighed_as, l.yield_factor, l.grams);
    v_lo := app.nie_line_amount(l.usda_release_id, l.fdc_id, l.usda_state, l.weighed_as, l.yield_factor, l.grams_low);
    v_hi := app.nie_line_amount(l.usda_release_id, l.fdc_id, l.usda_state, l.weighed_as, l.yield_factor, l.grams_high);
    if v_c is null then
      v_reason := case when l.weighed_as <> l.usda_state and l.yield_factor is null then 'missing_yield_factor' else 'missing_reference_value' end;
    end if;
    -- Each named substitution can replace this ingredient: the range covers all of them.
    for s in select * from jsonb_array_elements(l.substitutes) loop
      v_alt_lo := app.nie_line_amount((s ->> 'usdaReleaseId')::uuid, (s ->> 'fdcId')::integer, s ->> 'usdaState', l.weighed_as, (s ->> 'yieldFactor')::numeric, l.grams_low);
      v_alt_hi := app.nie_line_amount((s ->> 'usdaReleaseId')::uuid, (s ->> 'fdcId')::integer, s ->> 'usdaState', l.weighed_as, (s ->> 'yieldFactor')::numeric, l.grams_high);
      if v_alt_lo is null or v_alt_hi is null then
        v_reason := coalesce(v_reason, case when l.weighed_as <> (s ->> 'usdaState') and s ->> 'yieldFactor' is null then 'missing_yield_factor' else 'missing_reference_value' end);
      else
        v_lo := least(v_lo, v_alt_lo);
        v_hi := greatest(v_hi, v_alt_hi);
        v_any_typical := true; -- a possible substitution is an assumption, never a verified quantity
      end if;
    end loop;
    v_lines := v_lines || jsonb_build_object('lineNo', l.line_no, 'label', l.label, 'fdcId', l.fdc_id, 'amountBasis', l.amount_basis,
                                             'grams', l.grams, 'proteinG', v_c, 'lowG', v_lo, 'highG', v_hi);
    v_central := v_central + coalesce(v_c, 0);
    v_low := v_low + coalesce(v_lo, 0);
    v_high := v_high + coalesce(v_hi, 0);
  end loop;

  v_any_typical := v_any_typical or m.serving_basis = 'typical';
  v_low := v_low * m.serving_factor_low;
  v_high := v_high * m.serving_factor_high;

  if v_reason is not null then
    v_state := 'unknown';
  elsif m.quantity_basis = 'restaurant_verified' and not v_any_typical then
    v_state := 'calculated';
  else
    -- NIE-E: anything resting on a typical amount, typical serving or substitution is an estimate.
    v_ratio := case when v_low > 0 then v_high / v_low end;
    if v_ratio is null and v_high > 0 or v_ratio > app.nie_setting('max_range_ratio') then
      v_state := 'unknown'; v_reason := 'range_too_wide';
    else
      v_state := 'estimated';
      v_conf := case when coalesce(v_ratio, 1) <= app.nie_setting('confidence_high_ratio') then 'high'
                     when v_ratio <= app.nie_setting('confidence_medium_ratio') then 'medium' else 'low' end;
    end if;
  end if;

  -- trim_scale: keep exact decimals without trailing zeros (13.53, not 13.5300000000000000).
  return jsonb_build_object(
    'state', v_state,
    'central', case when v_state <> 'unknown' then trim_scale(v_central) end,
    'low', case when v_state = 'estimated' then trim_scale(v_low) end,
    'high', case when v_state = 'estimated' then trim_scale(v_high) end,
    'confidence', v_conf,
    'reason', v_reason,
    'lines', v_lines);
end;
$$;
revoke all on function app.nie_protein_math(uuid) from public, anon, authenticated;

create or replace function app.nie_calculate(p_model uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_engine constant text := 'nie-v1-calc-1';
  m app.nie_dish_models;
  v_inputs jsonb;
  v_sha text;
  v_id uuid;
  r jsonb;
begin
  select * into m from app.nie_dish_models where id = p_model;
  if m.id is null then raise exception 'NIE_NOT_FOUND' using errcode = 'PT404'; end if;
  if m.status <> 'published' then raise exception 'NIE_MODEL_NOT_PUBLISHED' using errcode = 'PT409'; end if;

  -- Every input that can change the answer, in one canonical JSON value.
  v_inputs := jsonb_build_object(
    'engine', c_engine,
    'model', jsonb_build_object('id', m.id, 'quantityBasis', m.quantity_basis, 'servingBasis', m.serving_basis,
                                'servingFactorLow', m.serving_factor_low, 'servingFactorHigh', m.serving_factor_high),
    'lines', (select jsonb_agg(to_jsonb(x) - 'model_id' order by x.line_no) from app.nie_model_lines x where x.model_id = m.id),
    'releases', (select jsonb_agg(distinct jsonb_build_object('id', rl.id, 'contentSha256', rl.content_sha256))
                   from app.nie_model_lines x join app.usda_releases rl on rl.id = x.usda_release_id where x.model_id = m.id),
    'settings', (select jsonb_object_agg(key, value) from app.nie_settings));
  v_sha := encode(extensions.digest(v_inputs::text, 'sha256'), 'hex');
  select id into v_id from app.nie_calculations where model_id = m.id and nutrient_code = 'protein_g' and inputs_sha256 = v_sha;
  if v_id is not null then return v_id; end if;

  r := app.nie_protein_math(m.id);
  insert into app.nie_calculations (model_id, nutrient_code, engine_version, inputs, inputs_sha256, state, central, low, high, confidence, reason, lines)
  values (m.id, 'protein_g', c_engine, v_inputs, v_sha, r ->> 'state', (r ->> 'central')::numeric, (r ->> 'low')::numeric,
          (r ->> 'high')::numeric, r ->> 'confidence', r ->> 'reason', r -> 'lines')
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function app.nie_calculate(uuid) from public, anon, authenticated;

-- 2. The link from a drafted dish to its estimate (or to "unknown", with the reason). Append-only:
--    a new row replaces the old one and the history stays.
create table staging.dish_estimates (
  id                  bigint generated always as identity primary key,
  dish_id             uuid not null,
  place_id            uuid not null,
  model_id            uuid references app.nie_dish_models (id),
  ingredient_evidence text check (ingredient_evidence in ('listed_ingredients', 'dish_name', 'listed_ingredients_and_dish_name')),
  unknown_reason      text check (unknown_reason is null or length(unknown_reason) between 3 and 300),
  created_by          uuid not null,
  created_at          timestamptz not null default clock_timestamp(),
  foreign key (dish_id, place_id) references staging.dishes (id, place_id),
  check ((model_id is null) = (unknown_reason is not null)),
  check ((model_id is null) = (ingredient_evidence is null))
);
create index dish_estimates_dish on staging.dish_estimates (dish_id, created_at desc, id desc);
alter table staging.dish_estimates enable row level security;
alter table staging.dish_estimates force row level security;
revoke all on staging.dish_estimates from public, anon, authenticated;
create trigger dish_estimates_append_only before update or delete on staging.dish_estimates
  for each row execute function staging.guard_confirmations_append_only();

create function staging.current_estimate(p_dish uuid)
returns staging.dish_estimates
language sql
stable
set search_path = ''
as $$
  select e.* from staging.dish_estimates e where e.dish_id = p_dish order by e.created_at desc, e.id desc limit 1;
$$;
revoke all on function staging.current_estimate(uuid) from public, anon, authenticated;

-- Whether the restaurant itself gives a protein figure for the dish (any basis, still standing).
create function staging.has_restaurant_protein(p_dish uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from staging.facts f
                  where f.dish_id = p_dish and f.kind = 'published_nutrition' and f.subject = 'protein_g'
                    and f.value is not null and f.status in ('submitted', 'verified'));
$$;
revoke all on function staging.has_restaurant_protein(uuid) from public, anon, authenticated;

alter table staging.events drop constraint events_action_check;
alter table staging.events add constraint events_action_check
  check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact',
                    'set_place_status', 'prepare_publication', 'link_catalog', 'unlink_catalog', 'request_correction',
                    'confirm_transcription', 'classify_dish', 'add_dish_option', 'link_estimate'));

create function staging.link_dish_estimate(p_actor uuid, p_dish uuid, p_model uuid, p_evidence text default null,
                                           p_unknown_reason text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_place uuid;
  m app.nie_dish_models;
  v_id bigint;
begin
  perform staging.require_role(p_actor, 'curator');
  select place_id into v_place from staging.dishes where id = p_dish;
  if v_place is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if (staging.current_structure(p_dish)).dish_type is distinct from 'complete_meal' then
    raise exception 'STAGING_NOT_A_COMPLETE_MEAL' using errcode = 'PT422';
  end if;
  if staging.has_restaurant_protein(p_dish) then
    raise exception 'STAGING_HAS_RESTAURANT_PROTEIN' using errcode = 'PT422';
  end if;
  if p_model is null then
    if nullif(trim(p_unknown_reason), '') is null then raise exception 'STAGING_UNKNOWN_NEEDS_REASON' using errcode = 'PT422'; end if;
  else
    if p_unknown_reason is not null then raise exception 'STAGING_MODEL_OR_REASON' using errcode = 'PT422'; end if;
    select * into m from app.nie_dish_models where id = p_model;
    if m.id is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
    -- Typical amounts only: a USDA estimate never claims the restaurant's own quantities.
    if m.quantity_basis <> 'editorial_typical' then raise exception 'STAGING_ESTIMATE_NOT_TYPICAL' using errcode = 'PT422'; end if;
    if nullif(trim(m.assumptions), '') is null then raise exception 'STAGING_ESTIMATE_NEEDS_ASSUMPTIONS' using errcode = 'PT422'; end if;
    if p_evidence is null then raise exception 'STAGING_ESTIMATE_NEEDS_EVIDENCE' using errcode = 'PT422'; end if;
    -- "Listed ingredients" must really be on file for this dish.
    if p_evidence like 'listed_ingredients%' and not exists (
         select 1 from staging.facts f where f.dish_id = p_dish and f.kind = 'listed_ingredients'
            and f.value is not null and f.status in ('submitted', 'verified')) then
      raise exception 'STAGING_NO_LISTED_INGREDIENTS' using errcode = 'PT422';
    end if;
  end if;
  insert into staging.dish_estimates (dish_id, place_id, model_id, ingredient_evidence, unknown_reason, created_by)
  values (p_dish, v_place, p_model, case when p_model is not null then p_evidence end, nullif(trim(p_unknown_reason), ''), p_actor)
  returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'link_estimate', v_place, jsonb_build_object('dishId', p_dish, 'model', p_model, 'evidence', p_evidence,
                                                                'unknown', p_model is null));
  return v_id;
end;
$$;
revoke all on function staging.link_dish_estimate(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- The estimate as the founder's review shows it.
create function staging.estimate_json(p_dish uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when e.id is null then null
    when e.model_id is null then jsonb_build_object('state', 'unknown', 'reason', e.unknown_reason, 'at', e.created_at)
    else jsonb_build_object(
      'state', 'modelled', 'modelId', e.model_id, 'evidence', e.ingredient_evidence, 'at', e.created_at,
      'modelStatus', m.status, 'assumptions', m.assumptions, 'servingBasis', m.serving_basis,
      'servingFactorLow', m.serving_factor_low, 'servingFactorHigh', m.serving_factor_high,
      'lines', (select jsonb_agg(jsonb_build_object('label', l.label, 'fdcId', l.fdc_id, 'usda', uf.description,
                                                    'release', r.dataset || ' ' || r.release_label,
                                                    'grams', l.grams, 'gramsLow', l.grams_low, 'gramsHigh', l.grams_high,
                                                    'amountBasis', l.amount_basis) order by l.line_no)
                  from app.nie_model_lines l
                  join app.usda_foods uf on uf.release_id = l.usda_release_id and uf.fdc_id = l.fdc_id
                  join app.usda_releases r on r.id = l.usda_release_id
                 where l.model_id = e.model_id),
      'result', app.nie_protein_math(e.model_id) - 'lines')
  end
  from staging.current_estimate(p_dish) e
  left join app.nie_dish_models m on m.id = e.model_id;
$$;
revoke all on function staging.estimate_json(uuid) from public, anon, authenticated;

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
               'estimate', staging.estimate_json(d.id),
               'facts', coalesce((select jsonb_agg(public.menu_review_fact_json(f, v_me) order by f.kind, f.subject nulls first, f.entered_at)
                                    from staging.facts f where f.dish_id = d.id and f.status in ('submitted', 'verified')), '[]'::jsonb),
               'corrections', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'subject', c.subject, 'corrected', c.corrected, 'at', c.at))
                                          from staging.open_corrections() c join staging.facts cf on cf.id = c.fact_id
                                         where cf.dish_id = d.id), '[]'::jsonb))
             order by d.label)
        from staging.dishes d where d.place_id = p.id), '[]'::jsonb));
end;
$$;

-- Rollback: re-run menu_review_place from 20261118001500 and nie_calculate from 20261115001000; drop
-- staging.estimate_json, staging.link_dish_estimate, staging.has_restaurant_protein, staging.current_estimate,
-- the dish_estimates table and app.nie_protein_math. Events are append-only, so events_action_check keeps
-- 'link_estimate' once any has been recorded. Draft models made for estimates stay as unpublished drafts.
