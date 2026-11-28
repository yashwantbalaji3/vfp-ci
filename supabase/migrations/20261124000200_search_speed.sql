-- Protein Explorer speed (owner directive 24 Nov 2026 14:59 UTC, 1D). Profiling search_catalog on the real local data
-- (pg_stat_user_functions, one Protein Explorer request) showed 14,584 calls to app.direct_family_presence taking about
-- 450 of 540 ms: each row's ingredient families were worked out twice, and inside app.family_presence each recipe
-- ingredient was asked twice. Both now ask once. The answers are the same; only the repeated work is gone.
--
-- Rollback: re-run search_catalog from 20261115000600_map1_search_and_map.sql and app.family_presence from
-- 20261113000500_engine_functions.sql.

CREATE OR REPLACE FUNCTION app.family_presence(p_revision_id uuid, p_family text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_direct text := app.direct_family_presence(p_revision_id, p_family);
  v_count integer;
  v_present boolean;
  v_unknown boolean;
begin
  if v_direct = 'present' then
    return 'present';
  end if;
  -- Each ingredient's presence is asked once (it was asked twice: once for "present", once for "unknown").
  select count(*), bool_or(x.presence = 'present'), bool_or(x.presence = 'unknown')
    into v_count, v_present, v_unknown
    from (select app.direct_family_presence(ri.ingredient_revision_id, p_family) as presence
            from public.recipe_ingredients ri
           where ri.recipe_revision_id = p_revision_id
             and (not ri.optional or ri.included_by_default)
          offset 0) x;
  if v_count = 0 then
    return v_direct;                         -- not a recipe (or no included ingredients)
  end if;
  if v_present then return 'present'; end if;
  if v_unknown then return 'unknown'; end if;  -- a recipe-level "absent" cannot override an unknown ingredient
  return 'absent_by_statement';
end;
$function$;

CREATE OR REPLACE FUNCTION public.search_catalog(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_market_slug text := coalesce(p->>'market', 'boston');
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_diet text := coalesce(p->>'diet', 'none');
  v_excl text[] := case when p ? 'exclusions' and jsonb_typeof(p->'exclusions') = 'array'
                        then array(select jsonb_array_elements_text(p->'exclusions')) else '{}'::text[] end;
  v_view text := coalesce(p->>'view', 'matches');
  v_has_point boolean := (p->>'lat') is not null;
  v_basis text := coalesce(p->>'basis', 'serving');
  v_sort text := coalesce(p->>'sort', 'default');
  v_limit integer := coalesce((p->>'limit')::integer, 20);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_view not in ('matches', 'needs_confirmation') then raise exception 'INVALID_VIEW' using errcode = 'PT422'; end if;
  if v_basis not in ('serving', '100g', '100kcal') then raise exception 'INVALID_BASIS' using errcode = 'PT422'; end if;
  if v_sort not in ('default', 'protein', 'protein_per_dollar') then raise exception 'INVALID_SORT' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > 50 then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;

  with filtered as materialized (
    select * from app.catalog_candidates(p)
  ), visible as (
    select * from filtered
     where grp = case v_view when 'matches' then 'match' else 'needs_confirmation' end
       and not not_comparable
  ), priced as (
    -- The newest dated, sourced price of each dish, and protein per dollar where both numbers are sourced.
    select v.*, pr.price, case when v.kind = 'dish' and pr.price is not null
                                    and v.pf->>'method' in ('published', 'calculated')
                                    and (v.pf->>'perServing') is not null
                               then round((v.pf->>'perServing')::numeric / ((pr.price->>'amountMinor')::numeric / 100), 2) end as ppd
      from visible v
      left join lateral (
        select jsonb_build_object('amountMinor', dp.amount_minor, 'currency', dp.currency,
                                  'servingDescription', dp.serving_description, 'checkedAt', dp.checked_at) as price
          from public.dish_prices dp
         where dp.dish_id = v.item_id
         order by dp.checked_at desc, dp.id
         limit 1) pr on true
  ), ordered as (
    select v.*, row_number() over (
             order by
               case when v_sort = 'protein_per_dollar' then v.ppd end desc nulls last,
               case when v_sort = 'protein' then v.sort_protein end desc nulls last,
               case when v_sort = 'default' and v_has_point then v.distance_m end asc nulls last,
               case when v_sort = 'default' and v_q is not null then v.relevance end desc nulls last,
               v.published_at desc, v.item_id) as rn
      from priced v
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
        'price', o.price,
        'proteinPerDollar', o.ppd,
        'eligibility', o.elig,
        -- Each family's presence is worked out once per row (it was asked twice: once to filter, once to show).
        'families', coalesce((
            select jsonb_agg(jsonb_build_object('family', fp.code, 'label', fp.label, 'presence', fp.presence) order by fp.code)
              from (select fam.code, fam.label, app.family_presence(o.rev_id, fam.code) as presence
                      from public.ingredient_families fam offset 0) fp
             where fp.presence <> 'unknown'), '[]'::jsonb)
      ) order by o.rn)
      from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'nextOffset', case when (select count(*) from ordered) > v_offset + v_limit then v_offset + v_limit end,
    'counts', jsonb_build_object(
      'matches', (select count(*) from filtered where grp = 'match' and not not_comparable),
      'needsConfirmation', (select count(*) from filtered where grp = 'needs_confirmation' and not not_comparable),
      'hidden', (select count(*) from filtered where grp = 'hidden'),
      'notComparable', (select count(*) from filtered where not_comparable and grp <> 'hidden'),
      'notPricedComparable', (select count(*) from priced where ppd is null)),
    -- Why rows are hidden, without listing them as results.
    'hiddenReasons', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'family', x.family, 'count', x.n) order by x.n desc, x.family)
        from (select reason->>'code' as code, reason->>'family' as family, count(distinct f2.item_id) as n
                from filtered f2, jsonb_array_elements(f2.elig->'reasons') reason
               where f2.grp = 'hidden' and reason->>'code' in ('contains_excluded_family', 'contains_family', 'diet_incompatible')
               group by 1, 2) x), '[]'::jsonb),
    'applied', jsonb_build_object('diet', v_diet, 'exclusions', to_jsonb(v_excl), 'view', v_view, 'basis', v_basis,
                                  'sort', case when v_sort = 'protein' then 'protein' when v_sort = 'protein_per_dollar' then 'protein_per_dollar'
                                               when v_has_point then 'distance'
                                               when v_q is not null then 'relevance' else 'freshness' end,
                                  'market', v_market_slug)
  ) into v_result;
  return v_result;
end;
$function$;
