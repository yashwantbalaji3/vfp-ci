-- Staged member-visible LOCAL beta (owner decision 22 Nov 2026 15:26 UTC, APPROVALS A-1122-CK, item 3):
--   "Member visibility - APPROVED for a staged, local-only beta. Start with Veggie Grill, Madras Dosa, Asmara and
--    Brown Sugar Cafe. ... do not falsely record my personal review or confirmation. Independent evidence-based
--    checks may be recorded under their actual method and confidence. Only legitimately eligible facts may
--    transition into member-visible local-beta data. Preserve publication locks and ensure that nothing becomes
--    publicly accessible."
--
-- What this adds, and nothing more:
--   * staging.member_beta_places: the places in the beta, each with its stage and the decision it rests on
--     (recorded by scripts/member-beta.mjs on a LOCAL database only; never by the founder's screens).
--   * staging.member_beta_switch: one row, OFF by default. While it is off nothing below shows anything.
--   * A fact is member-visible only when ALL hold (staging.member_fact_ok): it is a submitted or founder-verified
--     fact of a kind members may see (menu item, price, diet label, listed ingredients, allergen statement,
--     printed nutrition, serving size); its source is private_pilot or cleared in the access registry (never
--     pending or prohibited); and either the founder verified it, or the latest automatic comparison found its
--     text on the saved copy of the restaurant's page (method: automatic text-on-saved-page check). Nothing
--     records anyone's confirmation; an automatic comparison stays labelled automatic.
--   * A dish is member-visible only when its own menu-item fact is (staging.member_dish_ok).
--   * Signed-in members (never a visitor: auth.uid() must be set) can read the beta places' listings and those
--     facts, and save and plan those meals for themselves. Founder-only functions are unchanged for everyone else.
-- The three publication switches, listing visibility and the public directory rules are not touched: a beta
-- listing stays visibility 'preview', and anon access is impossible because every check needs auth.uid().

create table staging.member_beta_places (
  place_id    uuid primary key references staging.places (id),
  stage       smallint not null default 1 check (stage between 1 and 9),
  decision    text not null check (length(decision) between 10 and 500),
  recorded_by text not null check (length(recorded_by) between 3 and 120),
  recorded_at timestamptz not null default now()
);
alter table staging.member_beta_places enable row level security;
alter table staging.member_beta_places force row level security;
revoke all on staging.member_beta_places from public, anon, authenticated;
create policy member_beta_places_definer on staging.member_beta_places for all to postgres using (true) with check (true);

create table staging.member_beta_switch (
  id         boolean primary key default true check (id),
  enabled    boolean not null default false,
  changed_by text,
  changed_at timestamptz,
  note       text check (note is null or length(note) <= 500)
);
insert into staging.member_beta_switch (id, enabled) values (true, false);
alter table staging.member_beta_switch enable row level security;
alter table staging.member_beta_switch force row level security;
revoke all on staging.member_beta_switch from public, anon, authenticated;
create policy member_beta_switch_definer on staging.member_beta_switch for all to postgres using (true) with check (true);

create function staging.member_beta_on()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce((select s.enabled from staging.member_beta_switch s where s.id), false);
$$;
revoke all on function staging.member_beta_on() from public, anon, authenticated;

create function staging.member_fact_ok(f staging.facts)
returns boolean language sql stable security definer set search_path = '' as $$
  select f.status in ('submitted', 'verified')
     and not f.is_unknown
     and f.kind in ('menu_item', 'price', 'dietary_status', 'listed_ingredients', 'allergen_statement', 'published_nutrition', 'serving_size')
     and staging.source_access_state((select p.url from staging.source_pages p where p.id = f.source_page_id)) in ('private_pilot', 'cleared')
     and not exists (select 1 from staging.source_pages p where p.id = f.source_page_id and p.is_demo)
     and (f.status = 'verified' or (select mc.result from staging.current_machine_check(f.id) mc where mc.id is not null) = 'found');
$$;
revoke all on function staging.member_fact_ok(staging.facts) from public, anon, authenticated;

create function staging.member_dish_ok(p_dish uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select staging.member_beta_on() and exists (
    select 1 from staging.dishes d
      join staging.member_beta_places b on b.place_id = d.place_id
      join staging.live_catalog_links l on l.staging_place = d.place_id
      join public.place_listings pl on pl.candidate_id = l.candidate_id and pl.visibility = 'preview'
     where d.id = p_dish
       and exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'menu_item' and staging.member_fact_ok(f)));
$$;
revoke all on function staging.member_dish_ok(uuid) from public, anon, authenticated;

-- A catalog listing is in the beta when the switch is on, a member is signed in, and an enrolled place is linked to it.
create function staging.member_beta_listing(p_candidate uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select staging.member_beta_on() and exists (
    select 1 from staging.live_catalog_links l join staging.member_beta_places b on b.place_id = l.staging_place
     where l.candidate_id = p_candidate);
$$;
revoke all on function staging.member_beta_listing(uuid) from public, anon, authenticated;

-- The one visibility rule every place screen uses (latest: 20261117000500), plus the beta listings for signed-in
-- members. Public and founder preview behaviour is unchanged.
create or replace function app.place_visible(l public.place_listings, p_preview boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select (l.visibility = 'public' and app.listing_may_be_public(l.candidate_id, l.identity_status, l.publication_batch))
      or (coalesce(p_preview, false) and l.visibility = 'preview' and (app.has_role('publisher') or app.has_role('admin')))
      or (l.visibility = 'preview' and staging.member_beta_listing(l.candidate_id));
$$;
revoke all on function app.place_visible(public.place_listings, boolean) from public, anon, authenticated;

-- The beta places, in the same shape as public.menu_preview_index (20261120000200).
create function public.member_beta_index()
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
                        where f.place_id = p.id and s.is_demo)), '[]'::jsonb);
end;
$$;
revoke all on function public.member_beta_index() from public, anon;
grant execute on function public.member_beta_index() to authenticated;

-- One beta place, in the same shape as public.menu_review_place (20261118001600), holding only member-visible
-- dishes and facts. Each fact is described as if read by the person who entered it, so no confirm or reject
-- action is ever offered; open corrections are left out.
create function public.member_beta_place(p_place uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p staging.places;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not staging.member_beta_on() or not exists (select 1 from staging.member_beta_places b where b.place_id = p_place) then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  select * into p from staging.places where id = p_place;
  return jsonb_build_object(
    'placeId', p.id, 'label', p.label, 'area', p.area, 'city', p.city,
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('sourceId', s.id, 'url', s.url, 'host', staging.url_host(s.url), 'kind', s.page_kind,
                                          'publisher', s.publisher, 'retrievedAt', s.retrieved_at,
                                          'access', staging.source_access_state(s.url)) order by s.retrieved_at, s.url)
        from staging.source_pages s
       where s.id in (select f.source_page_id from staging.facts f where f.place_id = p.id and staging.member_fact_ok(f)
                        and (f.dish_id is null or staging.member_dish_ok(f.dish_id)))), '[]'::jsonb),
    'placeFacts', coalesce((
      select jsonb_agg(public.menu_review_fact_json(f, f.entered_by) order by f.kind, f.entered_at)
        from staging.facts f where f.place_id = p.id and f.dish_id is null and staging.member_fact_ok(f)), '[]'::jsonb),
    'dishes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'dishId', d.id, 'label', d.label,
               'structure', (select case when st.id is null then null else jsonb_build_object(
                                 'type', st.dish_type, 'parentDishId', st.parent_dish_id, 'section', st.section,
                                 'portion', st.portion_label, 'basis', st.basis, 'evidence', st.evidence) end
                               from staging.current_structure(d.id) st),
               'options', coalesce((select jsonb_agg(jsonb_build_object('kind', o.option_kind, 'label', o.label,
                                                                        'componentDishId', o.component_dish_id,
                                                                        'priceDeltaUsd', o.price_delta_usd, 'sourceId', o.source_page_id)
                                                     order by o.option_kind, o.label)
                                      from staging.dish_options o
                                     where o.dish_id = d.id and (o.component_dish_id is null or staging.member_dish_ok(o.component_dish_id))), '[]'::jsonb),
               'estimate', staging.estimate_json(d.id),
               'facts', coalesce((select jsonb_agg(public.menu_review_fact_json(f, f.entered_by) order by f.kind, f.subject nulls first, f.entered_at)
                                    from staging.facts f where f.dish_id = d.id and staging.member_fact_ok(f)), '[]'::jsonb),
               'corrections', '[]'::jsonb)
             order by d.label)
        from staging.dishes d where d.place_id = p.id and staging.member_dish_ok(d.id)), '[]'::jsonb));
end;
$$;
revoke all on function public.member_beta_place(uuid) from public, anon;
grant execute on function public.member_beta_place(uuid) to authenticated;

-- Saves and plans: the founder as before; a signed-in member only for a member-visible meal, and only their own rows.
create or replace function public.menu_preview_save(p_dish uuid, p_saved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not staging.member_dish_ok(p_dish) then
    raise exception 'FOUNDER_ONLY' using errcode = 'PT403';
  end if;
  if not exists (select 1 from staging.dishes where id = p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_saved then
    insert into staging.preview_saves (user_id, dish_id) values (auth.uid(), p_dish) on conflict do nothing;
  else
    delete from staging.preview_saves where user_id = auth.uid() and dish_id = p_dish;
  end if;
  return jsonb_build_object('dishId', p_dish, 'saved', p_saved);
end;
$$;

create or replace function public.menu_preview_saved()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if app.has_role('publisher') then
    return coalesce((select jsonb_agg(s.dish_id order by s.saved_at desc) from staging.preview_saves s where s.user_id = auth.uid()), '[]'::jsonb);
  end if;
  if not staging.member_beta_on() then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  return coalesce((select jsonb_agg(s.dish_id order by s.saved_at desc) from staging.preview_saves s
                    where s.user_id = auth.uid() and staging.member_dish_ok(s.dish_id)), '[]'::jsonb);
end;
$$;

create or replace function public.menu_preview_plan(p_dish uuid, p_date date, p_slot text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not staging.member_dish_ok(p_dish) then
    raise exception 'FOUNDER_ONLY' using errcode = 'PT403';
  end if;
  if not app.preview_meal_ok(p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_date is null or p_date < current_date - 7 or p_date > current_date + 62 then raise exception 'INVALID_DATE' using errcode = '22023'; end if;
  if p_slot is not null and p_slot not in ('breakfast', 'lunch', 'dinner', 'snack') then raise exception 'INVALID_SLOT' using errcode = '22023'; end if;
  if (select count(*) from staging.preview_meal_plans where user_id = auth.uid() and planned_date = p_date) >= 12 then
    raise exception 'TOO_MANY' using errcode = '22023';
  end if;
  insert into staging.preview_meal_plans (user_id, dish_id, planned_date, meal_slot)
  values (auth.uid(), p_dish, p_date, p_slot) returning id into v_id;
  return jsonb_build_object('planId', v_id);
end;
$$;

create or replace function public.menu_preview_unplan(p_plan uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') and not staging.member_beta_on() then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  delete from staging.preview_meal_plans where id = p_plan and user_id = auth.uid();
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object('planId', p_plan, 'removed', true);
end;
$$;

create or replace function public.menu_preview_plans(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_founder boolean := app.has_role('publisher');
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not v_founder and not staging.member_beta_on() then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'INVALID_RANGE' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('planId', x.id, 'dishId', x.dish_id, 'date', x.planned_date, 'mealSlot', x.meal_slot)
                     order by x.planned_date, x.created_at)
      from staging.preview_meal_plans x
     where x.user_id = auth.uid() and x.planned_date between p_from and p_to
       and (v_founder or staging.member_dish_ok(x.dish_id))), '[]'::jsonb);
end;
$$;

-- Rollback (local database): turn the switch off (scripts/member-beta.mjs off), then re-run app.place_visible from
-- 20261117000500, menu_preview_save/menu_preview_saved from 20261119000100 and the three plan functions from
-- 20261122000400; drop public.member_beta_place, public.member_beta_index, staging.member_beta_listing,
-- staging.member_dish_ok, staging.member_fact_ok, staging.member_beta_on and the two staging tables. Members'
-- own saves and plans of beta meals stay in their tables and become invisible again.
