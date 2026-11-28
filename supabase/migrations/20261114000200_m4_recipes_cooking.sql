-- M4: Recipes and Cooking (R-C01 to R-C07, docs/04, docs/07, plans/2026-11-14-m4-implementation-plan.md).
--
-- Rules this file enforces in the database, so no screen can get them wrong:
--   * A recipe's numbers are the sum of its ingredients. An ingredient whose amount or
--     nutrient is unknown makes that nutrient unknown for the recipe. Never zero.
--   * Changing servings scales ingredient amounts. Per-serving numbers do not change.
--   * A substitution is only possible inside a group a curator approved. After a swap the
--     nutrition is recalculated from the ingredients actually used and the dietary result is
--     worked out again from those ingredients. Nothing is inherited from the recipe as written.
--   * The strict dietary rule is the same as in Discover: confirmed matches by default,
--     "needs confirmation" only when asked for, "contains" never listed.
--   * Finishing a cook session never writes to the diary. The diary changes only when the
--     member says how much they ate. One cooked meal counts once toward the home-cooking goal.
--   * Cook sessions, plans and saves are private to their owner.

-- ---------------------------------------------------------------------------
-- 1. Schema additions
-- ---------------------------------------------------------------------------
alter table public.recipe_revisions
  add column meal_types text[] not null default '{}'
    check (meal_types <@ array['breakfast', 'lunch', 'dinner', 'snack']),
  add column cuisine text check (cuisine is null or cuisine in ('indian', 'asian', 'mediterranean', 'everyday')),
  add column serving_note text check (serving_note is null or length(serving_note) <= 200);

alter table public.recipe_ingredients
  add column prep_note text check (prep_note is null or length(prep_note) <= 200),
  add column substitution_note text check (substitution_note is null or length(substitution_note) <= 300);
-- Inside a substitution group exactly one row is the recipe as written.
create unique index recipe_ingredients_one_default_per_group
  on public.recipe_ingredients (recipe_revision_id, substitution_group)
  where substitution_group is not null and included_by_default;
alter table public.recipe_ingredients
  add constraint recipe_ingredients_group_shape
  check (substitution_group is null or (substitution_group ~ '^[a-z][a-z0-9_]{0,39}$' and optional = not included_by_default));

alter table public.recipe_steps
  add column title text check (title is null or length(title) between 1 and 80);

alter table public.cook_sessions
  add column servings numeric not null default 1 check (servings > 0 and servings <= 100),
  add column swaps jsonb not null default '{}'::jsonb check (jsonb_typeof(swaps) = 'object'),
  add column current_step integer not null default 0 check (current_step >= 0),
  add column checked_ingredients uuid[] not null default '{}',
  add column abandoned_at timestamptz,
  add column log_prompt text not null default 'pending' check (log_prompt in ('pending', 'declined', 'logged')),
  add column plan_id uuid references public.meal_plans (id) on delete set null,
  add column entry_timezone text check (entry_timezone is null or app.is_valid_timezone(entry_timezone)),
  add column updated_at timestamptz not null default now(),
  add constraint cook_sessions_not_both check (completed_at is null or abandoned_at is null);
create index cook_sessions_owner_date_idx on public.cook_sessions (owner_id, local_date);

alter table public.meal_plans
  add column meal_slot text check (meal_slot is null or meal_slot in ('breakfast', 'lunch', 'dinner', 'snack')),
  add column created_at timestamptz not null default now();
create index meal_plans_owner_date_idx on public.meal_plans (owner_id, planned_date);

-- A diary entry made from a cook session points back to it, so the meal is counted once.
alter table public.diary_entries
  add column cook_session_id uuid references public.cook_sessions (id) on delete set null;
create index diary_entries_cook_session_idx on public.diary_entries (cook_session_id) where cook_session_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Calculation helpers (schema app: not callable over HTTP)
-- ---------------------------------------------------------------------------

-- How many "basis amounts" of an ingredient a recipe line uses. Null when there is no
-- defensible conversion (for example "1 pinch" of something measured per 100 g).
create function app.ingredient_factor(p_ingredient_revision_id uuid, p_quantity numeric, p_unit text, p_grams numeric)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case r.basis_kind
    when 'mass' then coalesce(p_grams, app.unit_to_grams(p_quantity, p_unit)) / r.basis_amount
    when 'volume' then app.unit_to_ml(p_quantity, p_unit) / r.basis_amount
    else case when p_unit = 'serving' then p_quantity / r.basis_amount
              else (coalesce(p_grams, app.unit_to_grams(p_quantity, p_unit))
                    / (select pp.grams / pp.amount from public.portions pp
                        where pp.revision_id = r.id and pp.unit = 'serving' and pp.grams is not null
                        order by pp.label limit 1)) / r.basis_amount end
  end
  from public.food_revisions r where r.id = p_ingredient_revision_id;
$$;

-- Checks a requested set of swaps and returns only the ones that differ from the recipe
-- as written: {"group": "recipe_ingredient id"}. Anything not approved is refused.
create function app.normalize_swaps(p_recipe_revision_id uuid, p_swaps jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out jsonb := '{}'::jsonb;
  k text;
  v text;
  ri public.recipe_ingredients;
begin
  if p_swaps is null or p_swaps = 'null'::jsonb then
    return v_out;
  end if;
  if jsonb_typeof(p_swaps) <> 'object' then
    raise exception 'INVALID_SUBSTITUTION' using errcode = 'PT422';
  end if;
  for k, v in select key, value #>> '{}' from jsonb_each(p_swaps) loop
    select * into ri from public.recipe_ingredients x
     where x.recipe_revision_id = p_recipe_revision_id and x.substitution_group = k and x.id::text = v;
    if not found then
      raise exception 'INVALID_SUBSTITUTION' using errcode = 'PT422';
    end if;
    if not ri.included_by_default then
      v_out := v_out || jsonb_build_object(k, ri.id);
    end if;
  end loop;
  return v_out;
end;
$$;

-- The ingredient lines actually used: everything required, optional lines that are part of
-- the recipe as written, and for each substitution group the chosen (or default) line.
create function app.recipe_selection(p_recipe_revision_id uuid, p_swaps jsonb)
returns setof public.recipe_ingredients
language sql
stable
security definer
set search_path = ''
as $$
  select ri.*
    from public.recipe_ingredients ri
   where ri.recipe_revision_id = p_recipe_revision_id
     and case when ri.substitution_group is null then (not ri.optional or ri.included_by_default)
              when p_swaps ? ri.substitution_group then ri.id::text = p_swaps ->> ri.substitution_group
              else ri.included_by_default end;
$$;

-- Per-serving nutrition from the ingredients in use. One missing contribution makes the
-- nutrient unknown; the part that is known is kept beside it, clearly not a total.
create function app.recipe_variant_nutrients(p_recipe_revision_id uuid, p_swaps jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with rr as (
    select * from public.recipe_revisions where food_revision_id = p_recipe_revision_id
  ), lines as (
    select s.id, s.ingredient_revision_id,
           app.ingredient_factor(s.ingredient_revision_id, s.quantity, s.unit, s.grams) as factor
      from app.recipe_selection(p_recipe_revision_id, p_swaps) s
  ), per as (
    select d.code, d.canonical_unit, d.display_order,
           count(l.id)::integer as line_count,
           (count(l.id) filter (where nv.value is null or l.factor is null))::integer as missing,
           sum(nv.value * l.factor) as known,
           coalesce(bool_or(nv.method = 'estimated' and nv.value is not null), false) as any_estimate
      from public.nutrient_definitions d
      cross join lines l
      left join public.nutrient_values nv on nv.revision_id = l.ingredient_revision_id and nv.nutrient_code = d.code
     group by d.code, d.canonical_unit, d.display_order
  )
  select coalesce(jsonb_object_agg(p.code, jsonb_build_object(
           'value', case when p.missing = 0 and p.line_count > 0 then round(p.known / rr.yield_servings, 4) end,
           'unit', p.canonical_unit,
           'method', case when p.any_estimate then 'estimated' else 'calculated' end,
           'missingReason', case when p.missing = 0 and p.line_count > 0 then null else 'incomplete_recipe' end,
           'sourceRecordId', rr.rights_record_id,
           'missingIngredients', p.missing,
           'ingredientCount', p.line_count,
           'knownSubtotal', round(coalesce(p.known, 0) / rr.yield_servings, 4))), '{}'::jsonb)
    from per p cross join rr;
$$;

create function app.scale_nutrients(p_nutrients jsonb, p_factor numeric)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(n.key, n.value
           || jsonb_build_object('value', round((n.value ->> 'value')::numeric * p_factor, 4))
           || case when n.value ? 'knownSubtotal'
                   then jsonb_build_object('knownSubtotal', round((n.value ->> 'knownSubtotal')::numeric * p_factor, 4))
                   else '{}'::jsonb end
           || case when n.value ->> 'lower' is not null
                   then jsonb_build_object('lower', (n.value ->> 'lower')::numeric * p_factor,
                                           'upper', (n.value ->> 'upper')::numeric * p_factor)
                   else '{}'::jsonb end), '{}'::jsonb)
    from jsonb_each(p_nutrients) n;
$$;

-- Dietary result for the recipe with the chosen swaps.
--   No swaps: the reviewed recipe-level evidence, exactly as Discover uses it.
--   With swaps: every ingredient in use is checked on its own evidence and the worst
--   result wins. The recipe-level claim is not consulted at all.
create function app.variant_eligibility(
  p_recipe_revision_id uuid, p_swaps jsonb, p_diet text, p_exclusions text[], p_include_conditional boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rank integer := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_one jsonb;
  v_one_rank integer;
  s record;
begin
  if p_swaps = '{}'::jsonb then
    return app.eligibility(p_recipe_revision_id, p_diet, p_exclusions, p_include_conditional)
           || jsonb_build_object('basis', 'as_written');
  end if;
  for s in select sel.ingredient_revision_id, r.name
             from app.recipe_selection(p_recipe_revision_id, p_swaps) sel
             join public.food_revisions r on r.id = sel.ingredient_revision_id
            order by sel.position loop
    v_one := app.eligibility(s.ingredient_revision_id, p_diet, p_exclusions, p_include_conditional);
    v_one_rank := array_position(array['eligible', 'conditional', 'needs_confirmation', 'excluded'], v_one ->> 'status') - 1;
    v_rank := greatest(v_rank, v_one_rank);
    v_reasons := v_reasons || coalesce((
      select jsonb_agg(x || jsonb_build_object('ingredient', s.name)) from jsonb_array_elements(v_one -> 'reasons') x), '[]'::jsonb);
  end loop;
  return jsonb_build_object(
    'status', (array['eligible', 'conditional', 'needs_confirmation', 'excluded'])[v_rank + 1],
    'reasons', v_reasons,
    'basis', 'ingredients');
end;
$$;

-- Allergens declared on the ingredients in use. This lists what is known to be present
-- or unconfirmed; it never states that a recipe is free from anything.
create function app.variant_allergens(p_recipe_revision_id uuid, p_swaps jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with st as (
    select a.allergen, a.presence
      from app.recipe_selection(p_recipe_revision_id, p_swaps) sel
      join public.allergen_statements a on a.revision_id = sel.ingredient_revision_id
  )
  select jsonb_build_object(
    'contains', coalesce((select jsonb_agg(distinct allergen order by allergen) from st where presence = 'present'), '[]'::jsonb),
    'unconfirmed', coalesce((select jsonb_agg(distinct allergen order by allergen) from st
                              where presence = 'unknown'
                                and allergen not in (select allergen from st where presence = 'present')), '[]'::jsonb));
$$;

-- The signed-in member's saved dietary filter.
create function app.member_diet(p_owner uuid, out diet text, out exclusions text[], out include_conditional boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.diet from public.user_preferences p where p.user_id = p_owner), 'none'),
         coalesce((select array_agg(x.ingredient_family order by x.ingredient_family)
                     from public.ingredient_exclusions x where x.owner_id = p_owner), '{}'::text[]),
         coalesce((select p.include_conditional from public.user_preferences p where p.user_id = p_owner), false);
$$;

-- Everything a recipe screen needs for one revision, servings count and set of swaps.
create function app.recipe_view(
  p_revision_id uuid, p_servings numeric, p_swaps jsonb, p_diet text, p_exclusions text[], p_include_conditional boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.food_revisions;
  rr public.recipe_revisions;
  fi public.food_items;
  v_swaps jsonb;
  v_servings numeric;
  v_scale numeric;
  v_filtering boolean := p_diet <> 'none' or coalesce(array_length(p_exclusions, 1), 0) > 0;
begin
  select * into r from public.food_revisions where id = p_revision_id;
  select * into rr from public.recipe_revisions where food_revision_id = p_revision_id;
  if rr.food_revision_id is null then
    raise exception 'RECIPE_NOT_FOUND' using errcode = 'PT404';
  end if;
  select * into fi from public.food_items where id = r.food_item_id;
  v_swaps := app.normalize_swaps(p_revision_id, p_swaps);
  v_servings := coalesce(p_servings, rr.yield_servings);
  if v_servings <= 0 or v_servings > 100 then
    raise exception 'INVALID_SERVINGS' using errcode = 'PT422';
  end if;
  v_scale := v_servings / rr.yield_servings;

  return jsonb_build_object(
    'foodItemId', fi.id, 'revisionId', r.id, 'name', r.name, 'description', r.description, 'isDemo', fi.is_demo,
    'mealTypes', to_jsonb(rr.meal_types), 'cuisine', rr.cuisine,
    'prepMinutes', rr.prep_minutes, 'cookMinutes', rr.cook_minutes,
    'yieldServings', rr.yield_servings, 'servings', v_servings, 'scale', v_scale,
    'servingNote', rr.serving_note, 'equipment', to_jsonb(rr.equipment), 'trialCookedAt', rr.trial_cooked_at,
    'swaps', v_swaps, 'swapped', v_swaps <> '{}'::jsonb,
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'position', x.position, 'name', ir.name, 'foodItemId', ir.food_item_id,
               'quantity', x.quantity * v_scale, 'unit', x.unit, 'grams', x.grams * v_scale,
               'optional', x.optional and x.substitution_group is null, 'included', x.sel,
               'group', x.substitution_group, 'prepNote', x.prep_note,
               'isDefault', x.included_by_default,
               'calculable', app.ingredient_factor(x.ingredient_revision_id, x.quantity, x.unit, x.grams) is not null,
               'alternatives', case when x.substitution_group is null then '[]'::jsonb else (
                   select jsonb_agg(jsonb_build_object(
                            'id', a.id, 'name', ar.name, 'quantity', a.quantity * v_scale, 'unit', a.unit,
                            'note', a.substitution_note, 'isDefault', a.included_by_default, 'selected', a.id = x.id,
                            'status', case when v_filtering
                                           then app.eligibility(a.ingredient_revision_id, p_diet, p_exclusions, p_include_conditional) ->> 'status'
                                           else 'eligible' end)
                          order by a.included_by_default desc, a.position)
                     from public.recipe_ingredients a
                     join public.food_revisions ar on ar.id = a.ingredient_revision_id
                    where a.recipe_revision_id = p_revision_id and a.substitution_group = x.substitution_group) end)
             order by x.position)
        from (
          select ri.*, true as sel from app.recipe_selection(p_revision_id, v_swaps) ri
          union all
          -- Optional extras that are not part of the numbers are still listed, marked as not included.
          select ri.*, false as sel from public.recipe_ingredients ri
           where ri.recipe_revision_id = p_revision_id and ri.substitution_group is null
             and ri.optional and not ri.included_by_default
        ) x
        join public.food_revisions ir on ir.id = x.ingredient_revision_id), '[]'::jsonb),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object('ordinal', st.ordinal, 'title', st.title, 'instruction', st.instruction,
                                          'timerSeconds', st.timer_seconds) order by st.ordinal)
        from public.recipe_steps st where st.recipe_revision_id = p_revision_id), '[]'::jsonb),
    'nutrients', app.recipe_variant_nutrients(p_revision_id, v_swaps),
    'eligibility', app.variant_eligibility(p_revision_id, v_swaps, p_diet, p_exclusions, p_include_conditional),
    -- What the recipe is, with these swaps, for someone with no personal exclusions.
    'suitability', jsonb_build_object(
      'vegetarian', app.variant_eligibility(p_revision_id, v_swaps, 'vegetarian', '{}', false) ->> 'status',
      'vegan', app.variant_eligibility(p_revision_id, v_swaps, 'vegan', '{}', false) ->> 'status'),
    'families', coalesce((
      select jsonb_agg(distinct f.label order by f.label)
        from app.recipe_selection(p_revision_id, v_swaps) sel
        join public.ingredient_families f on app.direct_family_presence(sel.ingredient_revision_id, f.code) = 'present'), '[]'::jsonb),
    'allergens', app.variant_allergens(p_revision_id, v_swaps),
    'source', jsonb_build_object(
      'recipe', app.source_summary(rr.rights_record_id),
      'nutritionMethod', 'ingredient_sum',
      'ingredientSources', coalesce((
        select jsonb_agg(distinct app.source_summary(nv.source_record_id))
          from app.recipe_selection(p_revision_id, v_swaps) sel
          join public.nutrient_values nv on nv.revision_id = sel.ingredient_revision_id
         where nv.source_record_id is not null), '[]'::jsonb)),
    'portion', (select jsonb_build_object('id', po.id, 'label', po.label)
                  from public.portions po where po.revision_id = r.id and po.unit = 'serving' order by po.label limit 1)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Public recipe reads (guests and members). Only published public recipes.
-- ---------------------------------------------------------------------------
create function public.recipe_detail(
  p_food_item_id uuid,
  p_servings numeric default null,
  p_swaps jsonb default '{}'::jsonb,
  p_diet text default 'none',
  p_exclusions text[] default '{}',
  p_include_conditional boolean default false,
  p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rev uuid;
begin
  select fi.current_revision_id into v_rev
    from public.food_items fi
    join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
    join public.recipe_revisions rr on rr.food_revision_id = r.id
   where fi.id = p_food_item_id and fi.kind = 'recipe' and fi.visibility = 'public' and fi.status = 'published'
     and (p_include_demo or not fi.is_demo);
  if v_rev is null then
    raise exception 'RECIPE_NOT_FOUND' using errcode = 'PT404';
  end if;
  return app.recipe_view(v_rev, p_servings, p_swaps, coalesce(p_diet, 'none'), coalesce(p_exclusions, '{}'), coalesce(p_include_conditional, false));
end;
$$;

create function public.recipe_list(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_meal text := nullif(p->>'meal', '');
  v_cuisine text := nullif(p->>'cuisine', '');
  v_min_protein numeric := (p->>'minProtein')::numeric;
  v_max_minutes integer := (p->>'maxMinutes')::integer;
  v_diet text := coalesce(p->>'diet', 'none');
  v_excl text[] := case when p ? 'exclusions' and jsonb_typeof(p->'exclusions') = 'array'
                        then array(select jsonb_array_elements_text(p->'exclusions')) else '{}'::text[] end;
  v_view text := coalesce(p->>'view', 'matches');
  v_incl_cond boolean := coalesce((p->>'includeConditional')::boolean, false);
  v_demo boolean := coalesce((p->>'includeDemo')::boolean, false);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_view not in ('matches', 'needs_confirmation') then raise exception 'INVALID_VIEW' using errcode = 'PT422'; end if;
  if v_meal is not null and v_meal not in ('breakfast', 'lunch', 'dinner', 'snack') then
    raise exception 'INVALID_MEAL' using errcode = 'PT422';
  end if;
  if v_cuisine is not null and v_cuisine not in ('indian', 'asian', 'mediterranean', 'everyday') then
    raise exception 'INVALID_CUISINE' using errcode = 'PT422';
  end if;
  if v_min_protein is not null and (v_min_protein < 0 or v_min_protein > 500) then
    raise exception 'INVALID_MIN_PROTEIN' using errcode = 'PT422';
  end if;
  if v_max_minutes is not null and (v_max_minutes < 1 or v_max_minutes > 1440) then
    raise exception 'INVALID_MAX_MINUTES' using errcode = 'PT422';
  end if;
  if v_diet not in ('none', 'vegetarian', 'vegan') then
    raise exception 'INVALID_DIET' using errcode = 'PT422';
  end if;
  if exists (select 1 from unnest(v_excl) x where x not in (select code from public.ingredient_families)) then
    raise exception 'INVALID_EXCLUSION' using errcode = 'PT422';
  end if;

  with base as (
    select fi.id as item_id, fi.is_demo, r.id as rev_id, r.name, r.description, rr.*,
           (select nv.value from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = 'protein_g') as protein_g,
           (select nv.method from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = 'protein_g') as protein_method,
           (select nv.value from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = 'energy_kcal') as energy_kcal,
           (select count(distinct ri.substitution_group) from public.recipe_ingredients ri
             where ri.recipe_revision_id = r.id and ri.substitution_group is not null)::integer as swap_groups,
           app.eligibility(r.id, v_diet, v_excl, v_incl_cond) as elig
      from public.food_items fi
      join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
      join public.recipe_revisions rr on rr.food_revision_id = r.id
     where fi.kind = 'recipe' and fi.visibility = 'public' and fi.status = 'published'
       and (v_demo or not fi.is_demo)
       and (v_q is null or r.name ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
            or to_tsvector('english', r.name || ' ' || coalesce(r.description, '')) @@ plainto_tsquery('english', v_q))
       and (v_meal is null or v_meal = any(rr.meal_types))
       and (v_cuisine is null or rr.cuisine = v_cuisine)
       and (v_max_minutes is null or coalesce(rr.prep_minutes, 0) + coalesce(rr.cook_minutes, 0) <= v_max_minutes)
  ), grouped as (
    select b.*, case b.elig->>'status' when 'excluded' then 'hidden' when 'eligible' then 'match'
                                       when 'conditional' then 'match' else 'needs_confirmation' end as grp,
           (v_min_protein is not null and b.protein_g is null) as not_comparable
      from base b
     -- "Unknown" protein is never treated as zero: it is set aside and counted, not silently dropped as "too low".
     where v_min_protein is null or b.protein_g is null or b.protein_g >= v_min_protein
  ), visible as (
    select * from grouped
     where grp = case v_view when 'matches' then 'match' else 'needs_confirmation' end and not not_comparable
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'foodItemId', v.item_id, 'revisionId', v.rev_id, 'name', v.name, 'description', v.description, 'isDemo', v.is_demo,
               'mealTypes', to_jsonb(v.meal_types), 'cuisine', v.cuisine,
               'prepMinutes', v.prep_minutes, 'cookMinutes', v.cook_minutes, 'yieldServings', v.yield_servings,
               'proteinG', v.protein_g, 'proteinMethod', v.protein_method, 'energyKcal', v.energy_kcal,
               'swapGroups', v.swap_groups, 'eligibility', v.elig)
             order by array_position(array['breakfast', 'lunch', 'dinner', 'snack'], v.meal_types[1]), v.name)
        from visible v), '[]'::jsonb),
    'counts', jsonb_build_object(
      'matches', (select count(*) from grouped where grp = 'match' and not not_comparable),
      'needsConfirmation', (select count(*) from grouped where grp = 'needs_confirmation' and not not_comparable),
      'hidden', (select count(*) from grouped where grp = 'hidden'),
      'notComparable', (select count(*) from grouped where not_comparable and grp <> 'hidden')),
    'applied', jsonb_build_object('diet', v_diet, 'exclusions', to_jsonb(v_excl), 'view', v_view)
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cook sessions (private). Progress is saved so a session can be resumed.
-- ---------------------------------------------------------------------------
create function public.start_cook_session(
  p_idempotency_key uuid,
  p_food_item_id uuid,
  p_servings numeric,
  p_swaps jsonb,
  p_local_date date,
  p_timezone text,
  p_plan_id uuid default null,
  p_include_demo boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_rev uuid;
  v_yield numeric;
  v_swaps jsonb;
  v_servings numeric;
  v_hash text;
  v_existing public.idempotency_records;
  v_inserted integer;
  v_id uuid := gen_random_uuid();
  v_pref record;
  k text;
  v text;
  v_ing uuid;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'PT422';
  end if;
  if p_local_date is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  if p_timezone is null or not app.is_valid_timezone(p_timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = 'PT422';
  end if;
  select fi.current_revision_id, rr.yield_servings into v_rev, v_yield
    from public.food_items fi
    join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
    join public.recipe_revisions rr on rr.food_revision_id = r.id
   where fi.id = p_food_item_id and fi.kind = 'recipe' and fi.visibility = 'public' and fi.status = 'published'
     and (p_include_demo or not fi.is_demo);
  if v_rev is null then
    raise exception 'RECIPE_NOT_FOUND' using errcode = 'PT404';
  end if;
  v_servings := coalesce(p_servings, v_yield);
  if v_servings <= 0 or v_servings > 100 then
    raise exception 'INVALID_SERVINGS' using errcode = 'PT422';
  end if;
  v_swaps := app.normalize_swaps(v_rev, p_swaps);

  -- A swap that contains something the member excludes is refused, whatever the screen offered.
  select * into v_pref from app.member_diet(v_owner);
  for k, v in select key, value #>> '{}' from jsonb_each(v_swaps) loop
    select ri.ingredient_revision_id into v_ing from public.recipe_ingredients ri where ri.id = v::uuid;
    if app.eligibility(v_ing, v_pref.diet, v_pref.exclusions, v_pref.include_conditional) ->> 'status' = 'excluded' then
      raise exception 'SUBSTITUTION_EXCLUDED' using errcode = 'PT422';
    end if;
  end loop;

  if p_plan_id is not null and not exists (
       select 1 from public.meal_plans mp where mp.id = p_plan_id and mp.owner_id = v_owner) then
    raise exception 'PLAN_NOT_FOUND' using errcode = 'PT404';
  end if;

  v_hash := md5(jsonb_build_array(p_food_item_id, v_servings, v_swaps, p_local_date, p_timezone, p_plan_id)::text);
  insert into public.idempotency_records (owner_id, operation, key, request_hash)
  values (v_owner, 'cook.start', p_idempotency_key, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select * into v_existing from public.idempotency_records
     where owner_id = v_owner and operation = 'cook.start' and key = p_idempotency_key;
    if v_existing.request_hash <> v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'PT409';
    end if;
    return jsonb_build_object('sessionId', v_existing.result_id, 'replayed', true);
  end if;

  insert into public.cook_sessions (id, owner_id, recipe_revision_id, local_date, servings, swaps, plan_id, entry_timezone)
  values (v_id, v_owner, v_rev, p_local_date, v_servings, v_swaps, p_plan_id, p_timezone);
  update public.idempotency_records set result_id = v_id
   where owner_id = v_owner and operation = 'cook.start' and key = p_idempotency_key;
  return jsonb_build_object('sessionId', v_id, 'replayed', false);
end;
$$;

-- One session with its recipe exactly as it is being cooked, and what has been logged from it.
create function public.my_cook_session(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  cs public.cook_sessions;
  v_pref record;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into cs from public.cook_sessions where id = p_session_id and owner_id = v_owner;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'PT404';   -- same answer for "not yours"
  end if;
  select * into v_pref from app.member_diet(v_owner);
  return jsonb_build_object(
    'sessionId', cs.id, 'startedAt', cs.started_at, 'completedAt', cs.completed_at, 'abandonedAt', cs.abandoned_at,
    'date', cs.local_date, 'servings', cs.servings, 'currentStep', cs.current_step,
    'checkedIngredients', to_jsonb(cs.checked_ingredients), 'logPrompt', cs.log_prompt, 'version', cs.version,
    'loggedServings', coalesce((
      select sum(s.quantity) from public.diary_entries e join public.diary_snapshots s on s.id = e.current_snapshot_id
       where e.cook_session_id = cs.id and e.owner_id = v_owner and e.deleted_at is null), 0),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('entryId', e.id, 'date', e.local_date, 'mealSlot', e.meal_slot, 'servings', s.quantity,
                                          'proteinG', (s.nutrients -> 'protein_g' ->> 'value')::numeric) order by e.created_at)
        from public.diary_entries e join public.diary_snapshots s on s.id = e.current_snapshot_id
       where e.cook_session_id = cs.id and e.owner_id = v_owner and e.deleted_at is null), '[]'::jsonb),
    'recipe', app.recipe_view(cs.recipe_revision_id, cs.servings, cs.swaps, v_pref.diet, v_pref.exclusions, v_pref.include_conditional)
  );
end;
$$;

create function public.save_cook_progress(p_session_id uuid, p_current_step integer, p_checked_ingredients uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  cs public.cook_sessions;
  v_steps integer;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into cs from public.cook_sessions where id = p_session_id and owner_id = v_owner for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'PT404';
  end if;
  if cs.completed_at is not null or cs.abandoned_at is not null then
    raise exception 'SESSION_CLOSED' using errcode = 'PT409';
  end if;
  select count(*) into v_steps from public.recipe_steps st where st.recipe_revision_id = cs.recipe_revision_id;
  if p_current_step is null or p_current_step < 0 or p_current_step > v_steps then
    raise exception 'INVALID_STEP' using errcode = 'PT422';
  end if;
  if coalesce(array_length(p_checked_ingredients, 1), 0) > 200 then
    raise exception 'INVALID_CHECKLIST' using errcode = 'PT422';
  end if;
  update public.cook_sessions
     set current_step = p_current_step,
         -- Only ingredient lines of this recipe are kept.
         checked_ingredients = coalesce((select array_agg(distinct ri.id) from public.recipe_ingredients ri
                                          where ri.recipe_revision_id = cs.recipe_revision_id
                                            and ri.id = any(coalesce(p_checked_ingredients, '{}'))), '{}'),
         version = version + 1, updated_at = now()
   where id = cs.id;
  return jsonb_build_object('sessionId', cs.id, 'version', cs.version + 1, 'currentStep', p_current_step);
end;
$$;

-- Finishing records that the cooking happened. It writes nothing to the diary.
create function public.complete_cook_session(p_session_id uuid, p_local_date date, p_timezone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  cs public.cook_sessions;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_local_date is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  if p_timezone is null or not app.is_valid_timezone(p_timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = 'PT422';
  end if;
  select * into cs from public.cook_sessions where id = p_session_id and owner_id = v_owner for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'PT404';
  end if;
  if cs.abandoned_at is not null then
    raise exception 'SESSION_CLOSED' using errcode = 'PT409';
  end if;
  if cs.completed_at is not null then
    return jsonb_build_object('sessionId', cs.id, 'completedAt', cs.completed_at, 'replayed', true);   -- pressing Finish twice changes nothing
  end if;
  update public.cook_sessions
     set completed_at = now(), local_date = p_local_date, entry_timezone = p_timezone,
         version = version + 1, updated_at = now()
   where id = cs.id;
  return jsonb_build_object('sessionId', cs.id, 'completedAt', now(), 'replayed', false);
end;
$$;

create function public.abandon_cook_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  cs public.cook_sessions;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into cs from public.cook_sessions where id = p_session_id and owner_id = v_owner for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'PT404';
  end if;
  if cs.completed_at is not null then
    raise exception 'SESSION_CLOSED' using errcode = 'PT409';
  end if;
  update public.cook_sessions set abandoned_at = coalesce(abandoned_at, now()), version = version + 1, updated_at = now()
   where id = cs.id;
  return jsonb_build_object('sessionId', cs.id);
end;
$$;

-- "Not now": remembers that the member was asked, so they are not asked again on resume.
create function public.decline_cook_log(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  cs public.cook_sessions;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into cs from public.cook_sessions where id = p_session_id and owner_id = v_owner for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'PT404';
  end if;
  if cs.completed_at is null then
    raise exception 'COOK_NOT_FINISHED' using errcode = 'PT409';
  end if;
  update public.cook_sessions set log_prompt = 'declined', updated_at = now()
   where id = cs.id and log_prompt = 'pending';
  return jsonb_build_object('sessionId', cs.id);
end;
$$;

-- The only way a cook session reaches the diary: the member states how much they ate.
-- The snapshot is the recipe as cooked (servings and swaps), frozen like any other entry.
create function public.log_cook_session(
  p_idempotency_key uuid,
  p_session_id uuid,
  p_servings numeric,
  p_meal_slot text,
  p_local_date date,
  p_timezone text,
  p_additional boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  cs public.cook_sessions;
  r public.food_revisions;
  rr public.recipe_revisions;
  v_hash text;
  v_existing public.idempotency_records;
  v_inserted integer;
  v_logged numeric;
  v_per_serving jsonb;
  v_entry_id uuid := gen_random_uuid();
  v_snapshot_id uuid := gen_random_uuid();
  v_evidence jsonb;
  v_swapped boolean;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'PT422';
  end if;
  if p_servings is null or p_servings <= 0 or p_servings > 100 then
    raise exception 'INVALID_AMOUNT' using errcode = 'PT422';
  end if;
  if p_meal_slot is null or length(trim(p_meal_slot)) not between 1 and 40 then
    raise exception 'INVALID_MEAL_SLOT' using errcode = 'PT422';
  end if;
  if p_local_date is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  if p_timezone is null or not app.is_valid_timezone(p_timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = 'PT422';
  end if;
  select * into cs from public.cook_sessions where id = p_session_id and owner_id = v_owner for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND' using errcode = 'PT404';
  end if;
  if cs.completed_at is null then
    raise exception 'COOK_NOT_FINISHED' using errcode = 'PT409';
  end if;

  v_hash := md5(jsonb_build_array('cook', p_session_id, p_servings, trim(p_meal_slot), p_local_date, p_timezone, p_additional)::text);
  insert into public.idempotency_records (owner_id, operation, key, request_hash)
  values (v_owner, 'diary.create', p_idempotency_key, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select * into v_existing from public.idempotency_records
     where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;
    if v_existing.request_hash <> v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'PT409';
    end if;
    return (select jsonb_build_object('entryId', x.id, 'version', x.version, 'snapshotId', x.current_snapshot_id, 'replayed', true)
              from public.diary_entries x where x.id = v_existing.result_id);
  end if;

  select coalesce(sum(s.quantity), 0) into v_logged
    from public.diary_entries e join public.diary_snapshots s on s.id = e.current_snapshot_id
   where e.cook_session_id = cs.id and e.deleted_at is null;
  -- A second entry from the same session must be asked for on purpose ("log more from this batch").
  if v_logged > 0 and not coalesce(p_additional, false) then
    raise exception 'ALREADY_LOGGED' using errcode = 'PT409';
  end if;
  if v_logged + p_servings > cs.servings + 0.0001 then
    raise exception 'MORE_THAN_COOKED' using errcode = 'PT422';
  end if;

  select * into r from public.food_revisions where id = cs.recipe_revision_id;
  select * into rr from public.recipe_revisions where food_revision_id = cs.recipe_revision_id;
  v_swapped := cs.swaps <> '{}'::jsonb;
  v_per_serving := app.recipe_variant_nutrients(cs.recipe_revision_id, cs.swaps);

  -- With swaps, the recipe-level dietary claim is not carried into the snapshot.
  v_evidence := app.evidence_snapshot(cs.recipe_revision_id)
    || case when v_swapped then jsonb_build_object('dietaryClaims', '[]'::jsonb, 'ingredientFamilies', '[]'::jsonb) else '{}'::jsonb end
    || jsonb_build_object(
         'basis', jsonb_build_object('kind', 'serving', 'amount', 1, 'unit', 'serving'),
         'cooked', jsonb_build_object(
           'sessionId', cs.id, 'servingsCooked', cs.servings, 'recipeYield', rr.yield_servings, 'substituted', v_swapped,
           'method', 'ingredient_sum',
           'ingredients', (select jsonb_agg(jsonb_build_object('name', ir.name, 'quantity', sel.quantity * cs.servings / rr.yield_servings,
                                                               'unit', sel.unit, 'group', sel.substitution_group,
                                                               'swappedIn', sel.substitution_group is not null and not sel.included_by_default)
                                            order by sel.position)
                             from app.recipe_selection(cs.recipe_revision_id, cs.swaps) sel
                             join public.food_revisions ir on ir.id = sel.ingredient_revision_id),
           'suitability', jsonb_build_object(
             'vegetarian', app.variant_eligibility(cs.recipe_revision_id, cs.swaps, 'vegetarian', '{}', false) ->> 'status',
             'vegan', app.variant_eligibility(cs.recipe_revision_id, cs.swaps, 'vegan', '{}', false) ->> 'status')));

  insert into public.diary_entries (id, owner_id, food_item_id, context, meal_slot, consumed_at, local_date, entry_timezone,
                                    current_snapshot_id, cook_session_id)
  values (v_entry_id, v_owner, r.food_item_id, 'home', trim(p_meal_slot), null, p_local_date, p_timezone, v_snapshot_id, cs.id);

  insert into public.diary_snapshots (id, entry_id, revision_no, food_revision_id, display_name, selected_portion,
                                      quantity, resolved_mass_g, nutrients, evidence_snapshot)
  values (v_snapshot_id, v_entry_id, 1, r.id, r.name,
          jsonb_build_object('kind', 'cooked', 'label', 'serving, as you cooked it', 'amount', 1, 'unit', 'serving',
                             'multiplier', p_servings, 'cookSessionId', cs.id, 'substituted', v_swapped),
          p_servings,
          case when not v_swapped and rr.cooked_yield_g is not null then rr.cooked_yield_g / rr.yield_servings * p_servings end,
          app.scale_nutrients(v_per_serving, p_servings), v_evidence);

  update public.cook_sessions set log_prompt = 'logged', updated_at = now() where id = cs.id;
  update public.idempotency_records set result_id = v_entry_id
   where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;

  return jsonb_build_object('entryId', v_entry_id, 'version', 1, 'snapshotId', v_snapshot_id, 'replayed', false);
end;
$$;

-- The Cook tab's private part: what is in progress and what was cooked lately.
create function public.my_cooking(p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_today is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  return jsonb_build_object(
    'inProgress', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sessionId', cs.id, 'foodItemId', r.food_item_id, 'name', r.name, 'startedAt', cs.started_at, 'date', cs.local_date,
               'servings', cs.servings, 'currentStep', cs.current_step,
               'stepCount', (select count(*) from public.recipe_steps st where st.recipe_revision_id = cs.recipe_revision_id))
             order by cs.updated_at desc)
        from public.cook_sessions cs join public.food_revisions r on r.id = cs.recipe_revision_id
       where cs.owner_id = v_owner and cs.completed_at is null and cs.abandoned_at is null
         and cs.local_date >= p_today - 7), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sessionId', cs.id, 'foodItemId', r.food_item_id, 'name', r.name, 'date', cs.local_date,
               'servings', cs.servings, 'substituted', cs.swaps <> '{}'::jsonb, 'logPrompt', cs.log_prompt,
               'loggedServings', coalesce((
                  select sum(s.quantity) from public.diary_entries e join public.diary_snapshots s on s.id = e.current_snapshot_id
                   where e.cook_session_id = cs.id and e.deleted_at is null), 0))
             order by cs.completed_at desc)
        from public.cook_sessions cs join public.food_revisions r on r.id = cs.recipe_revision_id
       where cs.owner_id = v_owner and cs.completed_at is not null and cs.local_date >= p_today - 14), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Week plan (private). A planned recipe is an intention. It is in no total anywhere.
-- ---------------------------------------------------------------------------
create function public.plan_recipe(
  p_food_item_id uuid, p_date date, p_servings numeric, p_meal_slot text default null, p_include_demo boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_rev uuid;
  v_yield numeric;
  v_id uuid;
  v_servings numeric;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_date is null or p_date < current_date - 7 or p_date > current_date + 366 then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  if p_meal_slot is not null and p_meal_slot not in ('breakfast', 'lunch', 'dinner', 'snack') then
    raise exception 'INVALID_MEAL_SLOT' using errcode = 'PT422';
  end if;
  select fi.current_revision_id, rr.yield_servings into v_rev, v_yield
    from public.food_items fi
    join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
    join public.recipe_revisions rr on rr.food_revision_id = r.id
   where fi.id = p_food_item_id and fi.kind = 'recipe' and fi.visibility = 'public' and fi.status = 'published'
     and (p_include_demo or not fi.is_demo);
  if v_rev is null then
    raise exception 'RECIPE_NOT_FOUND' using errcode = 'PT404';
  end if;
  v_servings := coalesce(p_servings, v_yield);
  if v_servings <= 0 or v_servings > 100 then
    raise exception 'INVALID_SERVINGS' using errcode = 'PT422';
  end if;
  -- Planning the same recipe for the same day and meal twice keeps one plan.
  select mp.id into v_id from public.meal_plans mp
   where mp.owner_id = v_owner and mp.planned_date = p_date and mp.food_revision_id = v_rev
     and mp.meal_slot is not distinct from p_meal_slot
   limit 1;
  if v_id is not null then
    update public.meal_plans set planned_servings = v_servings where id = v_id;
    return jsonb_build_object('planId', v_id, 'existing', true);
  end if;
  if (select count(*) from public.meal_plans mp where mp.owner_id = v_owner) >= 500 then
    raise exception 'TOO_MANY_PLANS' using errcode = 'PT429';
  end if;
  insert into public.meal_plans (owner_id, planned_date, food_revision_id, planned_servings, meal_slot)
  values (v_owner, p_date, v_rev, v_servings, p_meal_slot)
  returning id into v_id;
  return jsonb_build_object('planId', v_id, 'existing', false);
end;
$$;

create function public.remove_plan(p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_count integer;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  delete from public.meal_plans where id = p_plan_id and owner_id = v_owner;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'PLAN_NOT_FOUND' using errcode = 'PT404';
  end if;
  return jsonb_build_object('planId', p_plan_id);
end;
$$;

create function public.my_plan(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'planId', mp.id, 'date', mp.planned_date, 'mealSlot', mp.meal_slot, 'servings', mp.planned_servings,
             'foodItemId', r.food_item_id, 'name', r.name,
             'prepMinutes', rr.prep_minutes, 'cookMinutes', rr.cook_minutes,
             'proteinG', (select nv.value from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = 'protein_g'),
             'cooked', exists (select 1 from public.cook_sessions cs
                                where cs.plan_id = mp.id and cs.owner_id = v_owner and cs.completed_at is not null),
             'sessionId', (select cs.id from public.cook_sessions cs
                            where cs.plan_id = mp.id and cs.owner_id = v_owner and cs.abandoned_at is null
                            order by cs.started_at desc limit 1))
           order by mp.planned_date, array_position(array['breakfast', 'lunch', 'dinner', 'snack'], mp.meal_slot) nulls last, mp.created_at)
      from public.meal_plans mp
      join public.food_revisions r on r.id = mp.food_revision_id
      left join public.recipe_revisions rr on rr.food_revision_id = r.id
     where mp.owner_id = v_owner and mp.planned_date between p_from and p_to), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Diary functions from M1/M3, replaced so that a meal logged from a cook
--    session behaves correctly. Each is the earlier function with one addition.
-- ---------------------------------------------------------------------------

-- Editing the amount of a cooked meal rescales the frozen snapshot of the recipe as it
-- was cooked. It is never recalculated from the catalog (the swaps would be lost).
create or replace function public.update_diary_entry(
  p_entry_id uuid,
  p_expected_version integer,
  p_portion_id uuid,
  p_multiplier numeric,
  p_grams numeric,
  p_local_date date default null,
  p_meal_slot text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  e public.diary_entries;
  s public.diary_snapshots;
  v_calc jsonb;
  v_snapshot_id uuid := gen_random_uuid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into e from public.diary_entries where id = p_entry_id and owner_id = v_owner and deleted_at is null for update;
  if not found then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'PT404';
  end if;
  if e.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;
  if p_meal_slot is not null and length(trim(p_meal_slot)) not between 1 and 40 then
    raise exception 'INVALID_MEAL_SLOT' using errcode = 'PT422';
  end if;
  select * into s from public.diary_snapshots where id = e.current_snapshot_id;
  if s.food_revision_id is null then
    raise exception 'SOURCE_FOOD_DELETED' using errcode = 'PT409';
  end if;

  if s.selected_portion ->> 'kind' = 'cooked' then
    if p_portion_id is not null or p_grams is not null or p_multiplier is null or p_multiplier <= 0 or p_multiplier > 100 then
      raise exception 'INVALID_AMOUNT' using errcode = 'PT422';
    end if;
    if e.cook_session_id is not null and p_multiplier + coalesce((
         select sum(s2.quantity) from public.diary_entries e2 join public.diary_snapshots s2 on s2.id = e2.current_snapshot_id
          where e2.cook_session_id = e.cook_session_id and e2.id <> e.id and e2.deleted_at is null), 0)
       > (select cs.servings from public.cook_sessions cs where cs.id = e.cook_session_id) + 0.0001 then
      raise exception 'MORE_THAN_COOKED' using errcode = 'PT422';
    end if;
    v_calc := jsonb_build_object(
      'portion', s.selected_portion || jsonb_build_object('multiplier', p_multiplier),
      'quantity', p_multiplier,
      'resolvedMassG', s.resolved_mass_g * p_multiplier / s.quantity,
      'nutrients', app.scale_nutrients(s.nutrients, p_multiplier / s.quantity));
  else
    v_calc := app.compute_consumption(s.food_revision_id, p_portion_id, p_multiplier, p_grams);
  end if;

  insert into public.diary_snapshots (id, entry_id, revision_no, food_revision_id, display_name, selected_portion,
                                      quantity, resolved_mass_g, nutrients, evidence_snapshot)
  values (v_snapshot_id, e.id, s.revision_no + 1, s.food_revision_id, s.display_name, v_calc -> 'portion',
          (v_calc ->> 'quantity')::numeric, (v_calc ->> 'resolvedMassG')::numeric, v_calc -> 'nutrients',
          s.evidence_snapshot || jsonb_build_object('editedAt', now()));

  update public.diary_entries
     set current_snapshot_id = v_snapshot_id,
         version = version + 1,
         local_date = coalesce(p_local_date, local_date),
         consumed_at = case when p_local_date is not null and p_local_date <> local_date then null else consumed_at end,
         meal_slot = coalesce(trim(p_meal_slot), meal_slot)
   where id = e.id;

  return jsonb_build_object('entryId', e.id, 'version', e.version + 1, 'snapshotId', v_snapshot_id);
end;
$$;

-- Repeating a cooked meal copies its frozen snapshot (the recipe as cooked). The copy is an
-- ordinary home-cooked entry; it is not tied to the cook session.
create or replace function public.repeat_diary_entry(
  p_idempotency_key uuid,
  p_entry_id uuid,
  p_local_date date,
  p_timezone text,
  p_meal_slot text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  e public.diary_entries;
  s public.diary_snapshots;
  v_hash text;
  v_existing public.idempotency_records;
  v_inserted integer;
  v_rev uuid;
  v_portion uuid;
  v_grams numeric;
  v_multiplier numeric;
  v_calc jsonb;
  v_basis text;
  v_slot text;
  v_entry_id uuid := gen_random_uuid();
  v_snapshot_id uuid := gen_random_uuid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'PT422';
  end if;
  if p_local_date is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  if p_timezone is null or not app.is_valid_timezone(p_timezone) then
    raise exception 'INVALID_TIMEZONE' using errcode = 'PT422';
  end if;
  if p_meal_slot is not null and length(trim(p_meal_slot)) not between 1 and 40 then
    raise exception 'INVALID_MEAL_SLOT' using errcode = 'PT422';
  end if;
  select * into e from public.diary_entries where id = p_entry_id and owner_id = v_owner and deleted_at is null;
  if not found then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'PT404';   -- same answer for "not yours"
  end if;
  select * into s from public.diary_snapshots where id = e.current_snapshot_id;
  v_slot := coalesce(trim(p_meal_slot), e.meal_slot);

  v_hash := md5(jsonb_build_array('repeat', p_entry_id, p_local_date, p_timezone, v_slot)::text);
  insert into public.idempotency_records (owner_id, operation, key, request_hash)
  values (v_owner, 'diary.create', p_idempotency_key, v_hash)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select * into v_existing from public.idempotency_records
     where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;
    if v_existing.request_hash <> v_hash then
      raise exception 'IDEMPOTENCY_KEY_REUSED' using errcode = 'PT409';
    end if;
    return (select jsonb_build_object('entryId', x.id, 'version', x.version, 'snapshotId', x.current_snapshot_id, 'replayed', true)
              from public.diary_entries x where x.id = v_existing.result_id);
  end if;

  select fi.current_revision_id into v_rev from public.food_items fi where fi.id = e.food_item_id;
  if v_rev is not null and not (app.can_read_revision(v_rev)
       and exists (select 1 from public.food_revisions r where r.id = v_rev and r.published_at is not null)) then
    v_rev := null;
  end if;
  if s.selected_portion ->> 'kind' = 'cooked' then
    v_rev := null;
  end if;

  if v_rev is not null then
    if s.selected_portion ->> 'kind' = 'grams' then
      v_grams := (s.selected_portion ->> 'grams')::numeric;
    else
      v_multiplier := s.quantity;
      if v_rev = s.food_revision_id then
        v_portion := (s.selected_portion ->> 'portionId')::uuid;
      else
        select po.id into v_portion from public.portions po
         where po.revision_id = v_rev and po.label = s.selected_portion ->> 'label' limit 1;
        if v_portion is null then
          raise exception 'PORTION_CHANGED' using errcode = 'PT409';
        end if;
      end if;
    end if;
    v_calc := app.compute_consumption(v_rev, v_portion, v_multiplier, v_grams);
    v_basis := case when v_rev = s.food_revision_id then 'current' else 'updated' end;
  else
    v_basis := 'copied';
  end if;

  insert into public.diary_entries (id, owner_id, food_item_id, context, meal_slot, consumed_at, local_date, entry_timezone, current_snapshot_id)
  values (v_entry_id, v_owner, e.food_item_id, e.context, v_slot, null, p_local_date, p_timezone, v_snapshot_id);

  if v_rev is not null then
    insert into public.diary_snapshots (id, entry_id, revision_no, food_revision_id, display_name, selected_portion,
                                        quantity, resolved_mass_g, nutrients, evidence_snapshot)
    select v_snapshot_id, v_entry_id, 1, v_rev, r.name, v_calc -> 'portion',
           (v_calc ->> 'quantity')::numeric, (v_calc ->> 'resolvedMassG')::numeric, v_calc -> 'nutrients',
           app.evidence_snapshot(v_rev) || jsonb_build_object('basis', v_calc -> 'basis', 'repeatedFromEntry', e.id)
      from public.food_revisions r where r.id = v_rev;
  else
    insert into public.diary_snapshots (id, entry_id, revision_no, food_revision_id, display_name, selected_portion,
                                        quantity, resolved_mass_g, nutrients, evidence_snapshot)
    values (v_snapshot_id, v_entry_id, 1, s.food_revision_id, s.display_name, s.selected_portion,
            s.quantity, s.resolved_mass_g, s.nutrients,
            s.evidence_snapshot || jsonb_build_object('repeatedFromEntry', e.id, 'copiedFromSnapshot', true));
  end if;

  update public.idempotency_records set result_id = v_entry_id
   where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;

  return jsonb_build_object('entryId', v_entry_id, 'version', 1, 'snapshotId', v_snapshot_id, 'replayed', false, 'basis', v_basis);
end;
$$;

-- The day view also says which entries came from a cook session.
create or replace function public.diary_day(p_date date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_date is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  return jsonb_build_object(
    'date', p_date,
    'status', coalesce((select st.status from public.daily_log_status st where st.owner_id = v_owner and st.local_date = p_date), 'unspecified'),
    'proteinTarget', (select g.target from public.goal_versions g
                       where g.owner_id = v_owner and g.metric = 'protein_g_per_day'
                         and g.effective_from <= p_date and (g.effective_to is null or g.effective_to > p_date)),
    'entries', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'entryId', e.id, 'version', e.version, 'context', e.context, 'mealSlot', e.meal_slot,
                 'foodItemId', e.food_item_id, 'cookSessionId', e.cook_session_id, 'name', s.display_name, 'portion', s.selected_portion,
                 'quantity', s.quantity, 'massG', s.resolved_mass_g, 'revisionNo', s.revision_no,
                 'editable', s.food_revision_id is not null,
                 'nutrients', (select jsonb_object_agg(n.key, jsonb_build_object('value', (n.value ->> 'value')::numeric, 'method', n.value ->> 'method'))
                                 from jsonb_each(s.nutrients) n))
               order by e.created_at, e.id)
          from public.diary_entries e
          join public.diary_snapshots s on s.id = e.current_snapshot_id
         where e.owner_id = v_owner and e.deleted_at is null and e.local_date = p_date), '[]'::jsonb),
    'totals', coalesce((
        select jsonb_object_agg(t.code, jsonb_build_object('known', t.known, 'entryCount', t.entries,
                                                           'unknownEntries', t.unknown, 'estimatedEntries', t.estimated))
          from (select n.key as code,
                       sum((n.value ->> 'value')::numeric) as known,
                       count(*)::integer as entries,
                       (count(*) filter (where n.value ->> 'value' is null))::integer as unknown,
                       (count(*) filter (where n.value ->> 'method' = 'estimated' and n.value ->> 'value' is not null))::integer as estimated
                  from public.diary_entries e
                  join public.diary_snapshots s on s.id = e.current_snapshot_id
                  cross join lateral jsonb_each(s.nutrients) n
                 where e.owner_id = v_owner and e.deleted_at is null and e.local_date = p_date
                 group by n.key) t), '{}'::jsonb)
  );
end;
$$;

-- Week view. "homeMeals" now includes completed cook sessions (owner decision 2026-11-14).
create or replace function public.diary_week(p_start date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_start is null then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  return jsonb_build_object(
    'start', p_start,
    'homeMealsTarget', (select g.target from public.goal_versions g
                         where g.owner_id = v_owner and g.metric = 'cook_sessions_per_week'
                           and g.effective_from < p_start + 7 and (g.effective_to is null or g.effective_to > p_start)
                         order by g.effective_from desc limit 1),
    'days', (
      select jsonb_agg(jsonb_build_object(
               'date', d.day,
               'status', coalesce(st.status, 'unspecified'),
               'entryCount', coalesce(a.entries, 0),
               'proteinKnown', a.protein_known,
               'proteinUnknownEntries', coalesce(a.protein_unknown, 0),
               'proteinEstimatedEntries', coalesce(a.protein_estimated, 0),
               'energyKnown', a.energy_known,
               'energyUnknownEntries', coalesce(a.energy_unknown, 0),
               'homeMeals', coalesce(h.diary_meals, 0) + coalesce(h.cook_meals, 0),
               'homeMealsFromDiary', coalesce(h.diary_meals, 0),
               'cookSessions', coalesce(h.sessions, 0),
               'plannedCount', (select count(*)::integer from public.meal_plans mp
                                 where mp.owner_id = v_owner and mp.planned_date = d.day),
               'proteinTarget', (select g.target from public.goal_versions g
                                  where g.owner_id = v_owner and g.metric = 'protein_g_per_day'
                                    and g.effective_from <= d.day and (g.effective_to is null or g.effective_to > d.day)))
             order by d.day)
        from (select (p_start + i) as day from generate_series(0, 6) i) d
        left join public.daily_log_status st on st.owner_id = v_owner and st.local_date = d.day
        left join lateral (
          select count(*)::integer as entries,
                 sum((s.nutrients -> 'protein_g' ->> 'value')::numeric) as protein_known,
                 (count(*) filter (where s.nutrients -> 'protein_g' ->> 'value' is null))::integer as protein_unknown,
                 (count(*) filter (where s.nutrients -> 'protein_g' ->> 'method' = 'estimated'
                                     and s.nutrients -> 'protein_g' ->> 'value' is not null))::integer as protein_estimated,
                 sum((s.nutrients -> 'energy_kcal' ->> 'value')::numeric) as energy_known,
                 (count(*) filter (where s.nutrients -> 'energy_kcal' ->> 'value' is null))::integer as energy_unknown
            from public.diary_entries e
            join public.diary_snapshots s on s.id = e.current_snapshot_id
           where e.owner_id = v_owner and e.deleted_at is null and e.local_date = d.day
          having count(*) > 0
        ) a on true
        -- Home-cooked meals for the day, each counted once:
        --   a completed cook session is one meal; two sessions eaten at the same meal are one meal;
        --   a home-cooked diary meal counts unless that meal already holds food from a cook session.
        -- Diary entries from a cook session never add to the count by themselves, and a planned
        -- recipe is not counted at all.
        left join lateral (
          with sess as (
            select cs.id,
                   (select lower(e.meal_slot)
                      from public.diary_entries e
                     where e.owner_id = v_owner and e.deleted_at is null and e.local_date = d.day
                       and (e.cook_session_id = cs.id
                            or (e.cook_session_id is null and e.context = 'home' and e.food_item_id = fr.food_item_id))
                     order by e.created_at limit 1) as slot
              from public.cook_sessions cs
              join public.food_revisions fr on fr.id = cs.recipe_revision_id
             where cs.owner_id = v_owner and cs.completed_at is not null and cs.local_date = d.day
          )
          select (select count(*) from sess)::integer as sessions,
                 ((select count(distinct slot) from sess where slot is not null)
                  + (select count(*) from sess where slot is null))::integer as cook_meals,
                 (select count(distinct lower(e.meal_slot))
                    from public.diary_entries e
                   where e.owner_id = v_owner and e.deleted_at is null and e.local_date = d.day
                     and e.context = 'home' and e.cook_session_id is null
                     and lower(e.meal_slot) not in (select slot from sess where slot is not null))::integer as diary_meals
        ) h on true)
  );
end;
$$;

-- The data download now includes cook sessions and plans.
create or replace function public.export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  return jsonb_build_object(
    'exportedAt', now(),
    'preferences', (select jsonb_build_object('diet', p.diet, 'includeConditional', p.include_conditional,
                                              'timezone', p.timezone, 'weekStart', p.week_start)
                      from public.user_preferences p where p.user_id = v_owner),
    'ingredientExclusions', coalesce((select jsonb_agg(x.ingredient_family order by x.ingredient_family)
                                        from public.ingredient_exclusions x where x.owner_id = v_owner), '[]'::jsonb),
    'goals', coalesce((select jsonb_agg(jsonb_build_object('metric', g.metric, 'target', g.target,
                                 'effectiveFrom', g.effective_from, 'effectiveTo', g.effective_to) order by g.metric, g.effective_from)
                         from public.goal_versions g where g.owner_id = v_owner), '[]'::jsonb),
    'dayNotes', coalesce((select jsonb_agg(jsonb_build_object('date', st.local_date, 'status', st.status) order by st.local_date)
                            from public.daily_log_status st where st.owner_id = v_owner), '[]'::jsonb),
    'diaryEntries', coalesce((select jsonb_agg(jsonb_build_object(
                                 'entryId', e.id, 'date', e.local_date, 'timezone', e.entry_timezone, 'mealSlot', e.meal_slot,
                                 'context', e.context, 'name', s.display_name, 'portion', s.selected_portion,
                                 'quantity', s.quantity, 'massG', s.resolved_mass_g, 'nutrients', s.nutrients,
                                 'revisionNo', s.revision_no, 'loggedAt', e.created_at) order by e.local_date, e.created_at)
                                from public.diary_entries e
                                join public.diary_snapshots s on s.id = e.current_snapshot_id
                               where e.owner_id = v_owner and e.deleted_at is null), '[]'::jsonb),
    'cookSessions', coalesce((select jsonb_agg(jsonb_build_object(
                                 'sessionId', cs.id, 'recipe', r.name, 'date', cs.local_date, 'startedAt', cs.started_at,
                                 'completedAt', cs.completed_at, 'abandonedAt', cs.abandoned_at, 'servings', cs.servings,
                                 'substituted', cs.swaps <> '{}'::jsonb) order by cs.started_at)
                                from public.cook_sessions cs join public.food_revisions r on r.id = cs.recipe_revision_id
                               where cs.owner_id = v_owner), '[]'::jsonb),
    'mealPlans', coalesce((select jsonb_agg(jsonb_build_object(
                              'planId', mp.id, 'date', mp.planned_date, 'mealSlot', mp.meal_slot, 'recipe', r.name,
                              'servings', mp.planned_servings) order by mp.planned_date, mp.created_at)
                             from public.meal_plans mp join public.food_revisions r on r.id = mp.food_revision_id
                            where mp.owner_id = v_owner), '[]'::jsonb),
    'customFoods', coalesce((select jsonb_agg(jsonb_build_object(
                                'foodItemId', fi.id, 'name', r.name, 'brand', r.brand,
                                'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
                                'nutrients', (select jsonb_object_agg(nv.nutrient_code, nv.value)
                                                from public.nutrient_values nv where nv.revision_id = r.id),
                                'portions', (select jsonb_agg(jsonb_build_object('label', po.label, 'amount', po.amount, 'unit', po.unit, 'grams', po.grams))
                                               from public.portions po where po.revision_id = r.id),
                                'createdAt', fi.created_at) order by fi.created_at)
                               from public.food_items fi
                               join public.food_revisions r on r.id = fi.current_revision_id
                              where fi.kind = 'custom' and fi.owner_id = v_owner), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants. Recipe reads are public; everything about a person is members only.
--    Helper functions in schema app are not callable over HTTP.
-- ---------------------------------------------------------------------------
revoke execute on function
  app.ingredient_factor(uuid, numeric, text, numeric),
  app.normalize_swaps(uuid, jsonb),
  app.recipe_selection(uuid, jsonb),
  app.recipe_variant_nutrients(uuid, jsonb),
  app.scale_nutrients(jsonb, numeric),
  app.variant_eligibility(uuid, jsonb, text, text[], boolean),
  app.variant_allergens(uuid, jsonb),
  app.member_diet(uuid),
  app.recipe_view(uuid, numeric, jsonb, text, text[], boolean)
from public, anon, authenticated;

revoke execute on function
  public.recipe_detail(uuid, numeric, jsonb, text, text[], boolean, boolean),
  public.recipe_list(jsonb)
from public;
grant execute on function
  public.recipe_detail(uuid, numeric, jsonb, text, text[], boolean, boolean),
  public.recipe_list(jsonb)
to anon, authenticated;

revoke execute on function
  public.start_cook_session(uuid, uuid, numeric, jsonb, date, text, uuid, boolean),
  public.my_cook_session(uuid),
  public.save_cook_progress(uuid, integer, uuid[]),
  public.complete_cook_session(uuid, date, text),
  public.abandon_cook_session(uuid),
  public.decline_cook_log(uuid),
  public.log_cook_session(uuid, uuid, numeric, text, date, text, boolean),
  public.my_cooking(date),
  public.plan_recipe(uuid, date, numeric, text, boolean),
  public.remove_plan(uuid),
  public.my_plan(date, date)
from public, anon;
grant execute on function
  public.start_cook_session(uuid, uuid, numeric, jsonb, date, text, uuid, boolean),
  public.my_cook_session(uuid),
  public.save_cook_progress(uuid, integer, uuid[]),
  public.complete_cook_session(uuid, date, text),
  public.abandon_cook_session(uuid),
  public.decline_cook_log(uuid),
  public.log_cook_session(uuid, uuid, numeric, text, date, text, boolean),
  public.my_cooking(date),
  public.plan_recipe(uuid, date, numeric, text, boolean),
  public.remove_plan(uuid),
  public.my_plan(date, date)
to authenticated;
