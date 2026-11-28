-- Pilot staging for REAL restaurants (owner approval 2026-11-15 23:21 UTC, A-STAGING-1; plan docs/27 A).
--
-- A private holding area for facts about real places while they are being checked. LOCAL ONLY.
--   * Separate schema `staging`, not in the Data API; every table and function is closed to visitors
--     and members (anon, authenticated) and Row Level Security denies everything by default.
--   * Nothing here is read by any public screen, search, map, count, Protein Explorer or diary.
--     There is no function that copies a staged place into the public catalog: that needs the
--     owner's publication approval and a later, separately reviewed change.
--   * Every fact carries its source page, the date it was checked, who entered it, its status and,
--     once reviewed, a DIFFERENT person who reviewed it (two-person rule, like catalog_changes).
--   * Unknown is a first-class value with a reason. An unknown dietary status never counts as "yes".
--   * Facts are never edited or deleted. A correction is a new fact that replaces the old one; the
--     history log only grows.
--   * Real records only: `is_demo` is always false here, and demo data lives elsewhere.
-- Actors are passed explicitly (the local entry script runs as the database owner) and must hold the
-- curator (enter) or publisher (review) role in public.role_assignments at the time of the action.

create schema staging;
revoke all on schema staging from public, anon, authenticated;

create function staging.actor_has_role(p_actor uuid, p_role text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_actor is not null and exists (
    select 1 from public.role_assignments ra where ra.user_id = p_actor and ra.role = p_role);
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table staging.places (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null check (length(label) between 1 and 200),
  area               text not null check (area in ('central_square', 'harvard_square')),
  city               text not null default 'Cambridge' check (length(city) between 1 and 100),
  shortlist_priority smallint not null check (shortlist_priority between 1 and 3),
  pilot_status       text not null default 'shortlist' check (pilot_status in ('shortlist', 'verifying', 'ready_for_owner', 'rejected')),
  is_demo            boolean not null default false check (not is_demo),
  created_by         uuid not null,
  created_at         timestamptz not null default now(),
  unique (label, area)
);

create table staging.dishes (
  id         uuid primary key default gen_random_uuid(),
  place_id   uuid not null references staging.places (id),
  label      text not null check (length(label) between 1 and 200),
  is_demo    boolean not null default false check (not is_demo),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (place_id, label),
  unique (id, place_id)
);

create table staging.source_pages (
  id             uuid primary key default gen_random_uuid(),
  url            text not null check (url ~ '^https://[^/\s]+' and length(url) <= 2000),
  page_kind      text not null check (page_kind in ('restaurant_site', 'restaurant_ordering', 'restaurant_nutrition_guide', 'news', 'government_dataset', 'directory')),
  publisher      text not null check (length(publisher) between 1 and 200),
  retrieved_at   timestamptz not null,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  rights_status  text not null default 'facts_only' check (rights_status in ('facts_only', 'cleared', 'denied')),
  terms_note     text check (terms_note is null or length(terms_note) <= 1000),
  is_demo        boolean not null default false check (not is_demo),
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  unique (url, retrieved_at)
);

create function staging.is_restaurant_own(p_kind text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p_kind in ('restaurant_site', 'restaurant_ordering', 'restaurant_nutrition_guide'); $$;

-- The shape each kind of fact must have. Unknown facts carry no value (see staging.facts checks).
create function staging.fact_value_valid(p_kind text, v jsonb)
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
    else false end;
$$;

create table staging.facts (
  id               uuid primary key default gen_random_uuid(),
  place_id         uuid not null references staging.places (id),
  dish_id          uuid,
  kind             text not null check (kind in ('address', 'operating_status', 'weekly_hours', 'menu_item', 'price', 'dietary_status', 'allergen_statement', 'published_nutrition', 'serving_size')),
  -- For dietary_status and published_nutrition the claim or nutrient is kept here too, so that
  -- "unknown" facts still say what is unknown.
  subject          text check (subject is null or length(subject) between 1 and 40),
  value            jsonb,
  is_unknown       boolean not null default false,
  unknown_reason   text check (unknown_reason is null or length(unknown_reason) between 3 and 500),
  source_page_id   uuid not null references staging.source_pages (id),
  checked_on       date not null,
  entered_by       uuid not null,
  entered_at       timestamptz not null default now(),
  status           text not null default 'submitted' check (status in ('submitted', 'verified', 'rejected', 'replaced')),
  reviewer_id      uuid,
  reviewed_at      timestamptz,
  review_note      text check (review_note is null or length(review_note) <= 500),
  replaces_fact_id uuid references staging.facts (id),
  foreign key (dish_id, place_id) references staging.dishes (id, place_id),
  check ((kind in ('address', 'operating_status', 'weekly_hours')) = (dish_id is null)),
  check (kind not in ('dietary_status', 'published_nutrition') or subject is not null),
  check (case when is_unknown then value is null and unknown_reason is not null
              else value is not null and staging.fact_value_valid(kind, value) end),
  check (kind <> 'dietary_status' or is_unknown or subject = value ->> 'claim'),
  check (kind <> 'published_nutrition' or is_unknown or subject = value ->> 'nutrient'),
  -- The person who checks is never the person who entered.
  check (reviewer_id is null or reviewer_id <> entered_by),
  check ((status in ('verified', 'rejected', 'replaced')) = (reviewer_id is not null and reviewed_at is not null))
);
create index staging_facts_place_idx on staging.facts (place_id, kind);
create index staging_facts_dish_idx on staging.facts (dish_id, kind, subject);

create table staging.events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor_id  uuid not null,
  action    text not null check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact', 'set_place_status')),
  place_id  uuid,
  fact_id   uuid,
  detail    jsonb not null default '{}'::jsonb
);

-- Closed to everyone but the database owner. RLS on, no policies: nobody reads through the API.
do $$
declare t text;
begin
  foreach t in array array['places', 'dishes', 'source_pages', 'facts', 'events'] loop
    execute format('alter table staging.%I enable row level security', t);
    execute format('alter table staging.%I force row level security', t);
    execute format('revoke all on staging.%I from public, anon, authenticated', t);
  end loop;
end $$;
-- The owner reaches the rows only through the functions below (security definer, owner bypasses
-- forced RLS only via policies), so give the owner one policy per table.
do $$
declare t text;
begin
  foreach t in array array['places', 'dishes', 'source_pages', 'facts', 'events'] loop
    execute format('create policy %I on staging.%I for all to postgres using (true) with check (true)', t || '_owner', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Guards: nothing is ever deleted; reviewed facts never change except "verified" -> "replaced".
-- ---------------------------------------------------------------------------
create function staging.guard_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Staged records are permanent history and cannot be deleted' using errcode = 'P0001';
end;
$$;

create function staging.guard_fact_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.place_id, new.dish_id, new.kind, new.subject, new.value, new.is_unknown, new.unknown_reason,
      new.source_page_id, new.checked_on, new.entered_by, new.entered_at, new.replaces_fact_id)
     is distinct from
     (old.place_id, old.dish_id, old.kind, old.subject, old.value, old.is_unknown, old.unknown_reason,
      old.source_page_id, old.checked_on, old.entered_by, old.entered_at, old.replaces_fact_id) then
    raise exception 'A staged fact is permanent: enter a new fact that replaces it' using errcode = 'P0001';
  end if;
  if old.status = 'submitted' and new.status in ('verified', 'rejected') then return new; end if;
  if old.status = 'verified' and new.status = 'replaced'
     and (new.reviewer_id, new.reviewed_at, new.review_note) is not distinct from (old.reviewer_id, old.reviewed_at, old.review_note) then
    return new;
  end if;
  raise exception 'A staged fact is permanent: % cannot become %', old.status, new.status using errcode = 'P0001';
end;
$$;

create function staging.guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Staging history is permanent' using errcode = 'P0001';
end;
$$;

-- Places may change only their pilot status.
create function staging.guard_place_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.label, new.area, new.city, new.shortlist_priority, new.is_demo, new.created_by, new.created_at)
     is not distinct from (old.id, old.label, old.area, old.city, old.shortlist_priority, old.is_demo, old.created_by, old.created_at) then
    return new;
  end if;
  raise exception 'Staged records are permanent history and cannot be changed' using errcode = 'P0001';
end;
$$;

create trigger facts_no_delete before delete on staging.facts for each row execute function staging.guard_no_delete();
create trigger facts_update before update on staging.facts for each row execute function staging.guard_fact_update();
create trigger events_append_only before update or delete on staging.events for each row execute function staging.guard_append_only();
create trigger places_update before update on staging.places for each row execute function staging.guard_place_update();
-- Dishes and source pages never change.
create trigger dishes_update before update on staging.dishes for each row execute function staging.guard_append_only();
create trigger sources_update before update on staging.source_pages for each row execute function staging.guard_append_only();
create trigger places_no_delete before delete on staging.places for each row execute function staging.guard_no_delete();
create trigger dishes_no_delete before delete on staging.dishes for each row execute function staging.guard_no_delete();
create trigger sources_no_delete before delete on staging.source_pages for each row execute function staging.guard_no_delete();
create function staging.guard_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Staged records are permanent history and cannot be deleted' using errcode = 'P0001';
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['places', 'dishes', 'source_pages', 'facts', 'events'] loop
    execute format('create trigger %I before truncate on staging.%I for each statement execute function staging.guard_no_truncate()', t || '_no_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Writing: only through these functions, each checking the actor's role.
-- ---------------------------------------------------------------------------
create function staging.require_role(p_actor uuid, p_role text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not staging.actor_has_role(p_actor, p_role) then
    raise exception 'STAGING_ROLE_REQUIRED' using errcode = 'PT403', detail = p_role;
  end if;
end;
$$;

create function staging.add_place(p_actor uuid, p_label text, p_area text, p_priority smallint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform staging.require_role(p_actor, 'curator');
  insert into staging.places (label, area, shortlist_priority, created_by) values (p_label, p_area, p_priority, p_actor) returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail) values (p_actor, 'add_place', v_id, jsonb_build_object('label', p_label));
  return v_id;
end;
$$;

create function staging.add_dish(p_actor uuid, p_place uuid, p_label text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform staging.require_role(p_actor, 'curator');
  insert into staging.dishes (place_id, label, created_by) values (p_place, p_label, p_actor) returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail) values (p_actor, 'add_dish', p_place, jsonb_build_object('dishId', v_id, 'label', p_label));
  return v_id;
end;
$$;

create function staging.add_source_page(p_actor uuid, p_url text, p_kind text, p_publisher text, p_retrieved_at timestamptz, p_terms_note text default null, p_sha256 text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform staging.require_role(p_actor, 'curator');
  if p_retrieved_at > now() + interval '5 minutes' then
    raise exception 'STAGING_FUTURE_DATE' using errcode = 'PT422';
  end if;
  insert into staging.source_pages (url, page_kind, publisher, retrieved_at, terms_note, content_sha256, created_by)
    values (p_url, p_kind, p_publisher, p_retrieved_at, p_terms_note, p_sha256, p_actor) returning id into v_id;
  insert into staging.events (actor_id, action, detail) values (p_actor, 'add_source_page', jsonb_build_object('sourcePageId', v_id, 'url', p_url));
  return v_id;
end;
$$;

-- p: {placeId, dishId?, kind, subject?, value?, unknownReason?, sourcePageId, checkedOn, replacesFactId?}
create function staging.submit_fact(p_actor uuid, p jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_src staging.source_pages;
  v_old staging.facts;
  v_unknown boolean := (p -> 'value') is null or jsonb_typeof(p -> 'value') = 'null';
  v_checked date := (p ->> 'checkedOn')::date;
begin
  perform staging.require_role(p_actor, 'curator');
  select * into v_src from staging.source_pages where id = (p ->> 'sourcePageId')::uuid;
  if v_src.id is null then
    raise exception 'STAGING_SOURCE_REQUIRED' using errcode = 'PT422';
  end if;
  if v_checked is null or v_checked > (now() at time zone 'America/New_York')::date or v_checked < (v_src.retrieved_at at time zone 'America/New_York')::date - 1 then
    raise exception 'STAGING_BAD_CHECK_DATE' using errcode = 'PT422';
  end if;
  if v_src.rights_status = 'denied' then
    raise exception 'STAGING_SOURCE_DENIED' using errcode = 'PT422';
  end if;
  -- A dietary "yes" or a published nutrition figure must come from the restaurant itself.
  if not v_unknown and not staging.is_restaurant_own(v_src.page_kind)
     and (p ->> 'kind' = 'published_nutrition' or (p ->> 'kind' = 'dietary_status' and p -> 'value' ->> 'status' = 'yes')) then
    raise exception 'STAGING_NEEDS_RESTAURANT_SOURCE' using errcode = 'PT422';
  end if;
  if p ? 'replacesFactId' then
    select * into v_old from staging.facts where id = (p ->> 'replacesFactId')::uuid;
    if v_old.id is null or v_old.status <> 'verified' or v_old.place_id <> (p ->> 'placeId')::uuid
       or v_old.kind <> p ->> 'kind' or v_old.dish_id is distinct from (p ->> 'dishId')::uuid then
      raise exception 'STAGING_BAD_REPLACEMENT' using errcode = 'PT422';
    end if;
  end if;
  insert into staging.facts (place_id, dish_id, kind, subject, value, is_unknown, unknown_reason, source_page_id, checked_on, entered_by, replaces_fact_id)
  values ((p ->> 'placeId')::uuid, (p ->> 'dishId')::uuid, p ->> 'kind',
          coalesce(p ->> 'subject', p -> 'value' ->> 'claim', p -> 'value' ->> 'nutrient'),
          case when v_unknown then null else p -> 'value' end, v_unknown, p ->> 'unknownReason',
          v_src.id, v_checked, p_actor, (p ->> 'replacesFactId')::uuid)
  returning id into v_id;
  insert into staging.events (actor_id, action, place_id, fact_id, detail)
    values (p_actor, 'submit_fact', (p ->> 'placeId')::uuid, v_id, jsonb_build_object('kind', p ->> 'kind', 'unknown', v_unknown));
  return v_id;
end;
$$;

create function staging.review_fact(p_actor uuid, p_fact uuid, p_decision text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v staging.facts;
begin
  perform staging.require_role(p_actor, 'publisher');
  select * into v from staging.facts where id = p_fact for update;
  if v.id is null then raise exception 'STAGING_NOT_FOUND' using errcode = 'PT404'; end if;
  if v.entered_by = p_actor then raise exception 'STAGING_SAME_PERSON' using errcode = 'PT403'; end if;
  if v.status <> 'submitted' then raise exception 'STAGING_ALREADY_REVIEWED' using errcode = 'PT409'; end if;
  if p_decision not in ('verify', 'reject') then raise exception 'STAGING_BAD_DECISION' using errcode = 'PT422'; end if;
  update staging.facts
     set status = case p_decision when 'verify' then 'verified' else 'rejected' end,
         reviewer_id = p_actor, reviewed_at = now(), review_note = p_note
   where id = p_fact;
  insert into staging.events (actor_id, action, place_id, fact_id, detail)
    values (p_actor, case p_decision when 'verify' then 'verify_fact' else 'reject_fact' end, v.place_id, p_fact, jsonb_build_object('note', p_note));
  if p_decision = 'verify' and v.replaces_fact_id is not null then
    update staging.facts set status = 'replaced' where id = v.replaces_fact_id and status = 'verified';
    insert into staging.events (actor_id, action, place_id, fact_id, detail)
      values (p_actor, 'replace_fact', v.place_id, v.replaces_fact_id, jsonb_build_object('replacedBy', p_fact));
  end if;
  return case p_decision when 'verify' then 'verified' else 'rejected' end;
end;
$$;

create function staging.set_place_status(p_actor uuid, p_place uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform staging.require_role(p_actor, 'publisher');
  update staging.places set pilot_status = p_status where id = p_place;
  if not found then raise exception 'STAGING_NOT_FOUND' using errcode = 'PT404'; end if;
  insert into staging.events (actor_id, action, place_id, detail) values (p_actor, 'set_place_status', p_place, jsonb_build_object('status', p_status));
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading for the owner's review (still closed to visitors and members).
-- ---------------------------------------------------------------------------

-- 'yes' only with a current verified "yes"; 'no' with a current verified "no"; otherwise 'unknown'.
create function staging.dish_dietary_status(p_dish uuid, p_claim text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select f.value ->> 'status' from staging.facts f
     where f.dish_id = p_dish and f.kind = 'dietary_status' and f.subject = p_claim
       and f.status = 'verified' and not f.is_unknown
     order by f.reviewed_at desc limit 1), 'unknown');
$$;

-- Would this dish pass a strict dietary filter? Only a verified "yes" passes.
create function staging.passes_strict_filter(p_dish uuid, p_claim text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select staging.dish_dietary_status(p_dish, p_claim) = 'yes'; $$;

-- One row per place with counts of facts by status, for the owner's pilot review.
create function staging.pilot_overview()
returns table (place_id uuid, label text, area text, shortlist_priority smallint, pilot_status text,
               facts_submitted bigint, facts_verified bigint, facts_unknown bigint, dishes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.label, p.area, p.shortlist_priority, p.pilot_status,
         count(f.id) filter (where f.status = 'submitted'),
         count(f.id) filter (where f.status = 'verified'),
         count(f.id) filter (where f.is_unknown and f.status in ('submitted', 'verified')),
         (select count(*) from staging.dishes d where d.place_id = p.id)
    from staging.places p left join staging.facts f on f.place_id = p.id
   group by p.id order by p.shortlist_priority, p.label;
$$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'staging' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
