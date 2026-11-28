-- Founder review of the meals invited testers may see (owner direction 23 Nov 2026 19:34 UTC, item 3):
--   "Prepare a founder-review workflow that identifies a small, trustworthy and rights-cleared subset of Boston
--    meals that can safely become visible to invited testers. Keep everything unverified and private until the
--    necessary review and publication decisions are complete."
--
-- What this adds:
--   * staging.member_beta_switch.meal_mode: 'reviewed_meals' (the default, and the hosted-beta setting) shows a
--     member only meals the founder has included; 'whole_place' keeps the earlier local behaviour (every eligible
--     meal of an enrolled place). The switch itself stays OFF; nothing here turns anything on.
--   * staging.tester_meal_checks(dish): seven automatic checks, all required before a meal can be included:
--       meal      - the dish is recorded as a complete meal (not a side, drink, dessert or add-on);
--       rights    - the menu-item fact passes staging.member_fact_ok (source private_pilot or cleared, found on the
--                   saved page or founder-verified, never demo);
--       stated    - the restaurant's own words state the meal vegetarian or vegan (a dietary_status fact "yes"
--                   that also passes member_fact_ok), and no fact says "no" for the same diet;
--       place     - the restaurant is enrolled in the beta and linked to a catalog listing kept at 'preview';
--       fresh     - the menu-item fact was checked within the last 120 days;
--       price     - a price fact that passes member_fact_ok exists (so testers can compare);
--       open      - no operating_status fact for the restaurant says it is closed.
--   * staging.tester_meal_decisions: append-only record of each include / leave-out decision, by a publisher, with a
--     reason and the checks as they stood. Including a meal confirms nothing about it: its facts keep their status
--     and stay labelled unverified, and a later failing check removes it from view automatically.
--   * At most 75 meals can be included at once (a "small" set; docs/78 asks for about 30 to launch).
-- Rollback: drop the two public functions, restore staging.member_dish_ok from 20261122000600, drop the decision
-- table, staging.tester_meal_checks and staging.tester_meal_included, and drop the meal_mode column.

alter table staging.member_beta_switch
  add column meal_mode text not null default 'reviewed_meals' check (meal_mode in ('reviewed_meals', 'whole_place'));

create table staging.tester_meal_decisions (
  id         uuid primary key default gen_random_uuid(),
  dish_id    uuid not null references staging.dishes (id),
  decision   text not null check (decision in ('include', 'leave_out')),
  reason     text not null check (length(btrim(reason)) between 3 and 300),
  checks     jsonb not null,
  decided_by uuid not null references auth.users (id),
  decided_at timestamptz not null default clock_timestamp()
);
create index tester_meal_decisions_dish on staging.tester_meal_decisions (dish_id, decided_at desc);
alter table staging.tester_meal_decisions enable row level security;
alter table staging.tester_meal_decisions force row level security;
revoke all on staging.tester_meal_decisions from public, anon, authenticated;
create policy tester_meal_decisions_definer on staging.tester_meal_decisions for select to postgres using (true);
create policy tester_meal_decisions_insert on staging.tester_meal_decisions for insert to postgres with check (true);
-- No update or delete policy: the record is append-only. A change of mind is a new row.

create function staging.tester_meal_checks(p_dish uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with d as (select * from staging.dishes where id = p_dish),
  ok as (
    select f.* from staging.facts f where f.dish_id = p_dish and f.status in ('submitted', 'verified') and staging.member_fact_ok(f)
  ),
  item as (select max(checked_on) as checked_on from ok where kind = 'menu_item'),
  diets as (
    select subject,
           bool_or(value ->> 'status' = 'yes') filter (where id in (select id from ok)) as yes,
           bool_or(value ->> 'status' = 'no') as no
      from staging.facts
     where dish_id = p_dish and kind = 'dietary_status' and status in ('submitted', 'verified') and not is_unknown
       and subject in ('vegetarian', 'vegan')
     group by subject
  )
  select jsonb_build_object(
    'meal', coalesce((select st.dish_type = 'complete_meal' from staging.current_structure(p_dish) st), false),
    'rights', exists (select 1 from ok where kind = 'menu_item'),
    'stated', exists (select 1 from diets where yes and not coalesce(no, false)),
    'statedDiets', coalesce((select jsonb_agg(subject order by subject) from diets where yes and not coalesce(no, false)), '[]'::jsonb),
    'place', exists (
      select 1 from d
        join staging.member_beta_places b on b.place_id = d.place_id
        join staging.live_catalog_links l on l.staging_place = d.place_id
        join public.place_listings pl on pl.candidate_id = l.candidate_id and pl.visibility = 'preview'),
    'fresh', coalesce((select checked_on >= (now() at time zone 'America/New_York')::date - 120 from item), false),
    'price', exists (select 1 from ok where kind = 'price'),
    'open', not exists (
      select 1 from staging.facts f, d
       where f.place_id = d.place_id and f.dish_id is null and f.kind = 'operating_status'
         and f.status in ('submitted', 'verified') and not f.is_unknown
         and f.value ->> 'status' in ('closed', 'permanently_closed', 'temporarily_closed')),
    'checkedOn', (select checked_on from item));
$$;
revoke all on function staging.tester_meal_checks(uuid) from public, anon, authenticated;

create function staging.tester_meal_all_pass(c jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce((c ->> 'meal')::boolean and (c ->> 'rights')::boolean and (c ->> 'stated')::boolean and (c ->> 'place')::boolean
                  and (c ->> 'fresh')::boolean and (c ->> 'price')::boolean and (c ->> 'open')::boolean, false);
$$;
revoke all on function staging.tester_meal_all_pass(jsonb) from public, anon, authenticated;

-- Included = the latest decision is "include" AND every check still passes today.
create function staging.tester_meal_included(p_dish uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select t.decision = 'include' from staging.tester_meal_decisions t
                    where t.dish_id = p_dish order by t.decided_at desc, t.id desc limit 1), false)
     and staging.tester_meal_all_pass(staging.tester_meal_checks(p_dish));
$$;
revoke all on function staging.tester_meal_included(uuid) from public, anon, authenticated;

-- The member rule from 20261122000600, with one more condition in the reviewed-meals mode.
create or replace function staging.member_dish_ok(p_dish uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select staging.member_beta_on() and exists (
    select 1 from staging.dishes d
      join staging.member_beta_places b on b.place_id = d.place_id
      join staging.live_catalog_links l on l.staging_place = d.place_id
      join public.place_listings pl on pl.candidate_id = l.candidate_id and pl.visibility = 'preview'
     where d.id = p_dish
       and exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'menu_item' and staging.member_fact_ok(f)))
   and (coalesce((select s.meal_mode from staging.member_beta_switch s where s.id), 'reviewed_meals') = 'whole_place'
        or staging.tester_meal_included(p_dish));
$$;
revoke all on function staging.member_dish_ok(uuid) from public, anon, authenticated;

-- Founder screen data: every meal at a linked restaurant, with its checks and latest decision.
create function public.tester_meal_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return jsonb_build_object(
    'mode', (select s.meal_mode from staging.member_beta_switch s where s.id),
    'betaOn', (select s.enabled from staging.member_beta_switch s where s.id),
    'limit', 75,
    'meals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dishId', d.id, 'placeId', d.place_id,
               'checks', staging.tester_meal_checks(d.id),
               'decision', t.decision, 'reason', t.reason, 'decidedAt', t.decided_at,
               'included', staging.tester_meal_included(d.id)) order by d.place_id, d.label)
        from staging.dishes d
        join staging.live_catalog_links l on l.staging_place = d.place_id
        left join lateral (select x.decision, x.reason, x.decided_at from staging.tester_meal_decisions x
                            where x.dish_id = d.id order by x.decided_at desc, x.id desc limit 1) t on true
       where exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'menu_item')), '[]'::jsonb));
end;
$$;
revoke all on function public.tester_meal_queue() from public, anon;
grant execute on function public.tester_meal_queue() to authenticated;

create function public.tester_meal_decide(p_dish uuid, p_decision text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c jsonb;
  n int;
begin
  perform app.require_founder();
  if p_decision not in ('include', 'leave_out') then raise exception 'BAD_DECISION' using errcode = 'PT422'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 300 then raise exception 'BAD_REASON' using errcode = 'PT422'; end if;
  if not exists (select 1 from staging.dishes where id = p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  c := staging.tester_meal_checks(p_dish);
  if p_decision = 'include' then
    if not staging.tester_meal_all_pass(c) then raise exception 'CHECKS_FAIL' using errcode = 'PT409'; end if;
    perform pg_advisory_xact_lock(hashtext('tester_meal_decide'));
    select count(*) into n from staging.dishes d where d.id <> p_dish and staging.tester_meal_included(d.id);
    if n >= 75 then raise exception 'LIMIT_REACHED' using errcode = 'PT409'; end if;
  end if;
  insert into staging.tester_meal_decisions (dish_id, decision, reason, checks, decided_by)
  values (p_dish, p_decision, btrim(p_reason), c, auth.uid());
  return jsonb_build_object('dishId', p_dish, 'decision', p_decision, 'included', staging.tester_meal_included(p_dish));
end;
$$;
revoke all on function public.tester_meal_decide(uuid, text, text) from public, anon;
grant execute on function public.tester_meal_decide(uuid, text, text) to authenticated;

-- In the reviewed-meals mode a restaurant is listed to members only while at least one of its meals is included,
-- so testers never meet an empty menu. Otherwise as in 20261122000600.
create or replace function public.member_beta_index()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not staging.member_beta_on() then raise exception 'BETA_OFF' using errcode = 'PT403'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'placeId', p.id, 'label', p.label,
             'listingId', pl.id, 'slug', pl.slug, 'name', pl.name, 'street', pl.street, 'area', pl.area,
             'lat', pl.lat, 'lon', pl.lon, 'cuisines', pl.cuisines, 'dietHints', staging.place_diet_hints(pl.candidate_id),
             'linkMethod', k.method, 'linkedAt', k.at)
           order by pl.name)
      from staging.member_beta_places b
      join staging.places p on p.id = b.place_id
      join staging.live_catalog_links k on k.staging_place = p.id
      join public.place_listings pl on pl.candidate_id = k.candidate_id and pl.visibility = 'preview'
     where not exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id
                        where f.place_id = p.id and s.is_demo)
       and (coalesce((select s.meal_mode from staging.member_beta_switch s where s.id), 'reviewed_meals') = 'whole_place'
            or exists (select 1 from staging.dishes d where d.place_id = p.id and staging.tester_meal_included(d.id)))), '[]'::jsonb);
end;
$$;
revoke all on function public.member_beta_index() from public, anon;
grant execute on function public.member_beta_index() to authenticated;
