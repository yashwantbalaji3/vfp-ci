-- Private real-catalog preview (owner 17 Nov 00:47 UTC: "Build a private real-catalog preview using
-- the bulk-imported restaurant identities and locations … Do not silently promote candidates from
-- 'corroborated' to 'verified' … I do not authorize public publication or activation of the
-- real-data lock yet."). Plan: docs/32.
--
-- Two halves:
--   1. catalog_import (private, local script only): each candidate's preview assessment, the
--      founder's identity decisions (append-only) and representative samples the founder checks.
--   2. public.place_listings: real places copied by the local script from candidates that passed
--      every check. Nobody reads the table directly. One function, place_directory, returns:
--        * to the founder (publisher or admin role), when asked for the preview: preview listings;
--        * to everyone else: only listings whose visibility is 'public', and there are none: a
--          listing can be made public only when its identity is founder-verified AND the new switch
--          'real_place_listings' is on. The switch is off and nothing in the app can turn it on.
--   Listings carry identity only and menu_status 'not_checked'. They are not dishes, so they never
--   enter search_catalog, dietary filters, Protein Explorer, counts or the diary.
--   Demo fixtures are untouched (is_demo stays on public.venues and food_items, for tests).

-- 1. Private side ----------------------------------------------------------------------------
alter table catalog_import.place_candidates
  add column preview_tier text check (preview_tier in ('preview', 'exception', 'excluded')),
  add column preview_reasons text[] not null default '{}',
  add column assessed_at timestamptz;

-- The founder's decision about a candidate's identity. Never written automatically; append-only.
create table catalog_import.identity_decisions (
  id            bigint generated always as identity primary key,
  candidate_id  uuid not null references catalog_import.place_candidates (id),
  decision      text not null check (decision in ('verify_identity', 'reject', 'needs_more_evidence')),
  note          text check (length(note) <= 1000),
  decided_by    uuid not null references auth.users (id),
  decided_at    timestamptz not null default now()
);

-- A representative sample drawn from a tier, and the founder's result for each sampled place.
create table catalog_import.identity_samples (
  id            uuid primary key default gen_random_uuid(),
  seed          text not null check (length(seed) between 1 and 100),
  population    text not null check (population in ('preview', 'exception')),
  population_n  integer not null check (population_n > 0),
  drawn_at      timestamptz not null default now()
);
create table catalog_import.identity_sample_items (
  sample_id     uuid not null references catalog_import.identity_samples (id),
  candidate_id  uuid not null references catalog_import.place_candidates (id),
  stratum       text not null,
  outcome       text check (outcome in ('correct', 'wrong_place', 'duplicate', 'not_public', 'closed', 'not_restaurant', 'other')),
  note          text check (length(note) <= 1000),
  checked_by    uuid references auth.users (id),
  checked_at    timestamptz,
  primary key (sample_id, candidate_id),
  check ((outcome is null) = (checked_by is null) and (outcome is null) = (checked_at is null))
);

-- Decisions and sample results come from a person with the publisher role, once.
create function catalog_import.guard_person_decision()
returns trigger language plpgsql set search_path = '' as $$
declare v_who uuid;
begin
  if tg_op = 'DELETE' then raise exception 'Decisions are permanent' using errcode = 'PT403'; end if;
  if tg_table_name = 'identity_decisions' then
    if tg_op = 'UPDATE' then raise exception 'Decisions are permanent' using errcode = 'PT403'; end if;
    v_who := new.decided_by;
  else
    if tg_op = 'UPDATE' and old.outcome is not null then raise exception 'A sample result is recorded once' using errcode = 'PT403'; end if;
    if tg_op = 'UPDATE' and (new.sample_id, new.candidate_id, new.stratum) is distinct from (old.sample_id, old.candidate_id, old.stratum) then
      raise exception 'Only the result can be recorded' using errcode = 'PT403';
    end if;
    v_who := new.checked_by;
  end if;
  if v_who is not null and not exists (select 1 from public.role_assignments r where r.user_id = v_who and r.role = 'publisher') then
    raise exception 'Only the founder (publisher role) decides identity' using errcode = 'PT403';
  end if;
  return new;
end $$;
create trigger identity_decisions_guard before insert or update or delete on catalog_import.identity_decisions
  for each row execute function catalog_import.guard_person_decision();
create trigger identity_sample_items_guard before insert or update or delete on catalog_import.identity_sample_items
  for each row execute function catalog_import.guard_person_decision();

do $$
declare t text;
begin
  foreach t in array array['identity_decisions', 'identity_samples', 'identity_sample_items'] loop
    execute format('alter table catalog_import.%I enable row level security', t);
    execute format('revoke all on catalog_import.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on function catalog_import.guard_person_decision() from public, anon, authenticated;

-- 2. Listings -------------------------------------------------------------------------------
alter table app.platform_switches drop constraint platform_switches_name_check;
alter table app.platform_switches add constraint platform_switches_name_check
  check (name in ('social_public', 'real_catalog_entry', 'pilot_publication', 'real_place_listings'));
-- Off. Turning it on is the owner's separate launch decision (docs/32 section 7).
insert into app.platform_switches (name, enabled) values ('real_place_listings', false);

create table public.place_listings (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     uuid not null unique, -- catalog_import.place_candidates.id (no cross-schema reference)
  market_slug      text not null default 'boston' check (market_slug ~ '^[a-z0-9-]{2,40}$'),
  slug             text not null unique check (slug ~ '^[a-z0-9-]{2,120}$'),
  name             text not null check (length(name) between 1 and 300),
  street           text not null check (length(street) between 1 and 300),
  locality         text check (length(locality) <= 100),
  postcode         text not null check (postcode ~ '^[0-9]{5}$'),
  area             text check (length(area) <= 120),
  lat              double precision not null check (lat between 42.2 and 42.5),
  lon              double precision not null check (lon between -71.3 and -70.9),
  category         text not null check (category in ('Restaurant', 'Café', 'Coffee shop', 'Juice bar', 'Food truck', 'Food court', 'Quick service')),
  -- Identity: 'corroborated' (two public sources agree) or 'verified' (the founder's own decision).
  identity_status  text not null check (identity_status in ('corroborated', 'verified')),
  -- Menu and dietary verification is a separate workflow. Every listing starts 'not_checked'.
  menu_status      text not null default 'not_checked' check (menu_status in ('not_checked')),
  sources          jsonb not null check (jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) >= 1),
  visibility       text not null default 'preview' check (visibility in ('preview', 'withdrawn', 'public')),
  built_from       text not null check (length(built_from) between 1 and 200),
  updated_at       timestamptz not null default now()
);
create index place_listings_visibility on public.place_listings (market_slug, visibility);
alter table public.place_listings enable row level security;
revoke all on public.place_listings from public, anon, authenticated;

create function app.guard_place_listing()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.visibility = 'public' and (tg_op = 'INSERT' or old.visibility <> 'public') then
    if new.identity_status <> 'verified' then
      raise exception 'Only a founder-verified place can be made public' using errcode = 'PT403';
    end if;
    if not coalesce((select w.enabled from app.platform_switches w where w.name = 'real_place_listings'), false) then
      raise exception 'Real place listings are locked' using errcode = 'PT403';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke all on function app.guard_place_listing() from public, anon, authenticated;
create trigger place_listings_guard before insert or update on public.place_listings
  for each row execute function app.guard_place_listing();

-- The place directory. Identity only; no dietary, menu or nutrition field exists to return.
create function public.place_directory(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_market text := coalesce(p->>'market', 'boston');
  v_preview boolean := coalesce((p->>'preview')::boolean, false) and (app.has_role('publisher') or app.has_role('admin'));
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_area text := nullif(btrim(coalesce(p->>'area', '')), '');
  v_lat double precision := (p->>'lat')::double precision;
  v_lon double precision := (p->>'lon')::double precision;
  v_limit integer := coalesce((p->>'limit')::integer, 24);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 or length(coalesce(v_area, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > 50 then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  if (v_lat is null) <> (v_lon is null) then raise exception 'INVALID_POINT' using errcode = 'PT422'; end if;

  with seen as (
    select l.* from public.place_listings l
     where l.market_slug = v_market
       and (l.visibility = 'public' or (v_preview and l.visibility = 'preview'))
  ), hit as (
    select s.*,
           case when v_lat is not null then 2 * 6371000 * asin(sqrt(power(sin(radians(s.lat - v_lat) / 2), 2)
             + cos(radians(v_lat)) * cos(radians(s.lat)) * power(sin(radians(s.lon - v_lon) / 2), 2))) end as distance_m
      from seen s
     where (v_q is null or s.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%' or s.street ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
       and (v_area is null or s.area = v_area)
  ), ordered as (
    select h.*, row_number() over (order by h.distance_m asc nulls last, h.name, h.id) as rn from hit h
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'slug', o.slug, 'name', o.name, 'street', o.street, 'locality', o.locality, 'postcode', o.postcode,
        'area', o.area, 'category', o.category, 'lat', round(o.lat::numeric, 5), 'lon', round(o.lon::numeric, 5),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'identityStatus', o.identity_status, 'menuStatus', o.menu_status, 'visibility', o.visibility,
        'sources', (select coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'attribution', s->>'attribution')), '[]'::jsonb) from jsonb_array_elements(o.sources) s)
      ) order by o.rn) from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (select count(*) from hit),
    'nextOffset', case when (select count(*) from hit) > v_offset + v_limit then v_offset + v_limit end,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('area', a.area, 'count', a.n) order by a.n desc, a.area)
                         from (select s.area, count(*) n from seen s where s.area is not null group by s.area) a), '[]'::jsonb),
    'preview', v_preview
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.place_directory(jsonb) from public;
grant execute on function public.place_directory(jsonb) to anon, authenticated;
