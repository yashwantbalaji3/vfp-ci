-- "Log this meal" keeps where a real meal's figures came from (owner direction 20 Nov 2026 03:27 UTC, P1; docs/63).
--
-- Before: logging a real restaurant meal made an ordinary own food, so a protein figure printed by the restaurant
-- was saved as "user_entered" and the restaurant, dish, serving basis and source date were lost.
--
-- Now public.log_real_meal makes the same private own food and diary entry, but:
--   * reads the restaurant's own figures from the drafted menu on the server (founder only, the meal must be in
--     the private preview), never from what the browser says the source was;
--   * keeps a figure the person left unchanged as the restaurant's ("published", or "estimated" for the
--     restaurant's own estimate), with the restaurant and source date in its assumptions; a figure the person
--     typed or changed stays "user_entered", and the change is recorded apart from the source data;
--   * never turns a range, a USDA estimate or a per-100 g figure into a number;
--   * stores one private, insert-only attribution per own food, which every diary snapshot of that food carries
--     (app.evidence_snapshot), so it survives reloads, edits and repeats and can't change afterwards;
--   * is idempotent on the form's key, like every diary write.
--
-- Additive only: one new table, one new function, and two functions replaced with supersets of what they returned.
-- Existing diary entries, snapshots and own foods are untouched; an entry without an attribution reads as before.

create table public.custom_food_attributions (
  revision_id  uuid primary key references public.food_revisions (id) on delete cascade,
  owner_id     uuid not null references auth.users (id) on delete cascade,
  attribution  jsonb not null check (jsonb_typeof(attribution) = 'object' and octet_length(attribution::text) <= 8192),
  created_at   timestamptz not null default now()
);
alter table public.custom_food_attributions enable row level security;
create policy custom_food_attributions_owner_read on public.custom_food_attributions for select to authenticated
  using (owner_id = (select auth.uid()));
revoke all on public.custom_food_attributions from public, anon, authenticated;
grant select on public.custom_food_attributions to authenticated;

create function app.guard_attribution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ATTRIBUTION_IMMUTABLE' using errcode = 'PT409';
end;
$$;
create trigger custom_food_attributions_immutable before update on public.custom_food_attributions
  for each row execute function app.guard_attribution();

-- The evidence every diary snapshot captures now also carries the meal's source, when it has one.
create or replace function app.evidence_snapshot(p_revision_id uuid)
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
  ) || coalesce((select jsonb_build_object('mealSource', a.attribution) from public.custom_food_attributions a where a.revision_id = r.id), '{}'::jsonb)
  from public.food_revisions r
  join public.food_items fi on fi.id = r.food_item_id
  where r.id = p_revision_id;
$$;

-- One nutrient of a drafted meal, as the restaurant printed it: the latest live fact, never a rejected or replaced one.
create function app.real_meal_figure(p_dish uuid, p_nutrient text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'factId', f.id, 'status', f.status, 'checkedOn', f.checked_on, 'sourcePageId', f.source_page_id,
           'basis', coalesce(f.value ->> 'basis', 'published'), 'per', f.value ->> 'per', 'portion', f.value ->> 'portion',
           'amount', f.value ->> 'amount', 'low', f.value ->> 'low', 'high', f.value ->> 'high',
           'confirmed', exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id))
    from staging.facts f
   where f.dish_id = p_dish and f.kind = 'published_nutrition' and f.subject = p_nutrient and not f.is_unknown
     and f.status in ('submitted', 'verified')
     and not exists (select 1 from staging.facts n where n.replaces_fact_id = f.id)
   order by f.entered_at desc, f.id desc
   limit 1;
$$;
revoke all on function app.real_meal_figure(uuid, text) from public, anon, authenticated;

create function public.log_real_meal(
  p_idempotency_key uuid,
  p_dish uuid,
  p_protein_g numeric,
  p_energy_kcal numeric,
  p_multiplier numeric,
  p_meal_slot text,
  p_local_date date,
  p_timezone text,
  p_usda jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_existing public.idempotency_records;
  v_dish record;
  v_page record;
  v_p jsonb;
  v_k jsonb;
  v_p_single boolean;
  v_k_single boolean;
  v_p_method text;
  v_k_method text;
  v_item uuid := gen_random_uuid();
  v_rev uuid := gen_random_uuid();
  v_source uuid := gen_random_uuid();
  v_record uuid := gen_random_uuid();
  v_portion uuid;
  v_name text;
  v_evidence text;
  v_attr jsonb;
  v_note text;
  d record;
begin
  perform app.require_founder();
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = 'PT422';
  end if;
  -- A repeated submit (a retry, a double tap, the back button) returns the first entry instead of a second one.
  select * into v_existing from public.idempotency_records
   where owner_id = v_owner and operation = 'diary.create' and key = p_idempotency_key;
  if found then
    return (select jsonb_build_object('entryId', x.id, 'version', x.version, 'snapshotId', x.current_snapshot_id,
                                      'replayed', true, 'foodItemId', x.food_item_id)
              from public.diary_entries x where x.id = v_existing.result_id);
  end if;
  if p_dish is null or not app.preview_meal_ok(p_dish) then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if (p_protein_g is not null and (p_protein_g < 0 or p_protein_g > 1000))
     or (p_energy_kcal is not null and (p_energy_kcal < 0 or p_energy_kcal > 20000))
     or (p_usda is not null and (jsonb_typeof(p_usda) <> 'object' or octet_length(p_usda::text) > 2000)) then
    raise exception 'INVALID_CUSTOM_FOOD' using errcode = 'PT422';
  end if;
  if (select count(*) from public.food_items where kind = 'custom' and owner_id = v_owner) >= 1000 then
    raise exception 'CUSTOM_FOOD_LIMIT' using errcode = 'PT429';
  end if;

  select dd.id, dd.label, pl.name as place_name, pl.id as listing_id, dd.place_id into v_dish
    from staging.dishes dd
    join staging.live_catalog_links l on l.staging_place = dd.place_id
    join public.place_listings pl on pl.candidate_id = l.candidate_id
   where dd.id = p_dish
   limit 1;
  v_p := app.real_meal_figure(p_dish, 'protein_g');
  v_k := app.real_meal_figure(p_dish, 'energy_kcal');
  select sp.url, sp.retrieved_at into v_page from staging.source_pages sp
   where sp.id = coalesce((v_p ->> 'sourcePageId')::uuid,
                          (select f.source_page_id from staging.facts f where f.dish_id = p_dish and f.kind in ('menu_item', 'price')
                            order by f.entered_at desc limit 1));

  -- A figure counts as the restaurant's only when it is one amount for one serving, and the person kept it.
  v_p_single := v_p is not null and v_p ->> 'basis' in ('published', 'restaurant_estimate') and coalesce(v_p ->> 'per', 'serving') <> '100g'
                and v_p ->> 'amount' is not null;
  v_k_single := v_k is not null and v_k ->> 'basis' = 'published' and coalesce(v_k ->> 'per', 'serving') <> '100g' and v_k ->> 'amount' is not null;
  v_p_method := case when p_protein_g is null then 'unknown'
                     when v_p_single and p_protein_g = (v_p ->> 'amount')::numeric then case when v_p ->> 'basis' = 'restaurant_estimate' then 'estimated' else 'published' end
                     else 'user_entered' end;
  v_k_method := case when p_energy_kcal is null then 'unknown'
                     when v_k_single and p_energy_kcal = (v_k ->> 'amount')::numeric then 'published'
                     else 'user_entered' end;
  v_evidence := case
    when v_p is null then case when p_usda is not null then 'usda_estimate' else 'unknown' end
    when coalesce(v_p ->> 'per', 'serving') = '100g' then 'restaurant_per_100g'
    when v_p ->> 'basis' = 'published_range' then 'restaurant_range'
    when v_p ->> 'basis' = 'restaurant_estimate' then 'restaurant_estimate'
    else 'restaurant_published' end;

  v_name := left(v_dish.label || ' (' || v_dish.place_name || ')', 200);
  v_attr := jsonb_build_object(
    'kind', 'real_meal',
    'restaurant', jsonb_build_object('name', v_dish.place_name, 'listingId', v_dish.listing_id),
    'dish', jsonb_build_object('id', v_dish.id, 'name', v_dish.label),
    'loggedAt', now(),
    'source', jsonb_build_object('url', v_page.url, 'checkedOn', coalesce(v_p ->> 'checkedOn', v_k ->> 'checkedOn'), 'pageSavedAt', v_page.retrieved_at),
    -- Never "verified": a draft, or a transcription the founder confirmed privately (which publishes nothing).
    'status', case when v_p is not null and (v_p ->> 'confirmed')::boolean then 'transcription_confirmed' else 'unverified_draft' end,
    'protein', jsonb_build_object(
      'evidence', v_evidence, 'unit', 'g',
      'per', case when v_p is null then null when coalesce(v_p ->> 'per', 'serving') = '100g' then '100 g' else 'serving' end,
      'portion', v_p ->> 'portion',
      'sourceAmount', case when v_p_single then (v_p ->> 'amount')::numeric end,
      'sourceLow', case when v_evidence = 'restaurant_range' then (v_p ->> 'low')::numeric
                        when v_evidence = 'usda_estimate' then (p_usda ->> 'low')::numeric end,
      'sourceHigh', case when v_evidence = 'restaurant_range' then (v_p ->> 'high')::numeric
                         when v_evidence = 'usda_estimate' then (p_usda ->> 'high')::numeric end,
      'logged', p_protein_g,
      'method', v_p_method,
      'changedByYou', v_p_single and p_protein_g is distinct from (v_p ->> 'amount')::numeric,
      'typedByYou', not v_p_single and p_protein_g is not null),
    'energy', jsonb_build_object(
      'sourceAmount', case when v_k_single then (v_k ->> 'amount')::numeric end,
      'logged', p_energy_kcal, 'method', v_k_method,
      'changedByYou', v_k_single and p_energy_kcal is distinct from (v_k ->> 'amount')::numeric,
      'typedByYou', not v_k_single and p_energy_kcal is not null),
    'servings', coalesce(p_multiplier, 1));

  v_note := 'Logged from ' || v_dish.place_name || '''s menu as drafted for the private preview'
            || coalesce(', read ' || (v_attr #>> '{source,checkedOn}'), '') || '. Unverified unless confirmed; never public.';
  insert into public.sources (id, publisher, source_type, access_scope, owner_id)
  values (v_source, left(v_dish.place_name || ' menu (private draft)', 200), 'menu', 'private', v_owner);
  insert into public.source_records (id, source_id, observed_at, evidence_summary, rights_status)
  values (v_record, v_source, now(), v_note, 'restricted');
  insert into public.food_items (id, kind, owner_id, visibility, status)
  values (v_item, 'custom', v_owner, 'private', 'published');
  insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit)
  values (v_rev, v_item, 1, v_name, 'serving', 1, 'serving');
  for d in select code from public.nutrient_definitions loop
    if d.code = 'protein_g' and p_protein_g is not null then
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, assumptions)
      values (v_rev, d.code, p_protein_g, v_record, v_p_method,
              case v_p_method when 'published' then 'Printed by ' || v_dish.place_name || ' for one serving; kept unchanged.'
                              when 'estimated' then v_dish.place_name || '''s own estimate for one serving; kept unchanged.'
                              else 'Typed or changed by you.' end);
    elsif d.code = 'energy_kcal' and p_energy_kcal is not null then
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, assumptions)
      values (v_rev, d.code, p_energy_kcal, v_record, v_k_method,
              case v_k_method when 'published' then 'Printed by ' || v_dish.place_name || ' for one serving; kept unchanged.' else 'Typed or changed by you.' end);
    else
      insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason)
      values (v_rev, d.code, null, v_record, 'unknown', 'not_provided');
    end if;
  end loop;
  insert into public.portions (id, revision_id, label, amount, unit, source_record_id)
  values (gen_random_uuid(), v_rev, '1 serving', 1, 'serving', v_record) returning id into v_portion;
  insert into public.custom_food_attributions (revision_id, owner_id, attribution) values (v_rev, v_owner, v_attr);
  update public.food_revisions set published_at = now() where id = v_rev;
  update public.food_items set current_revision_id = v_rev where id = v_item;

  return public.log_food_entry(p_idempotency_key, v_rev, v_portion, coalesce(p_multiplier, 1), null,
                               'restaurant', p_meal_slot, p_local_date, p_timezone)
         || jsonb_build_object('foodItemId', v_item);
end;
$$;
revoke all on function public.log_real_meal(uuid, uuid, numeric, numeric, numeric, text, date, text, jsonb) from public, anon;
grant execute on function public.log_real_meal(uuid, uuid, numeric, numeric, numeric, text, date, text, jsonb) to authenticated;

-- The day's entries also say where a logged real meal's figures came from. Otherwise unchanged.
-- Patched in place from the current definition (which already carries 20261116000600's estimate
-- ranges), like the earlier diary migrations; the migration fails if the expected text is missing.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.diary_day(date)'::regprocedure);
  before := d;
  d := replace(d,
    $x$'editable', s.food_revision_id is not null,$x$,
    $x$'editable', s.food_revision_id is not null,
                 'source', s.evidence_snapshot -> 'mealSource',$x$);
  if d = before then raise exception 'diary_day: editable text not found'; end if;
  execute d;
end;
$mig$;
