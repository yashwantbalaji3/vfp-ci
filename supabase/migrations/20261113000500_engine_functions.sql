-- M1 · Nutrition, eligibility, diary, custom food, goal and publication functions.
-- Requirement IDs: R-003, R-005, R-F02, R-F04, R-F06, R-G02, R-D08, R-C07, R-O01.
-- Spec: docs/07 (formulas), 08 (publication gate), 11 (idempotency/concurrency), 18 (exclusions).
--
-- Error codes follow PostgREST's custom-status convention (PTxyz -> HTTP xyz):
-- PT401 not signed in, PT403 forbidden, PT404 not found/not owned, PT409 conflict,
-- PT422 semantic input error. Messages are stable machine codes.

-- ---------------------------------------------------------------------------
-- Unit conversion (doc 07). Only exact unit definitions; cup/piece/bowl need a
-- defined portion mapping, and volume never converts to mass without a density.
-- ---------------------------------------------------------------------------
create function app.unit_to_grams(p_amount numeric, p_unit text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select p_amount * case lower(p_unit)
    when 'g' then 1::numeric
    when 'kg' then 1000::numeric
    when 'mg' then 0.001::numeric
    when 'oz' then 28.349523125::numeric
    when 'lb' then 453.59237::numeric
    else null end;
$$;

create function app.unit_to_ml(p_amount numeric, p_unit text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select p_amount * case lower(p_unit)
    when 'ml' then 1::numeric
    when 'l' then 1000::numeric
    when 'fl_oz' then 29.5735295625::numeric
    else null end;
$$;

-- ---------------------------------------------------------------------------
-- Snapshot calculation. Returns the multiplier against the revision's nutrition
-- basis (null when no defensible conversion exists) and the frozen nutrient map.
-- ---------------------------------------------------------------------------
create function app.compute_consumption(
  p_revision_id uuid,
  p_portion_id  uuid,
  p_multiplier  numeric,
  p_grams       numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r          public.food_revisions;
  p          public.portions;
  v_factor   numeric;   -- consumed amount / basis amount
  v_mass     numeric;   -- resolved grams, when known
  v_quantity numeric;
  v_portion  jsonb;
  v_serving_g numeric;
  v_nutrients jsonb := '{}'::jsonb;
  d record;
  nv public.nutrient_values;
begin
  select * into r from public.food_revisions where id = p_revision_id;
  if not found then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;

  if (p_portion_id is null) = (p_grams is null) then
    raise exception 'CHOOSE_PORTION_OR_GRAMS' using errcode = 'PT422';
  end if;

  if p_grams is not null then
    if p_grams <= 0 or p_grams > 100000 then
      raise exception 'INVALID_AMOUNT' using errcode = 'PT422';
    end if;
    v_quantity := p_grams;
    v_mass := p_grams;
    v_portion := jsonb_build_object('kind', 'grams', 'grams', p_grams);
    if r.basis_kind = 'mass' then
      v_factor := p_grams / r.basis_amount;
    elsif r.basis_kind = 'serving' then
      -- Grams convert to servings only through a sourced serving weight.
      select (pp.grams / pp.amount) into v_serving_g
        from public.portions pp
       where pp.revision_id = r.id and pp.unit = 'serving' and pp.grams is not null
       order by pp.label limit 1;
      if v_serving_g is null then
        raise exception 'UNSUPPORTED_MASS_CONVERSION' using errcode = 'PT422';
      end if;
      v_factor := (p_grams / v_serving_g) / r.basis_amount;
    else
      raise exception 'UNSUPPORTED_MASS_CONVERSION' using errcode = 'PT422';
    end if;
  else
    if p_multiplier is null or p_multiplier <= 0 or p_multiplier > 100 then
      raise exception 'INVALID_AMOUNT' using errcode = 'PT422';
    end if;
    select * into p from public.portions where id = p_portion_id and revision_id = r.id;
    if not found then
      raise exception 'INVALID_PORTION' using errcode = 'PT422';
    end if;
    v_quantity := p_multiplier;
    v_portion := jsonb_build_object('kind', 'defined', 'portionId', p.id, 'label', p.label,
                                    'amount', p.amount, 'unit', p.unit, 'grams', p.grams, 'multiplier', p_multiplier);
    v_mass := coalesce(p.grams, app.unit_to_grams(p.amount, p.unit)) * p_multiplier;
    if r.basis_kind = 'mass' then
      v_factor := v_mass / r.basis_amount;              -- null when portion has no gram mapping (F11)
    elsif r.basis_kind = 'volume' then
      v_factor := coalesce(p.milliliters, app.unit_to_ml(p.amount, p.unit)) * p_multiplier / r.basis_amount;
    else
      if p.unit = 'serving' then
        v_factor := p.amount * p_multiplier / r.basis_amount;
      else
        select (pp.grams / pp.amount) into v_serving_g
          from public.portions pp
         where pp.revision_id = r.id and pp.unit = 'serving' and pp.grams is not null
         order by pp.label limit 1;
        v_factor := case when v_mass is not null and v_serving_g is not null
                         then (v_mass / v_serving_g) / r.basis_amount end;
      end if;
    end if;
    if v_mass is not null and v_mass > 100000 then
      raise exception 'INVALID_AMOUNT' using errcode = 'PT422';
    end if;
  end if;

  for d in select code, canonical_unit from public.nutrient_definitions order by display_order loop
    select * into nv from public.nutrient_values where revision_id = r.id and nutrient_code = d.code;
    if not found then
      v_nutrients := v_nutrients || jsonb_build_object(d.code, jsonb_build_object(
        'value', null, 'unit', d.canonical_unit, 'method', 'unknown', 'missingReason', 'not_provided', 'sourceRecordId', null));
    elsif nv.value is null then
      v_nutrients := v_nutrients || jsonb_build_object(d.code, jsonb_build_object(
        'value', null, 'unit', d.canonical_unit, 'method', nv.method, 'missingReason', nv.missing_reason, 'sourceRecordId', nv.source_record_id));
    elsif v_factor is null then
      v_nutrients := v_nutrients || jsonb_build_object(d.code, jsonb_build_object(
        'value', null, 'unit', d.canonical_unit, 'method', nv.method, 'missingReason', 'unavailable_conversion', 'sourceRecordId', nv.source_record_id));
    else
      v_nutrients := v_nutrients || jsonb_build_object(d.code, jsonb_build_object(
        'value', nv.value * v_factor,
        'lower', nv.lower_value * v_factor,
        'upper', nv.upper_value * v_factor,
        'unit', d.canonical_unit, 'method', nv.method, 'missingReason', null, 'sourceRecordId', nv.source_record_id));
    end if;
  end loop;

  return jsonb_build_object(
    'factor', v_factor,
    'resolvedMassG', v_mass,
    'quantity', v_quantity,
    'portion', v_portion,
    'nutrients', v_nutrients,
    'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit)
  );
end;
$$;

-- Evidence frozen into each diary snapshot (what the member saw when logging).
create function app.evidence_snapshot(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'foodItemId', r.food_item_id,
    'foodKind', fi.kind,
    'revisionNo', r.revision_no,
    'name', r.name,
    'brand', r.brand,
    'isDemo', fi.is_demo,
    'capturedAt', now(),
    'dietaryClaims', coalesce((
      select jsonb_agg(jsonb_build_object('diet', c.diet, 'outcome', c.outcome, 'evidenceTier', c.evidence_tier,
             'checkedAt', c.checked_at, 'expiresAt', c.expires_at, 'conflictState', c.conflict_state) order by c.diet)
      from public.dietary_claims c where c.revision_id = r.id), '[]'::jsonb),
    'ingredientFamilies', coalesce((
      select jsonb_agg(jsonb_build_object('family', s.family, 'presence', s.presence, 'checkedAt', s.checked_at) order by s.family)
      from public.ingredient_family_statements s where s.revision_id = r.id), '[]'::jsonb)
  )
  from public.food_revisions r
  join public.food_items fi on fi.id = r.food_item_id
  where r.id = p_revision_id;
$$;

-- ---------------------------------------------------------------------------
-- Ingredient-family presence and dietary eligibility (doc 18, R-D08, R-C07).
-- Unknown is never treated as absent. Expired statements count as unknown.
-- ---------------------------------------------------------------------------
create function app.direct_family_presence(p_revision_id uuid, p_family text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.ingredient_family_statements s
      where s.revision_id = p_revision_id and s.family = p_family and s.presence = 'present'
    ) then 'present'
    -- An allergen declaration of egg/milk is positive evidence of the family.
    when exists (
      select 1 from public.allergen_statements a
      where a.revision_id = p_revision_id and a.presence = 'present'
        and ((p_family = 'egg' and a.allergen = 'egg') or (p_family = 'dairy' and a.allergen = 'milk'))
    ) then 'present'
    when exists (
      select 1 from public.ingredient_family_statements s
      where s.revision_id = p_revision_id and s.family = p_family and s.presence = 'absent_by_statement'
        and (s.expires_at is null or s.expires_at > now())
    ) then 'absent_by_statement'
    else 'unknown'
  end;
$$;

create function app.family_presence(p_revision_id uuid, p_family text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_direct text := app.direct_family_presence(p_revision_id, p_family);
  v_count integer;
  v_present boolean;
  v_unknown boolean;
begin
  if v_direct = 'present' then
    return 'present';
  end if;
  select count(*),
         bool_or(app.direct_family_presence(ri.ingredient_revision_id, p_family) = 'present'),
         bool_or(app.direct_family_presence(ri.ingredient_revision_id, p_family) = 'unknown')
    into v_count, v_present, v_unknown
    from public.recipe_ingredients ri
   where ri.recipe_revision_id = p_revision_id
     and (not ri.optional or ri.included_by_default);
  if v_count = 0 then
    return v_direct;                         -- not a recipe (or no included ingredients)
  end if;
  if v_present then return 'present'; end if;
  if v_unknown then return 'unknown'; end if;  -- a recipe-level "absent" cannot override an unknown ingredient
  return 'absent_by_statement';
end;
$$;

-- Status precedence: excluded > needs_confirmation > conditional > eligible.
create function app.eligibility(
  p_revision_id uuid,
  p_diet text,
  p_exclusions text[],
  p_include_conditional boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reasons jsonb := '[]'::jsonb;
  v_rank integer := 0;   -- 0 eligible, 1 conditional, 2 needs_confirmation, 3 excluded
  c public.dietary_claims;
  f record;
  v_presence text;
begin
  if p_diet not in ('none', 'vegetarian', 'vegan') then
    raise exception 'INVALID_DIET' using errcode = 'PT422';
  end if;
  if exists (select 1 from unnest(coalesce(p_exclusions, '{}')) x
             where x not in (select code from public.ingredient_families)) then
    raise exception 'INVALID_EXCLUSION' using errcode = 'PT422';
  end if;

  if p_diet <> 'none' then
    select * into c from public.dietary_claims where revision_id = p_revision_id and diet = p_diet;
    -- A strict vegan claim also answers a vegetarian question.
    if not found and p_diet = 'vegetarian' then
      select * into c from public.dietary_claims
       where revision_id = p_revision_id and diet = 'vegan' and outcome = 'compatible';
    end if;
    if c.id is null then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'no_dietary_claim', 'diet', p_diet);
    elsif c.outcome = 'incompatible' then
      v_rank := 3; v_reasons := v_reasons || jsonb_build_object('code', 'diet_incompatible', 'diet', p_diet);
    elsif c.conflict_state = 'disputed' then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'dietary_claim_disputed', 'diet', p_diet);
    elsif c.expires_at is not null and c.expires_at <= now() then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'dietary_claim_expired', 'diet', p_diet);
    elsif c.outcome = 'unknown' or c.evidence_tier in ('community_report', 'unknown') then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'dietary_evidence_insufficient', 'diet', p_diet);
    elsif c.outcome = 'conditional' then
      v_rank := greatest(v_rank, case when p_include_conditional then 1 else 2 end);
      v_reasons := v_reasons || jsonb_build_object('code', 'requires_modification', 'diet', p_diet, 'modifications', c.modifications);
    end if;

    -- Positive evidence of a forbidden family overrides any diet claim.
    for f in select code from public.ingredient_families
             where (p_diet = 'vegan' and non_vegan) or (p_diet = 'vegetarian' and non_vegetarian) loop
      if app.family_presence(p_revision_id, f.code) = 'present' then
        v_rank := 3; v_reasons := v_reasons || jsonb_build_object('code', 'contains_family', 'family', f.code);
      end if;
    end loop;
  end if;

  -- Explicit exclusions: present excludes, unknown needs confirmation (never "safe").
  for f in select distinct x as code from unnest(coalesce(p_exclusions, '{}')) x order by 1 loop
    v_presence := app.family_presence(p_revision_id, f.code);
    if v_presence = 'present' then
      v_rank := 3; v_reasons := v_reasons || jsonb_build_object('code', 'contains_excluded_family', 'family', f.code);
    elsif v_presence = 'unknown' then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'unconfirmed_excluded_family', 'family', f.code);
    end if;
  end loop;

  return jsonb_build_object(
    'status', (array['eligible', 'conditional', 'needs_confirmation', 'excluded'])[v_rank + 1],
    'reasons', v_reasons
  );
end;
$$;

-- Public entry points (respect visibility; same rules everywhere).
create function public.check_eligibility(
  p_revision_id uuid, p_diet text, p_exclusions text[], p_include_conditional boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not app.can_read_revision(p_revision_id) then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  return app.eligibility(p_revision_id, p_diet, p_exclusions, p_include_conditional);
end;
$$;

create function public.my_eligibility(p_revision_id uuid, p_include_conditional boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_diet text;
  v_excl text[];
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if not app.can_read_revision(p_revision_id) then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  select diet, eligibility_version into v_diet, v_version from public.user_preferences where user_id = auth.uid();
  select array_agg(ingredient_family order by ingredient_family) into v_excl
    from public.ingredient_exclusions where owner_id = auth.uid();
  return app.eligibility(p_revision_id, coalesce(v_diet, 'none'), coalesce(v_excl, '{}'), p_include_conditional)
         || jsonb_build_object('eligibilityVersion', coalesce(v_version, 0));
end;
$$;

-- ---------------------------------------------------------------------------
-- Diary writes (R-F02, R-F04, R-F05, R-F06). Entry + snapshot + idempotency
-- result commit together. Clients cannot submit owner ids or computed totals.
-- ---------------------------------------------------------------------------
create function public.log_food_entry(
  p_idempotency_key uuid,
  p_food_revision_id uuid,
  p_portion_id uuid,
  p_multiplier numeric,
  p_grams numeric,
  p_context text,
  p_meal_slot text,
  p_local_date date,
  p_timezone text,
  p_consumed_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_hash text;
  v_existing public.idempotency_records;
  v_calc jsonb;
  v_entry_id uuid := gen_random_uuid();
  v_snapshot_id uuid := gen_random_uuid();
  v_item_id uuid;
  v_inserted integer;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'PT422';
  end if;
  if p_context not in ('home', 'restaurant', 'packaged') then
    raise exception 'INVALID_CONTEXT' using errcode = 'PT422';
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
  if p_consumed_at is not null and (p_consumed_at at time zone p_timezone)::date <> p_local_date then
    raise exception 'DATE_DOES_NOT_MATCH_TIME' using errcode = 'PT422';
  end if;
  if not app.can_read_revision(p_food_revision_id)
     or not exists (select 1 from public.food_revisions r where r.id = p_food_revision_id and r.published_at is not null) then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;

  v_hash := md5(jsonb_build_array(p_food_revision_id, p_portion_id, p_multiplier, p_grams, p_context,
                                  p_meal_slot, p_local_date, p_timezone, p_consumed_at)::text);

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
    return (select jsonb_build_object('entryId', e.id, 'version', e.version, 'snapshotId', e.current_snapshot_id, 'replayed', true)
              from public.diary_entries e where e.id = v_existing.result_id);
  end if;

  v_calc := app.compute_consumption(p_food_revision_id, p_portion_id, p_multiplier, p_grams);
  select food_item_id into v_item_id from public.food_revisions where id = p_food_revision_id;

  insert into public.diary_entries (id, owner_id, food_item_id, context, meal_slot, consumed_at, local_date, entry_timezone, current_snapshot_id)
  values (v_entry_id, v_owner, v_item_id, p_context, trim(p_meal_slot), p_consumed_at, p_local_date, p_timezone, v_snapshot_id);

  insert into public.diary_snapshots (id, entry_id, revision_no, food_revision_id, display_name, selected_portion,
                                      quantity, resolved_mass_g, nutrients, evidence_snapshot)
  select v_snapshot_id, v_entry_id, 1, p_food_revision_id, r.name, v_calc -> 'portion',
         (v_calc ->> 'quantity')::numeric, (v_calc ->> 'resolvedMassG')::numeric, v_calc -> 'nutrients',
         app.evidence_snapshot(p_food_revision_id) || jsonb_build_object('basis', v_calc -> 'basis')
    from public.food_revisions r where r.id = p_food_revision_id;

  update public.idempotency_records set result_id = v_entry_id
   where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;

  return jsonb_build_object('entryId', v_entry_id, 'version', 1, 'snapshotId', v_snapshot_id, 'replayed', false);
end;
$$;

-- Editing creates a new snapshot revision from the SAME food revision the entry
-- was logged with; catalog changes are never pulled in silently (F07).
create function public.update_diary_entry(
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

  v_calc := app.compute_consumption(s.food_revision_id, p_portion_id, p_multiplier, p_grams);

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

create function public.delete_diary_entry(p_entry_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  e public.diary_entries;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into e from public.diary_entries where id = p_entry_id and owner_id = v_owner for update;
  if not found then
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'PT404';   -- same answer for "not yours"
  end if;
  if e.deleted_at is not null then
    return jsonb_build_object('entryId', e.id, 'deleted', true, 'alreadyDeleted', true);
  end if;
  if e.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;
  update public.diary_entries set deleted_at = now(), version = version + 1 where id = e.id;
  return jsonb_build_object('entryId', e.id, 'deleted', true, 'alreadyDeleted', false);
end;
$$;

-- Per-day, per-nutrient aggregates of the caller's own active entries (R-F07, R-G03).
-- Uses snapshots only; null values are counted as unknown, never as zero.
create function public.diary_day_totals(p_from date, p_to date)
returns table (
  local_date date,
  nutrient_code text,
  entry_count integer,
  known_subtotal numeric,
  unknown_entries integer,
  estimated_entries integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then
    raise exception 'INVALID_RANGE' using errcode = 'PT422';
  end if;
  return query
  select e.local_date,
         n.key,
         count(*)::integer,
         sum((n.value ->> 'value')::numeric),
         count(*) filter (where n.value ->> 'value' is null)::integer,
         count(*) filter (where n.value ->> 'method' = 'estimated' and n.value ->> 'value' is not null)::integer
    from public.diary_entries e
    join public.diary_snapshots s on s.id = e.current_snapshot_id
    cross join lateral jsonb_each(s.nutrients) n
   where e.owner_id = auth.uid()
     and e.deleted_at is null
     and e.local_date between p_from and p_to
   group by e.local_date, n.key
   order by e.local_date, n.key;
end;
$$;

-- ---------------------------------------------------------------------------
-- Private custom foods (R-F03). Created atomically as an owner-only food with a
-- first revision. No publish flag exists; a public contribution is a separate object.
-- p_nutrients: {"protein_g": 12.5, "energy_kcal": null, ...} (missing key = not provided)
-- p_portions:  [{"label": "1 bar", "amount": 1, "unit": "serving", "grams": 40}]
-- ---------------------------------------------------------------------------
create function public.create_custom_food(
  p_name text,
  p_brand text,
  p_basis_kind text,
  p_basis_amount numeric,
  p_nutrients jsonb,
  p_portions jsonb default '[]'::jsonb,
  p_source_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_item uuid := gen_random_uuid();
  v_rev uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_record uuid := gen_random_uuid();
  v_unit text;
  d record;
  v_val numeric;
  pp jsonb;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if octet_length(coalesce(p_nutrients::text, '') || coalesce(p_portions::text, '') || coalesce(p_name, '') || coalesce(p_source_note, '')) > 32768 then
    raise exception 'BODY_TOO_LARGE' using errcode = 'PT422';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 200 then
    raise exception 'INVALID_NAME' using errcode = 'PT422';
  end if;
  if p_basis_kind not in ('mass', 'volume', 'serving') or p_basis_amount is null or p_basis_amount <= 0 or p_basis_amount > 100000 then
    raise exception 'INVALID_BASIS' using errcode = 'PT422';
  end if;
  if jsonb_typeof(coalesce(p_nutrients, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_portions, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_nutrients, '{}'::jsonb)) k
             where k not in (select code from public.nutrient_definitions)) then
    raise exception 'UNKNOWN_NUTRIENT' using errcode = 'PT422';
  end if;
  v_unit := case p_basis_kind when 'mass' then 'g' when 'volume' then 'ml' else 'serving' end;

  insert into public.sources (id, publisher, source_type, access_scope, owner_id)
  values (v_source, 'Entered by member', 'user_entered', 'private', v_owner);
  insert into public.source_records (id, source_id, observed_at, evidence_summary, rights_status)
  values (v_record, v_source, now(), left(p_source_note, 2000), 'restricted');

  insert into public.food_items (id, kind, owner_id, visibility, status)
  values (v_item, 'custom', v_owner, 'private', 'published');
  insert into public.food_revisions (id, food_item_id, revision_no, name, brand, basis_kind, basis_amount, basis_unit)
  values (v_rev, v_item, 1, trim(p_name), nullif(trim(p_brand), ''), p_basis_kind, p_basis_amount, v_unit);

  for d in select code, canonical_unit from public.nutrient_definitions loop
    if p_nutrients ? d.code and jsonb_typeof(p_nutrients -> d.code) <> 'null' then
      if jsonb_typeof(p_nutrients -> d.code) <> 'number' then
        raise exception 'INVALID_NUTRIENT_VALUE' using errcode = 'PT422';
      end if;
      v_val := (p_nutrients ->> d.code)::numeric;
      if v_val < 0 or (p_basis_kind = 'mass' and d.canonical_unit = 'g' and v_val > p_basis_amount) then
        raise exception 'INVALID_NUTRIENT_VALUE' using errcode = 'PT422';
      end if;
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method)
      values (v_rev, d.code, v_val, v_record, 'user_entered');
    else
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason)
      values (v_rev, d.code, null, v_record, 'user_entered', 'not_provided');
    end if;
  end loop;

  for pp in select * from jsonb_array_elements(coalesce(p_portions, '[]'::jsonb)) loop
    insert into public.portions (revision_id, label, amount, unit, grams, source_record_id)
    values (v_rev, pp ->> 'label', (pp ->> 'amount')::numeric, pp ->> 'unit', (pp ->> 'grams')::numeric, v_record);
  end loop;
  if p_basis_kind = 'serving' and not exists (select 1 from public.portions where revision_id = v_rev and unit = 'serving') then
    insert into public.portions (revision_id, label, amount, unit, source_record_id)
    values (v_rev, '1 serving', 1, 'serving', v_record);
  end if;

  update public.food_revisions set published_at = now() where id = v_rev;
  update public.food_items set current_revision_id = v_rev where id = v_item;

  return jsonb_build_object('foodItemId', v_item, 'revisionId', v_rev);
exception
  when check_violation or not_null_violation or invalid_text_representation or unique_violation then
    raise exception 'INVALID_CUSTOM_FOOD' using errcode = 'PT422';
end;
$$;

-- ---------------------------------------------------------------------------
-- Goals (R-G01, R-G02). A new target applies from p_effective_from onward and
-- never rewrites earlier days. p_target null disables the goal from that date.
-- ---------------------------------------------------------------------------
create function public.set_goal(p_metric text, p_target numeric, p_effective_from date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_metric not in ('protein_g_per_day', 'cook_sessions_per_week') or p_effective_from is null then
    raise exception 'INVALID_GOAL' using errcode = 'PT422';
  end if;
  -- Serialize goal edits per member and metric.
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text || p_metric, 0));

  -- Future versions starting on/after the new date are superseded.
  delete from public.goal_versions
   where owner_id = v_owner and metric = p_metric and effective_from >= p_effective_from;
  -- The version covering the new date now ends there.
  update public.goal_versions
     set effective_to = p_effective_from
   where owner_id = v_owner and metric = p_metric
     and effective_from < p_effective_from
     and (effective_to is null or effective_to > p_effective_from);

  if p_target is null then
    return jsonb_build_object('metric', p_metric, 'disabledFrom', p_effective_from);
  end if;
  insert into public.goal_versions (owner_id, metric, target, effective_from)
  values (v_owner, p_metric, p_target, p_effective_from)
  returning id into v_id;
  return jsonb_build_object('goalVersionId', v_id, 'metric', p_metric, 'target', p_target, 'effectiveFrom', p_effective_from);
exception
  when check_violation then
    raise exception 'GOAL_OUT_OF_RANGE' using errcode = 'PT422';
end;
$$;

-- ---------------------------------------------------------------------------
-- Publication gate (doc 08, R-O01). Publisher role only; audited.
-- ---------------------------------------------------------------------------
create function public.publish_food_revision(p_revision_id uuid, p_expected_item_version integer, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.food_revisions;
  fi public.food_items;
  v_failures text[] := '{}';
begin
  if not app.has_role('publisher') then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  select * into r from public.food_revisions where id = p_revision_id for update;
  if not found then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  select * into fi from public.food_items where id = r.food_item_id for update;
  if fi.visibility <> 'public' then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  if r.published_at is not null then
    raise exception 'ALREADY_PUBLISHED' using errcode = 'PT409';
  end if;
  if fi.version <> p_expected_item_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  -- 1. Rights: every cited source record is cleared and its license permits display.
  if exists (
    select 1 from (
      select source_record_id from public.nutrient_values where revision_id = r.id
      union all select source_record_id from public.dietary_claims where revision_id = r.id
      union all select source_record_id from public.allergen_statements where revision_id = r.id
      union all select source_record_id from public.ingredient_family_statements where revision_id = r.id
      union all select source_record_id from public.portions where revision_id = r.id
      union all select rights_record_id from public.recipe_revisions where food_revision_id = r.id
    ) cited
    join public.source_records sr on sr.id = cited.source_record_id
    join public.sources s on s.id = sr.source_id
    left join public.licenses l on l.id = s.license_id
    where sr.rights_status <> 'cleared' or l.id is null or not ('display' = any (l.permitted_uses))
       or (l.expiry is not null and l.expiry < current_date)
  ) then
    v_failures := array_append(v_failures, 'rights_not_cleared');
  end if;

  -- 2. Dietary claims need a freshness due date and no unresolved conflict.
  if exists (select 1 from public.dietary_claims where revision_id = r.id and (expires_at is null or conflict_state = 'disputed')) then
    v_failures := array_append(v_failures, 'dietary_claim_not_publishable');
  end if;

  -- 3. Mass-basis gram nutrients cannot exceed the basis mass (e.g. >100 g protein per 100 g).
  if r.basis_kind = 'mass' and exists (
    select 1 from public.nutrient_values nv join public.nutrient_definitions nd on nd.code = nv.nutrient_code
    where nv.revision_id = r.id and nd.canonical_unit = 'g' and nv.value > r.basis_amount
  ) then
    v_failures := array_append(v_failures, 'impossible_nutrient_value');
  end if;

  -- 4. Recipes need rights evidence and a recorded trial cook.
  if fi.kind = 'recipe' and not exists (
    select 1 from public.recipe_revisions rr where rr.food_revision_id = r.id
      and rr.rights_record_id is not null and rr.trial_cooked_at is not null
  ) then
    v_failures := array_append(v_failures, 'recipe_not_reviewed');
  end if;

  if cardinality(v_failures) > 0 then
    raise exception 'PUBLISH_GATE_FAILED' using errcode = 'PT422', detail = array_to_string(v_failures, ',');
  end if;

  update public.food_revisions set published_at = now() where id = r.id;
  update public.food_items
     set current_revision_id = r.id, status = 'published', version = version + 1
   where id = fi.id;
  perform app.audit('publish_food_revision', 'food_revision', r.id, p_reason);
  insert into public.outbox_jobs (kind, object_id, dedupe_key)
  values ('cache_invalidate', fi.id, 'publish:' || r.id::text)
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object('foodItemId', fi.id, 'revisionId', r.id, 'itemVersion', fi.version + 1);
end;
$$;

-- Flag a published dietary claim as disputed: the one editorial field that may change
-- after publication. Strict filters stop qualifying it immediately (J5, F15).
create function public.flag_dietary_conflict(p_claim_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_catalog_editor() then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED' using errcode = 'PT422';
  end if;
  perform set_config('app.allow_conflict_flag', 'on', true);
  update public.dietary_claims set conflict_state = 'disputed' where id = p_claim_id;
  if not found then
    raise exception 'CLAIM_NOT_FOUND' using errcode = 'PT404';
  end if;
  perform set_config('app.allow_conflict_flag', 'off', true);
  perform app.audit('flag_dietary_conflict', 'dietary_claim', p_claim_id, p_reason);
  return jsonb_build_object('claimId', p_claim_id, 'conflictState', 'disputed');
end;
$$;

-- Allow exactly that one change through the immutability guard.
create or replace function app.guard_revision_child()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_rev uuid;
begin
  if tg_table_name = 'dietary_claims' and tg_op = 'UPDATE'
     and current_setting('app.allow_conflict_flag', true) = 'on'
     and (to_jsonb(new) - 'conflict_state') = (to_jsonb(old) - 'conflict_state') then
    return new;
  end if;
  -- Rows of different tables name their revision column differently.
  v_rev := coalesce(
    to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'revision_id',
    to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'recipe_revision_id',
    to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'food_revision_id'
  )::uuid;
  if exists (
    select 1 from public.food_revisions r
    join public.food_items fi on fi.id = r.food_item_id
    where r.id = v_rev and r.published_at is not null
      and not (tg_op = 'DELETE' and fi.visibility = 'private')
  ) then
    raise exception 'Revision % is published and its evidence is immutable', v_rev using errcode = 'PT403';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute grants: callable functions are explicit; everything else stays closed.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.has_role(text), app.can_read_food_item(uuid), app.can_read_revision(uuid),
  app.is_catalog_editor(), app.is_valid_timezone(text), app.is_public_draft_revision(uuid) to anon, authenticated;

revoke execute on function public.check_eligibility(uuid, text, text[], boolean),
  public.my_eligibility(uuid, boolean),
  public.log_food_entry(uuid, uuid, uuid, numeric, numeric, text, text, date, text, timestamptz),
  public.update_diary_entry(uuid, integer, uuid, numeric, numeric, date, text),
  public.delete_diary_entry(uuid, integer),
  public.diary_day_totals(date, date),
  public.create_custom_food(text, text, text, numeric, jsonb, jsonb, text),
  public.set_goal(text, numeric, date),
  public.publish_food_revision(uuid, integer, text),
  public.flag_dietary_conflict(uuid, text)
  from public, anon;

grant execute on function public.check_eligibility(uuid, text, text[], boolean) to anon, authenticated;
grant execute on function public.my_eligibility(uuid, boolean),
  public.log_food_entry(uuid, uuid, uuid, numeric, numeric, text, text, date, text, timestamptz),
  public.update_diary_entry(uuid, integer, uuid, numeric, numeric, date, text),
  public.delete_diary_entry(uuid, integer),
  public.diary_day_totals(date, date),
  public.create_custom_food(text, text, text, numeric, jsonb, jsonb, text),
  public.set_goal(text, numeric, date),
  public.publish_food_revision(uuid, integer, text),
  public.flag_dietary_conflict(uuid, text)
  to authenticated;
