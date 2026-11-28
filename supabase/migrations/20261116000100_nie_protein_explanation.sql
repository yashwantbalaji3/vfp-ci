-- NIE N-4: "How we got this" for a dish's protein figure (plan docs/27 N-4; owner 23:52 UTC: "make
-- certain that users can understand where each protein value came from and how reliable it is").
--
-- One read-only public function that explains the protein value already on a PUBLISHED public dish
-- revision. It adds no data and changes nothing; it reads the same canonical record
-- (public.nutrient_values) that dish pages, Protein Explorer and the diary use, plus, for an engine
-- figure, the permanent calculation record (app.nie_calculations) it was written from.
--
-- States, in the owner's four words:
--   restaurant_published  the restaurant's own published figure (method 'published', a dish)
--   published             the maker's published figure for an ingredient or packaged food
--   calculated            our calculation from restaurant-verified or measured quantities
--   estimated_range       a scenario range from a typical recipe (never a restaurant figure)
--   unknown               nothing reliable on file (null, never 0)
-- plus estimate_hidden: an estimate exists but the visitor has not chosen to see estimates (NIE-C).
-- While hidden, no number, range or ingredient contribution is returned.
--
-- Staging is never read here: staged research facts have no route to this function.

create function public.protein_explanation(p_food_item_id uuid, p_include_demo boolean default false, p_include_estimates boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  fi public.food_items;
  r public.food_revisions;
  nv public.nutrient_values;
  c app.nie_calculations;
  v_state text;
  v_calc jsonb;
begin
  select * into fi from public.food_items
   where id = p_food_item_id and visibility = 'public' and status = 'published' and (p_include_demo or not is_demo);
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into r from public.food_revisions where id = fi.current_revision_id and published_at is not null;
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;

  select * into nv from public.nutrient_values where revision_id = r.id and nutrient_code = 'protein_g';

  v_state := case
    when nv.revision_id is null or nv.value is null then 'unknown'
    when nv.method = 'published' and fi.kind = 'dish' then 'restaurant_published'
    when nv.method = 'published' then 'published'
    when nv.method = 'calculated' then 'calculated'
    when nv.method = 'estimated' and not p_include_estimates then 'estimate_hidden'
    when nv.method = 'estimated' then 'estimated_range'
    else 'unknown' end;

  if nv.calculation_id is not null and v_state in ('calculated', 'estimated_range') then
    select * into c from app.nie_calculations where id = nv.calculation_id;
    select jsonb_build_object(
      'computedAt', c.computed_at,
      'engineVersion', c.engine_version,
      'inputsSha256', c.inputs_sha256,
      'quantityBasis', c.inputs #>> '{model,quantityBasis}',
      'servingBasis', c.inputs #>> '{model,servingBasis}',
      'servingFactorLow', (c.inputs #>> '{model,servingFactorLow}')::numeric,
      'servingFactorHigh', (c.inputs #>> '{model,servingFactorHigh}')::numeric,
      'modelAssumptions', m.assumptions,
      'lines', (select jsonb_agg(jsonb_build_object(
                   'lineNo', (cl ->> 'lineNo')::int,
                   'label', cl ->> 'label',
                   'usdaDescription', uf.description,
                   'fdcId', (cl ->> 'fdcId')::int,
                   'usdaDataset', ur.dataset,
                   'usdaRelease', ur.release_label,
                   'usdaState', il ->> 'usda_state',
                   'weighedAs', il ->> 'weighed_as',
                   'preparation', il ->> 'preparation',
                   'amountBasis', cl ->> 'amountBasis',
                   'grams', (il ->> 'grams')::numeric,
                   'gramsLow', (il ->> 'grams_low')::numeric,
                   'gramsHigh', (il ->> 'grams_high')::numeric,
                   'yieldFactor', (il ->> 'yield_factor')::numeric,
                   'yieldSource', il ->> 'yield_source',
                   'substitutes', jsonb_array_length(coalesce(il -> 'substitutes', '[]'::jsonb)),
                   'proteinG', (cl ->> 'proteinG')::numeric,
                   'lowG', (cl ->> 'lowG')::numeric,
                   'highG', (cl ->> 'highG')::numeric) order by (cl ->> 'lineNo')::int)
                  from jsonb_array_elements(c.lines) cl
                  join lateral (select x from jsonb_array_elements(c.inputs -> 'lines') x
                                 where (x ->> 'line_no')::int = (cl ->> 'lineNo')::int) li(il) on true
                  left join app.usda_releases ur on ur.id = (il ->> 'usda_release_id')::uuid
                  left join app.usda_foods uf on uf.release_id = ur.id and uf.fdc_id = (cl ->> 'fdcId')::int),
      'references', (select jsonb_agg(distinct jsonb_build_object('dataset', ur.dataset, 'release', ur.release_label,
                                        'sourceUrl', ur.source_url, 'contentSha256', ur.content_sha256))
                       from jsonb_array_elements(c.inputs -> 'releases') rel
                       join app.usda_releases ur on ur.id = (rel ->> 'id')::uuid))
      into v_calc
      from app.nie_dish_models m where m.id = c.model_id;
  end if;

  return jsonb_build_object(
    'foodItemId', fi.id,
    'revisionId', r.id,
    'state', v_state,
    'value', case when v_state in ('restaurant_published', 'published', 'calculated', 'estimated_range') then nv.value end,
    'low', case when v_state = 'estimated_range' then nv.lower_value end,
    'high', case when v_state = 'estimated_range' then nv.upper_value end,
    'confidence', case when v_state = 'estimated_range' then nv.confidence end,
    'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
    'missingReason', case when v_state = 'unknown' then coalesce(nv.missing_reason, 'not_provided') end,
    'assumptions', case when v_state in ('restaurant_published', 'published', 'calculated', 'estimated_range') then nv.assumptions end,
    'source', case when v_state in ('restaurant_published', 'published', 'calculated', 'estimated_range') then app.source_summary(nv.source_record_id) end,
    'calculation', v_calc);
end;
$$;

revoke all on function public.protein_explanation(uuid, boolean, boolean) from public;
grant execute on function public.protein_explanation(uuid, boolean, boolean) to anon, authenticated;
