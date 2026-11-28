-- Change or remove a food of your own (BACKLOG M3-F1 in part; owner 18 Nov 2026 02:27 UTC item 8,
-- "cohesive social and diary journeys"). docs/56.
--
-- A change never rewrites anything already logged: it adds a new revision and moves the food's pointer to
-- it. Diary entries keep the snapshot they were logged with. Removing a food only takes it off the
-- member's list and out of logging (status 'withdrawn'); nothing is deleted, earlier entries are
-- unchanged, and it can be put back. Only foods written down in the app (one serving as the basis, one
-- serving portion) can be changed here; a private USDA copy is not "your own food" and is never offered.

-- One food of the member's own, with what the change form needs. Anyone else's food, a USDA copy or a
-- removed food: FOOD_NOT_FOUND (the same answer as for a food that does not exist).
create function public.my_custom_food(p_food_item_id uuid)
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
   where id = p_food_item_id and kind = 'custom' and owner_id = v_owner and status = 'published'
     and not exists (select 1 from app.usda_member_foods l where l.food_item_id = p_food_item_id);
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into r from public.food_revisions where id = fi.current_revision_id;
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;

  return jsonb_build_object(
    'foodItemId', fi.id, 'revisionId', r.id, 'revisionNo', r.revision_no, 'name', r.name, 'brand', r.brand,
    'editable', r.basis_kind = 'serving'
                and (select count(*) from public.portions po where po.revision_id = r.id) = 1
                and exists (select 1 from public.portions po where po.revision_id = r.id and po.unit = 'serving'),
    'serving', (select jsonb_build_object('label', po.label, 'grams', po.grams)
                  from public.portions po where po.revision_id = r.id and po.unit = 'serving' order by po.label limit 1),
    'nutrients', (select jsonb_object_agg(nv.nutrient_code, nv.value)
                    from public.nutrient_values nv
                   where nv.revision_id = r.id and nv.nutrient_code in ('protein_g', 'energy_kcal', 'carb_g', 'fat_g', 'fiber_g')),
    'timesLogged', (select count(*) from public.diary_entries e where e.food_item_id = fi.id and e.owner_id = v_owner and e.deleted_at is null),
    'createdAt', fi.created_at);
end;
$$;
revoke execute on function public.my_custom_food(uuid) from public, anon;
grant execute on function public.my_custom_food(uuid) to authenticated;

-- Save a change as a new revision. p_expected_revision_id must still be the current one (VERSION_CONFLICT
-- otherwise). p_nutrients holds the five values the form shows ({"protein_g": 12, "energy_kcal": null});
-- a missing or null key is stored as "not provided", never as zero. Any other nutrient is carried over.
create function public.update_custom_food(
  p_food_item_id uuid,
  p_expected_revision_id uuid,
  p_name text,
  p_brand text,
  p_nutrients jsonb,
  p_serving_label text,
  p_serving_grams numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  fi public.food_items;
  r public.food_revisions;
  v_rev uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_record uuid := gen_random_uuid();
  v_label text := coalesce(nullif(trim(p_serving_label), ''), '1 serving');
  d record;
  v_val numeric;
  v_form constant text[] := array['protein_g', 'energy_kcal', 'carb_g', 'fat_g', 'fiber_g'];
begin
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  select * into fi from public.food_items
   where id = p_food_item_id and kind = 'custom' and owner_id = v_owner and status = 'published'
     and not exists (select 1 from app.usda_member_foods l where l.food_item_id = p_food_item_id)
   for update;
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  if fi.current_revision_id is distinct from p_expected_revision_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;
  select * into r from public.food_revisions where id = fi.current_revision_id;
  if r.basis_kind <> 'serving'
     or (select count(*) from public.portions po where po.revision_id = r.id) <> 1
     or not exists (select 1 from public.portions po where po.revision_id = r.id and po.unit = 'serving') then
    raise exception 'NOT_EDITABLE' using errcode = 'PT422';
  end if;

  if octet_length(coalesce(p_nutrients::text, '') || coalesce(p_name, '') || coalesce(p_brand, '') || coalesce(p_serving_label, '')) > 8192 then
    raise exception 'BODY_TOO_LARGE' using errcode = 'PT422';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 200 then
    raise exception 'INVALID_NAME' using errcode = 'PT422';
  end if;
  if length(coalesce(p_brand, '')) > 120 or length(v_label) > 80
     or (p_serving_grams is not null and (p_serving_grams <= 0 or p_serving_grams > 100000)) then
    raise exception 'INVALID_CUSTOM_FOOD' using errcode = 'PT422';
  end if;
  if jsonb_typeof(coalesce(p_nutrients, '{}'::jsonb)) <> 'object' then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_nutrients, '{}'::jsonb)) k where k <> all (v_form)) then
    raise exception 'UNKNOWN_NUTRIENT' using errcode = 'PT422';
  end if;

  insert into public.sources (id, publisher, source_type, access_scope, owner_id)
  values (v_source, 'Entered by member', 'user_entered', 'private', v_owner);
  insert into public.source_records (id, source_id, observed_at, evidence_summary, rights_status)
  values (v_record, v_source, now(), 'Changed by the member', 'restricted');

  insert into public.food_revisions (id, food_item_id, revision_no, name, brand, basis_kind, basis_amount, basis_unit)
  values (v_rev, fi.id, (select max(revision_no) + 1 from public.food_revisions where food_item_id = fi.id),
          trim(p_name), nullif(trim(p_brand), ''), 'serving', 1, 'serving');

  for d in select code from public.nutrient_definitions loop
    if d.code = any (v_form) then
      if p_nutrients ? d.code and jsonb_typeof(p_nutrients -> d.code) <> 'null' then
        if jsonb_typeof(p_nutrients -> d.code) <> 'number' then
          raise exception 'INVALID_NUTRIENT_VALUE' using errcode = 'PT422';
        end if;
        v_val := (p_nutrients ->> d.code)::numeric;
        if v_val < 0 then
          raise exception 'INVALID_NUTRIENT_VALUE' using errcode = 'PT422';
        end if;
        insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method)
        values (v_rev, d.code, v_val, v_record, 'user_entered');
      else
        insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason)
        values (v_rev, d.code, null, v_record, 'user_entered', 'not_provided');
      end if;
    else
      -- Not on the form: carried over exactly as it was, or "not provided" if it was never there.
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason)
      select v_rev, d.code, nv.value, nv.source_record_id, nv.method, nv.missing_reason
        from public.nutrient_values nv where nv.revision_id = r.id and nv.nutrient_code = d.code;
      if not found then
        insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason)
        values (v_rev, d.code, null, v_record, 'user_entered', 'not_provided');
      end if;
    end if;
  end loop;

  insert into public.portions (revision_id, label, amount, unit, grams, source_record_id)
  values (v_rev, v_label, 1, 'serving', p_serving_grams, v_record);

  update public.food_revisions set published_at = now() where id = v_rev;
  update public.food_items set current_revision_id = v_rev where id = fi.id;
  return jsonb_build_object('foodItemId', fi.id, 'revisionId', v_rev);
exception
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
    raise exception 'INVALID_CUSTOM_FOOD' using errcode = 'PT422';
end;
$$;
revoke execute on function public.update_custom_food(uuid, uuid, text, text, jsonb, text, numeric) from public, anon;
grant execute on function public.update_custom_food(uuid, uuid, text, text, jsonb, text, numeric) to authenticated;

-- Take a food off the member's list (p_remove true) or put it back (false). Nothing is deleted.
create function public.set_custom_food_removed(p_food_item_id uuid, p_remove boolean)
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
  if p_remove is null then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  update public.food_items fi
     set status = case when p_remove then 'withdrawn' else 'published' end
   where fi.id = p_food_item_id and fi.kind = 'custom' and fi.owner_id = v_owner
     and fi.status in ('published', 'withdrawn')
     and not exists (select 1 from app.usda_member_foods l where l.food_item_id = p_food_item_id)
  returning fi.id into v_id;
  if v_id is null then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object('foodItemId', v_id, 'removed', p_remove);
end;
$$;
revoke execute on function public.set_custom_food_removed(uuid, boolean) from public, anon;
grant execute on function public.set_custom_food_removed(uuid, boolean) to authenticated;

-- my_custom_foods: removed foods are left out. Patched from the current definition.
-- loggable_food: a removed food of one's own can no longer be opened for logging (repeating an earlier
-- entry still works, from that entry). Patched from the current definition.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.my_custom_foods()'::regprocedure);
  before := d;
  d := replace(d,
    $x$where fi.kind = 'custom' and fi.owner_id = auth.uid() and auth.uid() is not null$x$,
    $x$where fi.kind = 'custom' and fi.owner_id = auth.uid() and auth.uid() is not null and fi.status = 'published'$x$);
  if d = before then raise exception 'my_custom_foods: text not found'; end if;
  execute d;

  d := pg_get_functiondef('public.loggable_food(uuid, boolean)'::regprocedure);
  before := d;
  d := replace(d,
    $x$or (visibility = 'private' and owner_id = v_owner));$x$,
    $x$or (visibility = 'private' and owner_id = v_owner and status = 'published'));$x$);
  if d = before then raise exception 'loggable_food: text not found'; end if;
  execute d;
end;
$mig$;

-- Rollback: drop the three functions above; re-run public.my_custom_foods from
-- 20261118000700_usda_diary_foods.sql and public.loggable_food from its latest migration; then
-- update public.food_items set status = 'published' where kind = 'custom' and status = 'withdrawn'.
-- Revisions added by changes stay (they are only newer versions; old entries never pointed at them).
