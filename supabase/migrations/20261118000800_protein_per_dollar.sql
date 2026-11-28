-- Protein per dollar in Protein Explorer (owner 18 Nov 2026 02:27 UTC, item 7; docs/20 MJ4 and test 8; docs/53).
--
-- search_catalog learns one more sort, 'protein_per_dollar'. A dish is ranked only when BOTH:
--   - its protein per serving is published or calculated (never an estimate, even when estimates are shown), and
--   - it has a dated price with a source (public.dish_prices; the newest check is used).
-- Rank = grams of protein per serving / price in dollars. Everything else is not ranked and is counted
-- in counts.notPricedComparable, so the page can say how many were left out and why.
-- Every item also carries 'price' (newest dated price or null) and 'proteinPerDollar' (null unless it can
-- be ranked). Existing fields, sorts and counts are unchanged.
-- Patched from the current definition; the migration fails if any expected text has moved.
do $mig$
declare
  d text;
  before text;
  procedure_step text;
begin
  d := pg_get_functiondef('public.search_catalog(jsonb)'::regprocedure);

  procedure_step := 'sort check';
  before := d;
  d := replace(d, $x$if v_sort not in ('default', 'protein') then$x$, $x$if v_sort not in ('default', 'protein', 'protein_per_dollar') then$x$);
  if d = before then raise exception 'search_catalog: % text not found', procedure_step; end if;

  procedure_step := 'priced step';
  before := d;
  d := replace(d,
    $x$  ), ordered as (
    select v.*, row_number() over (
             order by
               case when v_sort = 'protein' then v.sort_protein end desc nulls last,$x$,
    $x$  ), priced as (
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
               case when v_sort = 'protein' then v.sort_protein end desc nulls last,$x$);
  if d = before then raise exception 'search_catalog: % text not found', procedure_step; end if;

  procedure_step := 'ordered source';
  before := d;
  d := replace(d, $x$               v.published_at desc, v.item_id) as rn
      from visible v$x$, $x$               v.published_at desc, v.item_id) as rn
      from priced v$x$);
  if d = before then raise exception 'search_catalog: % text not found', procedure_step; end if;

  procedure_step := 'item fields';
  before := d;
  d := replace(d, $x$        'protein', o.pf,$x$, $x$        'protein', o.pf,
        'price', o.price,
        'proteinPerDollar', o.ppd,$x$);
  if d = before then raise exception 'search_catalog: % text not found', procedure_step; end if;

  procedure_step := 'counts';
  before := d;
  d := replace(d, $x$      'notComparable', (select count(*) from filtered where not_comparable and grp <> 'hidden')),$x$,
    $x$      'notComparable', (select count(*) from filtered where not_comparable and grp <> 'hidden'),
      'notPricedComparable', (select count(*) from priced where ppd is null)),$x$);
  if d = before then raise exception 'search_catalog: % text not found', procedure_step; end if;

  procedure_step := 'applied sort';
  before := d;
  d := replace(d, $x$'sort', case when v_sort = 'protein' then 'protein'$x$,
    $x$'sort', case when v_sort = 'protein' then 'protein' when v_sort = 'protein_per_dollar' then 'protein_per_dollar'$x$);
  if d = before then raise exception 'search_catalog: % text not found', procedure_step; end if;

  execute d;
end;
$mig$;

-- Rollback: re-run the search_catalog definition from 20261115000600_map1_search_and_map.sql
-- (no data changes either way).
