-- Real meals in the staged local member beta: logging, lists and reviews (owner directive 23 Nov 2026 02:04 UTC,
-- section 6: "I approve engineering and local testing of this integration ... Any member-visible rollout must remain
-- behind an explicit, disabled-by-default feature gate").
--
-- 20261122000600 let a signed-in member see, save and plan the meals of the enrolled beta restaurants while
-- staging.member_beta_switch is on (it is off by default). Logging, lists and reviews stayed founder-only, so a
-- member's journey stopped at "save". This migration opens those three to the same members, under the same gate:
--   * the founder as before;
--   * a member only while the switch is on, and only for a meal staging.member_dish_ok() accepts (an enrolled place
--     in the preview, with a menu fact the founder verified or the automatic page check found);
--   * always the caller's own rows. A meal review stays private (no audience); a meal on a list is shown to the
--     list's owner only, as before. Nothing here writes a public table, so no feed, ranking, friend view, export or
--     visitor can show a drafted meal.
--   * the figures a log records for a member come only from facts a member may see (staging.member_fact_ok), so a
--     diary snapshot never holds a number or source the member could not see.
-- Turning the switch off hides the meals again without deleting anyone's rows; diary entries keep their snapshot.

-- One nutrient of a drafted meal (latest: 20261120000100), now limited to member-visible facts for anyone but the founder.
create or replace function app.real_meal_figure(p_dish uuid, p_nutrient text)
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
     and (app.has_role('publisher') or staging.member_fact_ok(f))
   order by f.entered_at desc, f.id desc
   limit 1;
$$;
revoke all on function app.real_meal_figure(uuid, text) from public, anon, authenticated;

-- Log a real meal (latest: 20261120000100). Only the guard and the fallback source lookup change.
create or replace function public.log_real_meal(
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
  if v_owner is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  -- The founder, or a member while the local member beta is on and only for a member-visible meal (20261123000100).
  if not app.has_role('publisher') and not staging.member_dish_ok(p_dish) then
    raise exception 'FOUNDER_ONLY' using errcode = 'PT403';
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
                              and (app.has_role('publisher') or staging.member_fact_ok(f))
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

-- Lists (latest: 20261119000200).
create or replace function public.menu_preview_list_set(p_list uuid, p_dish uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not (case when p_on then staging.member_dish_ok(p_dish) else staging.member_beta_on() end) then
    raise exception 'FOUNDER_ONLY' using errcode = 'PT403';
  end if;
  if not exists (select 1 from public.food_lists f where f.id = p_list and f.owner_id = auth.uid() and f.publication_state <> 'removed') then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if p_on then
    if not app.preview_meal_ok(p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
    perform app.social_rate(auth.uid(), 'list_write', 60, interval '1 hour');
    insert into staging.preview_list_entries (list_id, user_id, dish_id) values (p_list, auth.uid(), p_dish) on conflict do nothing;
  else
    delete from staging.preview_list_entries where list_id = p_list and dish_id = p_dish and user_id = auth.uid();
  end if;
  return jsonb_build_object('listId', p_list, 'dishId', p_dish, 'on', p_on);
end $$;

create or replace function public.menu_preview_list_entries(p_list uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_founder boolean := app.has_role('publisher');
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not v_founder and not staging.member_beta_on() then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('dishId', e.dish_id, 'addedAt', e.added_at) order by e.added_at, e.dish_id)
      from staging.preview_list_entries e
      join public.food_lists f on f.id = e.list_id and f.owner_id = auth.uid()
     where e.list_id = p_list and e.user_id = auth.uid()
       and (v_founder or staging.member_dish_ok(e.dish_id))), '[]'::jsonb);
end $$;

create or replace function public.menu_preview_meal_lists(p_dish uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not staging.member_dish_ok(p_dish) then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('listId', f.id, 'title', f.title) order by f.title, f.id)
      from staging.preview_list_entries e
      join public.food_lists f on f.id = e.list_id and f.owner_id = auth.uid()
     where e.dish_id = p_dish and e.user_id = auth.uid()), '[]'::jsonb);
end $$;

-- Reviews (latest: 20261119000200). Always private to the person who wrote them.
create or replace function public.menu_preview_review_set(p_dish uuid, p_rating integer, p_body text default null, p_visit_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_row staging.preview_reviews;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not staging.member_dish_ok(p_dish) then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  if not app.preview_meal_ok(p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'INVALID_RATING' using errcode = 'PT422'; end if;
  if length(coalesce(v_body, '')) > 2000 then raise exception 'TEXT_TOO_LONG' using errcode = 'PT422'; end if;
  if p_visit_date is not null and (p_visit_date > current_date + 1 or p_visit_date < date '2000-01-01') then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  perform app.social_rate(auth.uid(), 'review_write', 30, interval '1 hour');
  insert into staging.preview_reviews (user_id, dish_id, rating, body, visit_date)
  values (auth.uid(), p_dish, p_rating, v_body, p_visit_date)
  on conflict (user_id, dish_id) do update
    set rating = excluded.rating, body = excluded.body, visit_date = excluded.visit_date,
        version = staging.preview_reviews.version + 1, updated_at = now()
  returning * into v_row;
  return jsonb_build_object('dishId', v_row.dish_id, 'rating', v_row.rating, 'version', v_row.version);
end $$;

create or replace function public.menu_preview_review_delete(p_dish uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not staging.member_beta_on() then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  delete from staging.preview_reviews where user_id = auth.uid() and dish_id = p_dish;
  return jsonb_build_object('dishId', p_dish, 'deleted', true);
end $$;

create or replace function public.menu_preview_reviews()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_founder boolean := app.has_role('publisher');
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not v_founder and not staging.member_beta_on() then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('dishId', r.dish_id, 'rating', r.rating, 'body', r.body, 'visitDate', r.visit_date,
                                        'version', r.version, 'updatedAt', r.updated_at) order by r.updated_at desc, r.dish_id)
      from staging.preview_reviews r where r.user_id = auth.uid()
       and (v_founder or staging.member_dish_ok(r.dish_id))), '[]'::jsonb);
end $$;

-- Rollback (local database, no reset): re-run the definitions of these seven functions from 20261120000100
-- (app.real_meal_figure, public.log_real_meal) and 20261119000200 (the five list and review functions). Rows
-- members wrote stay in staging.preview_list_entries and staging.preview_reviews (own rows, never public) and can
-- be deleted with: delete from staging.preview_reviews r where not exists (select 1 from public.role_assignments a
-- where a.user_id = r.user_id and a.role = 'publisher'); and the same for staging.preview_list_entries.
