-- Real-menu drafts and the founder's batch review (owner 18 Nov 2026 15:48 UTC, items 1, 6 and 7; docs/58).
--
-- Reuses the private staging area (docs/27, 20261115000900): research drafts each fact about a real
-- restaurant's menu with its source page, the date it was checked and how sure the drafter is; the
-- founder then confirms, corrects or rejects whole rows at a time in the app. Nothing here publishes
-- anything, and nothing is ever confirmed automatically:
--   * A fact is confirmed only by an explicit choice of the founder, a different person from the one
--     who entered it (the existing two-person rule), and only when its source is cleared in the
--     access registry (the existing guard). Every choice is in the permanent history.
--   * A correction does not let the founder confirm their own words. It rejects the draft, keeps the
--     founder's corrected value in the history as a request, and research redrafts the fact from the
--     source; the redraft comes back to the founder like any other draft.
--   * Listed ingredients are what the restaurant lists, word for word in short items. They are not a
--     description, never a dietary claim and never a nutrition figure.
--   * The founder's screens read staging only through the functions below, which refuse everyone but
--     the founder (FOUNDER_ONLY), like the identity review.

-- 1. More areas for the 30-restaurant cohort (Cambridge beyond the two squares, Mission Hill).
create or replace function staging.area_city(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_area in ('central_square', 'harvard_square', 'kendall_square', 'inman_square', 'porter_square') then 'Cambridge'
    when p_area in ('back_bay', 'fenway_kenmore', 'south_end', 'downtown', 'chinatown', 'beacon_hill', 'longwood', 'mission_hill') then 'Boston'
  end;
$$;

-- 2. A new kind of dish fact: the ingredients the restaurant lists. {"items": ["chickpeas", "tahini"]}
create or replace function staging.fact_value_valid(p_kind text, v jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(v) = 'object' and case p_kind
    when 'address' then coalesce(length(v ->> 'street'), 0) between 1 and 200 and coalesce(length(v ->> 'postcode'), 0) between 5 and 10
    when 'operating_status' then v ->> 'status' in ('operating', 'closed', 'temporarily_closed')
    when 'weekly_hours' then jsonb_typeof(v -> 'periods') = 'array'
    when 'menu_item' then (v ->> 'listed') in ('true', 'false')
    when 'price' then coalesce(v ->> 'usd', '') ~ '^[0-9]{1,4}(\.[0-9]{2})?$'
    when 'dietary_status' then v ->> 'claim' in ('vegan', 'vegetarian', 'egg_free') and v ->> 'status' in ('yes', 'no')
    when 'allergen_statement' then v ->> 'statement' in ('contains', 'may_contain', 'free_from') and jsonb_typeof(v -> 'allergens') = 'array'
    when 'published_nutrition' then v ->> 'nutrient' in ('protein_g', 'energy_kcal', 'fat_g', 'carb_g', 'fiber_g', 'sodium_mg')
      and coalesce(v ->> 'amount', '') ~ '^[0-9]+(\.[0-9]+)?$' and v ->> 'per' in ('serving', '100g')
    when 'serving_size' then coalesce(v ->> 'grams', '') ~ '^[0-9]+(\.[0-9]+)?$' and (v ->> 'grams')::numeric > 0
    when 'listed_ingredients' then jsonb_typeof(v -> 'items') = 'array'
      and jsonb_array_length(v -> 'items') between 1 and 40
      and not exists (select 1 from jsonb_array_elements(v -> 'items') e
                       where jsonb_typeof(e) <> 'string' or length(trim(e #>> '{}')) not between 1 and 80)
    else false end;
$$;

alter table staging.facts drop constraint facts_kind_check;
alter table staging.facts add constraint facts_kind_check
  check (kind in ('address', 'operating_status', 'weekly_hours', 'menu_item', 'price', 'dietary_status', 'allergen_statement',
                  'published_nutrition', 'serving_size', 'listed_ingredients'));

-- 3. How sure the drafter is (high: stated plainly on the restaurant's own page; medium: stated but
-- needs a look, such as a price on an ordering page; low: hard to read). Set once, never changed.
alter table staging.facts add column confidence text check (confidence is null or confidence in ('high', 'medium', 'low'));

create function staging.guard_fact_confidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.confidence is distinct from old.confidence then
    raise exception 'A staged fact is permanent: enter a new fact that replaces it' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger facts_confidence before update on staging.facts for each row execute function staging.guard_fact_confidence();

-- submit_fact keeps its signature and checks; it now also stores p.confidence.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('staging.submit_fact(uuid, jsonb)'::regprocedure);
  before := d;
  d := replace(d,
    $x$source_page_id, checked_on, entered_by, replaces_fact_id)$x$,
    $x$source_page_id, checked_on, entered_by, replaces_fact_id, confidence)$x$);
  d := replace(d,
    $x$v_src.id, v_checked, p_actor, (p ->> 'replacesFactId')::uuid)$x$,
    $x$v_src.id, v_checked, p_actor, (p ->> 'replacesFactId')::uuid, p ->> 'confidence')$x$);
  if d = before then raise exception 'submit_fact: text not found'; end if;
  execute d;
end;
$mig$;

alter table staging.events drop constraint events_action_check;
alter table staging.events add constraint events_action_check
  check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact',
                    'set_place_status', 'prepare_publication', 'link_catalog', 'unlink_catalog', 'request_correction'));

-- Corrections the founder asked for that research has not redrafted yet: no fact for the same dish,
-- kind and subject was submitted after the request (by history order, not clock time).
create function staging.open_corrections()
returns table (event_id bigint, at timestamptz, place_id uuid, place_label text, dish_label text, fact_id uuid,
               kind text, subject text, drafted jsonb, corrected jsonb, note text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.at, f.place_id, p.label, d.label, f.id, f.kind, f.subject, f.value, e.detail -> 'value', e.detail ->> 'note'
    from staging.events e
    join staging.facts f on f.id = e.fact_id
    join staging.places p on p.id = f.place_id
    left join staging.dishes d on d.id = f.dish_id
   where e.action = 'request_correction'
     and not exists (select 1 from staging.facts n
                       join staging.events se on se.fact_id = n.id and se.action = 'submit_fact'
                      where n.place_id = f.place_id and n.dish_id is not distinct from f.dish_id and n.kind = f.kind
                        and n.subject is not distinct from f.subject and se.id > e.id)
   order by e.at;
$$;
revoke all on function staging.open_corrections() from public, anon, authenticated;
revoke all on function staging.guard_fact_confidence() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The founder's screens. Each refuses anyone but the founder.
-- ---------------------------------------------------------------------------

-- One row per staged place: dishes and facts waiting, held (source not cleared yet) and confirmed.
create function public.menu_review_places()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(x order by (x ->> 'ready')::int desc, x ->> 'label')
      from (
        select jsonb_build_object(
                 'placeId', p.id, 'label', p.label, 'area', p.area, 'city', p.city,
                 'dishes', (select count(*) from staging.dishes d where d.place_id = p.id),
                 'ready', count(f.id) filter (where f.status = 'submitted' and f.entered_by <> auth.uid() and staging.source_access_state(s.url) = 'cleared'),
                 'held', count(f.id) filter (where f.status = 'submitted' and staging.source_access_state(s.url) <> 'cleared'),
                 'confirmed', count(f.id) filter (where f.status = 'verified'),
                 'rejected', count(f.id) filter (where f.status = 'rejected')) x
          from staging.places p
          left join staging.facts f on f.place_id = p.id
          left join staging.source_pages s on s.id = f.source_page_id
         group by p.id) q), '[]'::jsonb);
end;
$$;

-- One place: its sources (with their access state) and every dish with its current facts. A fact is
-- "current" when it is waiting or confirmed; rejected and replaced facts stay in history only.
create function public.menu_review_place(p_place uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  p staging.places;
begin
  perform app.require_founder();
  select * into p from staging.places where id = p_place;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object(
    'placeId', p.id, 'label', p.label, 'area', p.area, 'city', p.city,
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('sourceId', s.id, 'url', s.url, 'host', staging.url_host(s.url), 'kind', s.page_kind,
                                          'publisher', s.publisher, 'retrievedAt', s.retrieved_at,
                                          'access', staging.source_access_state(s.url)) order by s.retrieved_at, s.url)
        from staging.source_pages s
       where s.id in (select f.source_page_id from staging.facts f where f.place_id = p.id)), '[]'::jsonb),
    'placeFacts', coalesce((
      select jsonb_agg(public.menu_review_fact_json(f, v_me) order by f.kind, f.entered_at)
        from staging.facts f where f.place_id = p.id and f.dish_id is null and f.status in ('submitted', 'verified')), '[]'::jsonb),
    'dishes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dishId', d.id, 'label', d.label,
               'facts', coalesce((select jsonb_agg(public.menu_review_fact_json(f, v_me) order by f.kind, f.subject nulls first, f.entered_at)
                                    from staging.facts f where f.dish_id = d.id and f.status in ('submitted', 'verified')), '[]'::jsonb),
               'corrections', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'subject', c.subject, 'corrected', c.corrected, 'at', c.at))
                                          from staging.open_corrections() c join staging.facts cf on cf.id = c.fact_id
                                         where cf.dish_id = d.id), '[]'::jsonb))
             order by d.label)
        from staging.dishes d where d.place_id = p.id), '[]'::jsonb));
end;
$$;

-- The shape of one fact for the founder's screen. canConfirm is false for a fact the founder entered
-- or whose source is not cleared; it only decides which buttons are offered (review_fact checks again).
create function public.menu_review_fact_json(f staging.facts, p_me uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'factId', f.id, 'kind', f.kind, 'subject', f.subject, 'value', f.value, 'unknown', f.is_unknown,
    'unknownReason', f.unknown_reason, 'status', f.status, 'confidence', f.confidence,
    'sourceId', f.source_page_id, 'checkedOn', f.checked_on,
    'canConfirm', f.status = 'submitted' and f.entered_by <> p_me
                  and staging.source_access_state((select s.url from staging.source_pages s where s.id = f.source_page_id)) = 'cleared',
    'canReject', f.status = 'submitted' and f.entered_by <> p_me);
$$;

-- Confirm or reject many facts at once. Every item names its fact and an explicit decision; there is
-- no "confirm everything" without a list. All or nothing: one refusal writes none of them.
-- p_decisions: [{"factId": "...", "decision": "verify" | "reject", "note": "..."}], at most 300.
create function public.menu_review_decide(p_decisions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  x jsonb;
  v_verified int := 0;
  v_rejected int := 0;
begin
  perform app.require_founder();
  -- A missing body, or anything but a list, is refused before its length is read.
  if p_decisions is null or jsonb_typeof(p_decisions) is distinct from 'array' then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  if jsonb_array_length(p_decisions) not between 1 and 300 then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  for x in select * from jsonb_array_elements(p_decisions) loop
    if jsonb_typeof(x) <> 'object' or coalesce(x ->> 'decision', '') not in ('verify', 'reject') or x ->> 'factId' is null or length(coalesce(x ->> 'note', '')) > 500 then
      raise exception 'INVALID_BODY' using errcode = 'PT422';
    end if;
    perform staging.review_fact(v_me, (x ->> 'factId')::uuid, x ->> 'decision', nullif(trim(x ->> 'note'), ''));
    if x ->> 'decision' = 'verify' then v_verified := v_verified + 1; else v_rejected := v_rejected + 1; end if;
  end loop;
  return jsonb_build_object('verified', v_verified, 'rejected', v_rejected);
exception
  when invalid_text_representation then raise exception 'INVALID_BODY' using errcode = 'PT422';
end;
$$;

-- Correct a draft: the draft is rejected and the founder's value is kept as a request for research to
-- redraft from the source. The corrected value must have the shape of its kind.
create function public.menu_review_correct(p_fact uuid, p_value jsonb, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  f staging.facts;
begin
  perform app.require_founder();
  select * into f from staging.facts where id = p_fact;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  -- The value is bounded in size (2,000 characters as text), so a correction cannot carry a payload.
  if p_value is null or length(p_value::text) > 2000 or not staging.fact_value_valid(f.kind, p_value)
     or (f.kind = 'dietary_status' and p_value ->> 'claim' is distinct from f.subject)
     or (f.kind = 'published_nutrition' and p_value ->> 'nutrient' is distinct from f.subject)
     or length(coalesce(p_note, '')) > 500 then
    raise exception 'INVALID_CORRECTION' using errcode = 'PT422';
  end if;
  perform staging.review_fact(v_me, p_fact, 'reject', coalesce(nullif(trim(p_note), ''), 'Corrected by the founder'));
  insert into staging.events (actor_id, action, place_id, fact_id, detail)
  values (v_me, 'request_correction', f.place_id, f.id,
          jsonb_build_object('value', p_value, 'note', nullif(trim(p_note), '')));
  return jsonb_build_object('factId', f.id, 'status', 'correction_requested');
end;
$$;

do $$
declare s text;
begin
  foreach s in array array['public.menu_review_places()', 'public.menu_review_place(uuid)', 'public.menu_review_decide(jsonb)',
                           'public.menu_review_correct(uuid, jsonb, text)'] loop
    execute format('revoke all on function %s from public, anon', s);
    execute format('grant execute on function %s to authenticated', s);
  end loop;
end $$;
revoke all on function public.menu_review_fact_json(staging.facts, uuid) from public, anon, authenticated;

-- Rollback: drop the five public.menu_review_* functions, staging.open_corrections and the
-- facts_confidence trigger and its function; restore events_action_check without request_correction;
-- re-run staging.submit_fact from 20261115000900; restore facts_kind_check and fact_value_valid
-- without listed_ingredients and staging.area_city from 20261116000400 (only if no staged rows use the
-- new kind or areas); then drop column staging.facts.confidence. Nothing else changes.
