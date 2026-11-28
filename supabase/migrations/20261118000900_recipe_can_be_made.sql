-- "Can be made vegan" (and the same for any dietary filter): BACKLOG FUT-01, owner request 14 Nov 2026
-- 08:04 UTC, scheduled under owner approval 18 Nov 02:27 UTC item 7 (recipes). docs/55.
--
-- A recipe that does not fit the member's filter as written, but where a combination of the recipe's own
-- reviewed alternatives (its substitution groups) makes it fit, is returned in a separate group,
-- 'canBeMade', with the swaps named. It is never counted with, listed among or labelled like the recipes
-- that already fit. The check is the existing variant rule (app.variant_eligibility): every ingredient in
-- use is checked on its own evidence and the worst result wins. Only a combination whose result is
-- 'eligible' (or 'conditional' when the member includes conditional matches) qualifies; an unknown or
-- unconfirmed ingredient never does. The combination with the fewest swaps is offered.

-- The fewest swaps that make the recipe fit, or null. At most 64 combinations are tried.
create function app.recipe_can_be_made(
  p_recipe_revision_id uuid, p_diet text, p_exclusions text[], p_include_conditional boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_combos jsonb := jsonb_build_array('{}'::jsonb);  -- each element: {group: recipe_ingredient_id} for groups swapped
  v_next jsonb;
  g record;
  c jsonb;
  alt record;
  v_status text;
  v_best jsonb;
begin
  for g in select ri.substitution_group as grp
             from public.recipe_ingredients ri
            where ri.recipe_revision_id = p_recipe_revision_id and ri.substitution_group is not null
            group by ri.substitution_group
            order by ri.substitution_group loop
    v_next := '[]'::jsonb;
    for c in select * from jsonb_array_elements(v_combos) loop
      v_next := v_next || jsonb_build_array(c);  -- keep the default for this group
      for alt in select ri.id from public.recipe_ingredients ri
                  where ri.recipe_revision_id = p_recipe_revision_id and ri.substitution_group = g.grp and not ri.included_by_default
                  order by ri.position, ri.id loop
        v_next := v_next || jsonb_build_array(c || jsonb_build_object(g.grp, alt.id));
      end loop;
    end loop;
    if jsonb_array_length(v_next) > 64 then return null; end if;
    v_combos := v_next;
  end loop;

  -- Fewest swaps first; ties in a stable order.
  for c in select x from jsonb_array_elements(v_combos) x
            where x <> '{}'::jsonb
            order by (select count(*) from jsonb_object_keys(x)), x::text loop
    v_status := app.variant_eligibility(p_recipe_revision_id, c, p_diet, p_exclusions, p_include_conditional) ->> 'status';
    if v_status = 'eligible' or (v_status = 'conditional' and p_include_conditional) then
      v_best := c;
      exit;
    end if;
  end loop;
  if v_best is null then return null; end if;

  return jsonb_build_object(
    'swaps', v_best,
    'named', (select jsonb_agg(jsonb_build_object('group', d.substitution_group, 'from', dr.name, 'to', ar.name) order by d.position)
                from jsonb_each_text(v_best) s
                join public.recipe_ingredients a on a.id = s.value::uuid
                join public.food_revisions ar on ar.id = a.ingredient_revision_id
                join public.recipe_ingredients d on d.recipe_revision_id = p_recipe_revision_id
                                                and d.substitution_group = s.key and d.included_by_default
                join public.food_revisions dr on dr.id = d.ingredient_revision_id));
end;
$$;
revoke execute on function app.recipe_can_be_made(uuid, text, text[], boolean) from public, anon, authenticated;

-- recipe_list: recipes that are hidden or need confirmation as written, but fit with approved swaps, are also
-- returned in their own list, 'canBeMade'. Every existing group and count keeps its meaning: such a recipe is
-- still counted as hidden (or needing confirmation) as written, and is never a match. Only when a dietary
-- filter or exclusion is set. Patched from the current definition.
do $mig$
declare
  d text;
  before text;
  step text;
begin
  d := pg_get_functiondef('public.recipe_list(jsonb)'::regprocedure);

  step := 'can be made';
  before := d;
  d := replace(d,
    $x$      from base b
     -- "Unknown" protein$x$,
    $x$      from (select b0.*,
                   case when (v_diet <> 'none' or cardinality(v_excl) > 0)
                             and (b0.elig->>'status' = 'excluded'
                                  or (b0.elig->>'status' not in ('eligible', 'conditional')))
                        then app.recipe_can_be_made(b0.rev_id, v_diet, v_excl, v_incl_cond) end as cbm
              from base b0) b
     -- "Unknown" protein$x$);
  if d = before then raise exception 'recipe_list: % text not found', step; end if;

  step := 'items';
  before := d;
  d := replace(d,
    $x$    'counts', jsonb_build_object(
      'matches', (select count(*) from grouped where grp = 'match' and not not_comparable),$x$,
    $x$    -- Never mixed into 'items' or 'matches': its own list and count.
    'canBeMade', case when v_view = 'matches' then coalesce((
      select jsonb_agg(jsonb_build_object(
               'foodItemId', g.item_id, 'revisionId', g.rev_id, 'name', g.name, 'description', g.description, 'isDemo', g.is_demo,
               'mealTypes', to_jsonb(g.meal_types), 'cuisine', g.cuisine,
               'prepMinutes', g.prep_minutes, 'cookMinutes', g.cook_minutes, 'yieldServings', g.yield_servings,
               'swaps', g.cbm -> 'swaps', 'swapNames', g.cbm -> 'named', 'asWritten', g.elig)
             order by g.name)
        from grouped g where g.cbm is not null and not g.not_comparable), '[]'::jsonb) else '[]'::jsonb end,
    'counts', jsonb_build_object(
      'canBeMade', (select count(*) from grouped where cbm is not null and not not_comparable),
      'matches', (select count(*) from grouped where grp = 'match' and not not_comparable),$x$);
  if d = before then raise exception 'recipe_list: % text not found', step; end if;

  execute d;
end;
$mig$;

-- Rollback: re-run public.recipe_list from 20261114000200_m4_recipes_cooking.sql and drop
-- app.recipe_can_be_made(uuid, text, text[], boolean). No data changes.
