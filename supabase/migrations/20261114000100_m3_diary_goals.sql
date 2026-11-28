-- M3 · Food Diary and Goals: read models, repeat, undo, quick custom foods,
-- signed-in dietary preferences and the member's own data export.
-- Requirement IDs: R-F01..R-F08, R-G01..R-G05, R-D08, export baseline (docs/15).
-- Everything here is owner-only. No function accepts an owner id from the caller,
-- and none is executable by guests. Unknown nutrient values stay null (never zero).

-- ---------------------------------------------------------------------------
-- Preferences: the "also show dishes that fit with a change" choice follows the member.
-- ---------------------------------------------------------------------------
alter table public.user_preferences
  add column include_conditional boolean not null default false;

-- ---------------------------------------------------------------------------
-- What the log form needs for one food: its portions and what each portion
-- contributes. Works for published catalog foods and the caller's own custom foods.
-- ---------------------------------------------------------------------------
create function public.loggable_food(p_food_item_id uuid, p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  fi public.food_items;
  r public.food_revisions;
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into fi from public.food_items
   where id = p_food_item_id
     and ((visibility = 'public' and status = 'published' and (p_include_demo or not is_demo))
          or (visibility = 'private' and owner_id = v_owner));
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into r from public.food_revisions where id = fi.current_revision_id and published_at is not null;
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;

  return jsonb_build_object(
    'foodItemId', fi.id, 'revisionId', r.id, 'kind', fi.kind, 'isOwn', fi.visibility = 'private', 'isDemo', fi.is_demo,
    'name', r.name, 'brand', r.brand,
    'venueName', (select v.name from public.dishes d join public.venues v on v.id = d.venue_id where d.food_item_id = fi.id),
    'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
    'gramsSupported', r.basis_kind = 'mass' or (r.basis_kind = 'serving' and exists (
        select 1 from public.portions pp where pp.revision_id = r.id and pp.unit = 'serving' and pp.grams is not null)),
    'portions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', po.id, 'label', po.label, 'amount', po.amount, 'unit', po.unit,
                 'grams', coalesce(po.grams, app.unit_to_grams(po.amount, po.unit)),
                 'nutrients', (select jsonb_object_agg(n.key, jsonb_build_object('value', (n.value ->> 'value')::numeric, 'method', n.value ->> 'method'))
                                 from jsonb_each(app.compute_consumption(r.id, po.id, 1, null) -> 'nutrients') n))
               order by po.label)
          from public.portions po where po.revision_id = r.id), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Day view. Totals come from snapshots only. "known" is the sum of the values we
-- have; unknownEntries says how many entries have no value, so the screen can say
-- "at least" instead of presenting a partial sum as a total.
-- ---------------------------------------------------------------------------
create function public.diary_day(p_date date)
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
                 'foodItemId', e.food_item_id, 'name', s.display_name, 'portion', s.selected_portion,
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

-- ---------------------------------------------------------------------------
-- Week view: one row per calendar day of the seven starting at p_start. A day
-- with nothing logged has entryCount 0 and null sums; it is never a zero intake.
-- A "home-cooked meal" is one meal slot on one day with at least one entry the
-- member marked as home-cooked.
-- ---------------------------------------------------------------------------
create function public.diary_week(p_start date)
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
               'homeMeals', coalesce(a.home_meals, 0),
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
                 (count(*) filter (where s.nutrients -> 'energy_kcal' ->> 'value' is null))::integer as energy_unknown,
                 (count(distinct lower(e.meal_slot)) filter (where e.context = 'home'))::integer as home_meals
            from public.diary_entries e
            join public.diary_snapshots s on s.id = e.current_snapshot_id
           where e.owner_id = v_owner and e.deleted_at is null and e.local_date = d.day
          having count(*) > 0
        ) a on true)
  );
end;
$$;

-- The member's goals in force on a given day (null when none is set).
create function public.my_goals(p_date date)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'proteinPerDay', (select jsonb_build_object('target', g.target, 'effectiveFrom', g.effective_from)
                        from public.goal_versions g
                       where g.owner_id = auth.uid() and g.metric = 'protein_g_per_day'
                         and g.effective_from <= p_date and (g.effective_to is null or g.effective_to > p_date)),
    'homeMealsPerWeek', (select jsonb_build_object('target', g.target, 'effectiveFrom', g.effective_from)
                           from public.goal_versions g
                          where g.owner_id = auth.uid() and g.metric = 'cook_sessions_per_week'
                            and g.effective_from <= p_date and (g.effective_to is null or g.effective_to > p_date)));
$$;

-- ---------------------------------------------------------------------------
-- Repeat a past meal on another day. The original entry and its snapshot are
-- untouched. The new entry uses the food's current information when the food is
-- still available ("current" or "updated"); when it is not, the recorded values
-- are copied as they were ("copied").
-- ---------------------------------------------------------------------------
create function public.repeat_diary_entry(
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

-- ---------------------------------------------------------------------------
-- Delete with a short undo window. A deleted entry leaves the totals at once,
-- can be brought back for 15 minutes, and is erased for good the next time the
-- member deletes something after that window (a scheduled purge arrives with hosting).
-- ---------------------------------------------------------------------------
create or replace function public.delete_diary_entry(p_entry_id uuid, p_expected_version integer)
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
  delete from public.diary_entries
   where owner_id = v_owner and deleted_at < now() - interval '15 minutes' and id <> p_entry_id;
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

create function public.restore_diary_entry(p_entry_id uuid)
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
    raise exception 'ENTRY_NOT_FOUND' using errcode = 'PT404';
  end if;
  if e.deleted_at is null then
    return jsonb_build_object('entryId', e.id, 'restored', true, 'version', e.version);
  end if;
  if e.deleted_at < now() - interval '15 minutes' then
    raise exception 'UNDO_EXPIRED' using errcode = 'PT409';
  end if;
  update public.diary_entries set deleted_at = null, version = version + 1 where id = e.id;
  return jsonb_build_object('entryId', e.id, 'restored', true, 'version', e.version + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recently logged foods, newest first, one row per food (for "log again").
-- ---------------------------------------------------------------------------
create function public.recent_foods(p_limit integer default 12)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) - 'rn' order by x."lastDate" desc, x."createdAt" desc), '[]'::jsonb)
    from (
      select e.id as "entryId", e.food_item_id as "foodItemId", s.display_name as "name",
             s.selected_portion as "portion", s.quantity as "quantity", e.context as "context", e.meal_slot as "mealSlot",
             e.local_date as "lastDate", e.created_at as "createdAt",
             (s.nutrients -> 'protein_g' ->> 'value')::numeric as "proteinG",
             row_number() over (partition by coalesce(e.food_item_id::text, lower(s.display_name))
                                order by e.local_date desc, e.created_at desc) as rn
        from public.diary_entries e
        join public.diary_snapshots s on s.id = e.current_snapshot_id
       where e.owner_id = auth.uid() and e.deleted_at is null
         and e.local_date > current_date - 120
    ) x
   where x.rn = 1
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

-- The member's own custom foods (never anyone else's).
create function public.my_custom_foods()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'foodItemId', fi.id, 'revisionId', r.id, 'name', r.name, 'brand', r.brand,
           'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
           'proteinG', (select nv.value from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = 'protein_g'),
           'energyKcal', (select nv.value from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = 'energy_kcal'),
           'createdAt', fi.created_at) order by fi.created_at desc), '[]'::jsonb)
    from public.food_items fi
    join public.food_revisions r on r.id = fi.current_revision_id
   where fi.kind = 'custom' and fi.owner_id = auth.uid() and auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- Write down a meal of your own and log it in one step. Only the name is
-- required: nutrition the member does not know stays unknown.
-- ---------------------------------------------------------------------------
create function public.log_new_custom_food(
  p_idempotency_key uuid,
  p_name text,
  p_brand text,
  p_nutrients jsonb,
  p_serving_label text,
  p_serving_grams numeric,
  p_multiplier numeric,
  p_context text,
  p_meal_slot text,
  p_local_date date,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_existing public.idempotency_records;
  v_food jsonb;
  v_portion uuid;
  v_label text := coalesce(nullif(trim(p_serving_label), ''), '1 serving');
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'PT422';
  end if;
  -- A repeated submit returns the first result instead of creating a second food.
  select * into v_existing from public.idempotency_records
   where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;
  if found then
    return (select jsonb_build_object('entryId', x.id, 'version', x.version, 'snapshotId', x.current_snapshot_id,
                                      'replayed', true, 'foodItemId', x.food_item_id)
              from public.diary_entries x where x.id = v_existing.result_id);
  end if;
  if length(v_label) > 80 or (p_serving_grams is not null and (p_serving_grams <= 0 or p_serving_grams > 100000)) then
    raise exception 'INVALID_CUSTOM_FOOD' using errcode = 'PT422';
  end if;
  if (select count(*) from public.food_items where kind = 'custom' and owner_id = v_owner) >= 1000 then
    raise exception 'CUSTOM_FOOD_LIMIT' using errcode = 'PT429';
  end if;

  v_food := public.create_custom_food(
    p_name, p_brand, 'serving', 1, coalesce(p_nutrients, '{}'::jsonb),
    jsonb_build_array(jsonb_build_object('label', v_label, 'amount', 1, 'unit', 'serving', 'grams', p_serving_grams)));
  select po.id into v_portion from public.portions po
   where po.revision_id = (v_food ->> 'revisionId')::uuid and po.unit = 'serving' order by po.label limit 1;

  return public.log_food_entry(p_idempotency_key, (v_food ->> 'revisionId')::uuid, v_portion, p_multiplier, null,
                               p_context, p_meal_slot, p_local_date, p_timezone)
         || jsonb_build_object('foodItemId', v_food ->> 'foodItemId');
end;
$$;

-- ---------------------------------------------------------------------------
-- Signed-in dietary filter (R-D08). The whole choice is saved together.
-- ---------------------------------------------------------------------------
create function public.my_diet()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
           'diet', p.diet, 'includeConditional', p.include_conditional,
           'exclusions', coalesce((select jsonb_agg(x.ingredient_family order by x.ingredient_family)
                                     from public.ingredient_exclusions x where x.owner_id = p.user_id), '[]'::jsonb))
    from public.user_preferences p
   where p.user_id = auth.uid();
$$;

create function public.save_my_diet(p_diet text, p_exclusions text[], p_include_conditional boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_exclusions text[] := coalesce(p_exclusions, '{}');
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_diet not in ('none', 'vegetarian', 'vegan')
     or exists (select 1 from unnest(v_exclusions) f where f not in (select code from public.ingredient_families)) then
    raise exception 'INVALID_DIET' using errcode = 'PT422';
  end if;
  insert into public.user_preferences (user_id, diet, include_conditional)
  values (v_owner, p_diet, coalesce(p_include_conditional, false))
  on conflict (user_id) do update set diet = excluded.diet, include_conditional = excluded.include_conditional;
  delete from public.ingredient_exclusions where owner_id = v_owner and ingredient_family <> all (v_exclusions);
  insert into public.ingredient_exclusions (owner_id, ingredient_family)
  select v_owner, f from unnest(v_exclusions) f
  on conflict do nothing;
  return public.my_diet();
end;
$$;

-- ---------------------------------------------------------------------------
-- The member's own data, for download. Deleted entries are not included.
-- ---------------------------------------------------------------------------
create function public.export_my_data()
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
-- Grants: signed-in members only. Guests can run none of these.
-- ---------------------------------------------------------------------------
revoke execute on function
  public.loggable_food(uuid, boolean),
  public.diary_day(date),
  public.diary_week(date),
  public.my_goals(date),
  public.repeat_diary_entry(uuid, uuid, date, text, text),
  public.restore_diary_entry(uuid),
  public.recent_foods(integer),
  public.my_custom_foods(),
  public.log_new_custom_food(uuid, text, text, jsonb, text, numeric, numeric, text, text, date, text),
  public.my_diet(),
  public.save_my_diet(text, text[], boolean),
  public.export_my_data()
from public, anon;

grant execute on function
  public.loggable_food(uuid, boolean),
  public.diary_day(date),
  public.diary_week(date),
  public.my_goals(date),
  public.repeat_diary_entry(uuid, uuid, date, text, text),
  public.restore_diary_entry(uuid),
  public.recent_foods(integer),
  public.my_custom_foods(),
  public.log_new_custom_food(uuid, text, text, jsonb, text, numeric, numeric, text, text, date, text),
  public.my_diet(),
  public.save_my_diet(text, text[], boolean),
  public.export_my_data()
to authenticated;
