-- MAP-2 slice H-1: structured opening hours, their status, and "Open now".
--
-- Authority: APPROVALS A-MAP2 (owner directive, 15 Nov 2026 19:55 UTC). Synthetic data, local only.
--
-- 1. Hours a computer can read: one checked version ("set") of a place's weekly hours, with
--    several periods per day, periods that run past midnight, 24-hour days, and dated
--    exceptions (holiday closures, special hours, temporary closures). Times are local clock
--    times in the place's own time zone, so clock-change days are handled by the time zone.
-- 2. Every set is published only through the R2 two-person place change (author, then a
--    different publisher with source and rights checks). Published sets are never edited:
--    a new set replaces the old one, which is kept, and the place history shows both.
-- 3. app.venue_hours_status(venue, at) is the one rule for "is it open": open, closed,
--    needs_confirmation (no checked hours, or checked longer ago than the configurable
--    'hours' freshness rule, 60 days) or temporarily_closed. Only "open" is ever shown as
--    open. Out-of-date hours stay visible as last known hours, labelled as needing confirmation.
-- 4. Search: the shared candidates (List and Map) accept "openNow"; both read the same
--    function, so they cannot disagree.
--
-- No location is read or stored here. Nothing calls an outside service.
--
-- Rollback (local): drop the functions and tables created here; re-create
-- app.catalog_candidates and app.venue_snapshot from 20261115000600 / 20261115000300 and
-- public.editor_review_change from 20261115000300; delete the 'hours' freshness rule and
-- restore the freshness_rules subject check.

-- ---------------------------------------------------------------------------
-- 1. Freshness setting: checked hours need re-checking after 60 days (configurable)
-- ---------------------------------------------------------------------------
alter table app.freshness_rules drop constraint freshness_rules_subject_check;
alter table app.freshness_rules add constraint freshness_rules_subject_check
  check (subject in ('dish', 'venue', 'packaged', 'ingredient', 'recipe', 'hours'));
insert into app.freshness_rules (subject, review_days, expire_days) values ('hours', 45, 60);

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.venue_hours_sets (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references public.venues (id) on delete cascade,
  state            text not null check (state in ('published', 'replaced')),
  sealed           boolean not null default false,
  change_id        uuid references public.catalog_changes (id) on delete set null,
  source_record_id uuid not null references public.source_records (id),
  checked_at       timestamptz not null,
  author_id        uuid references auth.users (id) on delete set null,
  reviewer_id      uuid references auth.users (id) on delete set null,
  published_at     timestamptz not null default now(),
  replaced_at      timestamptz,
  is_demo          boolean not null,
  check (author_id is null or reviewer_id is null or author_id <> reviewer_id)
);
create unique index venue_hours_sets_one_published on public.venue_hours_sets (venue_id) where state = 'published';
create index venue_hours_sets_venue_idx on public.venue_hours_sets (venue_id, published_at desc);

create table public.venue_hours_intervals (
  id              uuid primary key default gen_random_uuid(),
  set_id          uuid not null references public.venue_hours_sets (id) on delete cascade,
  day_of_week     smallint not null check (day_of_week between 0 and 6),  -- 0 = Sunday, as extract(dow)
  opens           time not null,
  closes          time not null,
  closes_next_day boolean not null default false,
  check (closes_next_day or closes > opens),
  check (not closes_next_day or closes <= opens)
);
create index venue_hours_intervals_set_idx on public.venue_hours_intervals (set_id, day_of_week);

create table public.venue_hours_exceptions (
  id              uuid primary key default gen_random_uuid(),
  set_id          uuid not null references public.venue_hours_sets (id) on delete cascade,
  starts_on       date not null,
  ends_on         date not null,
  kind            text not null check (kind in ('closed', 'special_hours', 'temporary_closure')),
  opens           time,
  closes          time,
  closes_next_day boolean not null default false,
  reason          text check (reason is null or length(reason) between 1 and 120),
  check (ends_on >= starts_on and ends_on - starts_on <= 366),
  check ((kind = 'special_hours') = (opens is not null and closes is not null)),
  check (kind <> 'special_hours' or closes_next_day or closes > opens),
  check (kind <> 'special_hours' or not closes_next_day or closes <= opens)
);
create index venue_hours_exceptions_set_idx on public.venue_hours_exceptions (set_id, starts_on);

-- Readers never touch these tables directly; they read through the functions below.
alter table public.venue_hours_sets enable row level security;
alter table public.venue_hours_sets force row level security;
alter table public.venue_hours_intervals enable row level security;
alter table public.venue_hours_intervals force row level security;
alter table public.venue_hours_exceptions enable row level security;
alter table public.venue_hours_exceptions force row level security;
revoke all on public.venue_hours_sets, public.venue_hours_intervals, public.venue_hours_exceptions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Checked hours are permanent
-- ---------------------------------------------------------------------------
-- A set may only be (a) sealed once, right after its rows are written, (b) marked replaced
-- once, (c) lose a link the database clears when an account or change is removed. It is
-- deleted only together with its place.
create function app.guard_hours_set()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.venues v where v.id = old.venue_id) then
      raise exception 'HOURS_ARE_PERMANENT' using errcode = 'PT403';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id or new.venue_id is distinct from old.venue_id
     or new.source_record_id is distinct from old.source_record_id or new.checked_at is distinct from old.checked_at
     or new.published_at is distinct from old.published_at or new.is_demo is distinct from old.is_demo
     or (new.sealed is distinct from old.sealed and not (new.sealed and not old.sealed))
     or (new.state is distinct from old.state and not (old.state = 'published' and new.state = 'replaced' and new.replaced_at is not null))
     or (new.replaced_at is distinct from old.replaced_at and not (old.replaced_at is null and new.state = 'replaced'))
     or (new.change_id is distinct from old.change_id and new.change_id is not null)
     or (new.author_id is distinct from old.author_id and new.author_id is not null)
     or (new.reviewer_id is distinct from old.reviewer_id and new.reviewer_id is not null) then
    raise exception 'HOURS_ARE_PERMANENT' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger venue_hours_sets_permanent before update or delete on public.venue_hours_sets
  for each row execute function app.guard_hours_set();

-- Periods and exceptions are written once, before their set is sealed, and never changed.
create function app.guard_hours_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.venue_hours_sets s where s.id = old.set_id) then
      raise exception 'HOURS_ARE_PERMANENT' using errcode = 'PT403';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' or exists (select 1 from public.venue_hours_sets s where s.id = new.set_id and s.sealed) then
    raise exception 'HOURS_ARE_PERMANENT' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger venue_hours_intervals_permanent before insert or update or delete on public.venue_hours_intervals
  for each row execute function app.guard_hours_row();
create trigger venue_hours_exceptions_permanent before insert or update or delete on public.venue_hours_exceptions
  for each row execute function app.guard_hours_row();

-- ---------------------------------------------------------------------------
-- 4. Working out the hours
-- ---------------------------------------------------------------------------
-- The opening periods of one set between two local dates, as exact moments. An exception
-- covering a date replaces that date's weekly periods; "closed" and "temporary_closure"
-- leave the date without periods.
create function app.hours_windows(p_set uuid, p_tz text, p_from date, p_to date)
returns table (opens_at timestamptz, closes_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with days as (
    select d::date as d from generate_series(p_from, p_to, interval '1 day') d
  ), slots as (
    select dd.d, i.opens, i.closes, i.closes_next_day
      from days dd join public.venue_hours_intervals i on i.set_id = p_set and i.day_of_week = extract(dow from dd.d)
     where not exists (select 1 from public.venue_hours_exceptions e where e.set_id = p_set and dd.d between e.starts_on and e.ends_on)
    union all
    select dd.d, e.opens, e.closes, e.closes_next_day
      from days dd join public.venue_hours_exceptions e on e.set_id = p_set and dd.d between e.starts_on and e.ends_on
     where e.kind = 'special_hours'
  )
  select (s.d + s.opens) at time zone p_tz,
         ((s.d + s.closes) + case when s.closes_next_day then interval '1 day' else interval '0' end) at time zone p_tz
    from slots s;
$$;

-- How many minutes before a verified closing time "Closes soon" is shown (MAP2-B). One place to change it.
create function app.closes_soon_minutes()
returns integer
language sql
immutable
set search_path = ''
as $$ select 30 $$;

-- The one rule. Returns:
--   state: open | closed | needs_confirmation | temporarily_closed
--   reason (needs_confirmation): unchecked | out_of_date
--   closesAt (open), opensAt (closed, or after a temporary closure), until (temporarily_closed),
--   open24h (open with no closing time in the next week), closesSoon (open, 30 minutes or less
--   before closing), checkedAt, timezone.
create function app.venue_hours_status(p_venue_id uuid, p_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.venues;
  s public.venue_hours_sets;
  v_tz text;
  v_expire integer;
  v_today date;
  v_close timestamptz;
  v_next timestamptz;
  v_until date;
  v_closure text;
  n integer := 0;
begin
  select * into v from public.venues where id = p_venue_id;
  if not found then return null; end if;
  v_tz := coalesce(v.timezone, (select m.default_timezone from public.markets m where m.id = v.market_id), 'America/New_York');
  v_today := (p_at at time zone v_tz)::date;
  select * into s from public.venue_hours_sets where venue_id = p_venue_id and state = 'published';
  if v.status = 'temporarily_closed' then
    return jsonb_build_object('state', 'temporarily_closed', 'timezone', v_tz, 'checkedAt', s.checked_at);
  end if;
  if s.id is null then
    return jsonb_build_object('state', 'needs_confirmation', 'reason', 'unchecked', 'timezone', v_tz);
  end if;
  select f.expire_days into v_expire from app.freshness_rules f where f.subject = 'hours';
  if v_expire is not null and s.checked_at + make_interval(days => v_expire) <= p_at then
    return jsonb_build_object('state', 'needs_confirmation', 'reason', 'out_of_date', 'timezone', v_tz, 'checkedAt', s.checked_at);
  end if;
  select e.ends_on, e.reason into v_until, v_closure from public.venue_hours_exceptions e
   where e.set_id = s.id and e.kind = 'temporary_closure' and v_today between e.starts_on and e.ends_on
   order by e.ends_on desc limit 1;
  if v_until is not null then
    select min(w.opens_at) into v_next from app.hours_windows(s.id, v_tz, v_until + 1, v_until + 8) w;
    return jsonb_build_object('state', 'temporarily_closed', 'until', v_until, 'note', v_closure, 'opensAt', v_next,
                              'timezone', v_tz, 'checkedAt', s.checked_at);
  end if;

  -- Open now: a period that has started and not ended. Periods that touch or overlap are
  -- followed, so "closes at" is the real closing time (for example across 24-hour days).
  select max(w.closes_at) into v_close from app.hours_windows(s.id, v_tz, v_today - 1, v_today) w
   where w.opens_at <= p_at and p_at < w.closes_at;
  if v_close is not null then
    loop
      n := n + 1;
      select max(w.closes_at) into v_next from app.hours_windows(s.id, v_tz, (v_close at time zone v_tz)::date - 1, (v_close at time zone v_tz)::date) w
       where w.opens_at <= v_close and v_close < w.closes_at;
      exit when v_next is null or n > 8;
      v_close := v_next;
    end loop;
    -- "Closes soon" (owner decision MAP2-B, 21:31 UTC): 30 minutes or less before the real
    -- closing time, which already follows overnight periods, special hours and holidays.
    return jsonb_build_object('state', 'open', 'closesAt', case when n > 8 then null else v_close end, 'open24h', n > 8,
                              'closesSoon', n <= 8 and v_close - p_at <= make_interval(mins => app.closes_soon_minutes()),
                              'timezone', v_tz, 'checkedAt', s.checked_at);
  end if;
  select min(w.opens_at) into v_next from app.hours_windows(s.id, v_tz, v_today, v_today + 7) w where w.opens_at > p_at;
  return jsonb_build_object('state', 'closed', 'opensAt', v_next, 'timezone', v_tz, 'checkedAt', s.checked_at);
end;
$$;

-- The checked hours of a set, in the shape editors send and readers see.
create function app.hours_json(p_set uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_set is null then null else jsonb_build_object(
    'weekly', coalesce((select jsonb_agg(jsonb_build_object('day', i.day_of_week, 'opens', to_char(i.opens, 'HH24:MI'),
                                 'closes', to_char(i.closes, 'HH24:MI'), 'closesNextDay', i.closes_next_day)
                                 order by i.day_of_week, i.opens)
                          from public.venue_hours_intervals i where i.set_id = p_set), '[]'::jsonb),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('startsOn', e.starts_on, 'endsOn', e.ends_on, 'kind', e.kind,
                                 'opens', to_char(e.opens, 'HH24:MI'), 'closes', to_char(e.closes, 'HH24:MI'),
                                 'closesNextDay', e.closes_next_day, 'reason', e.reason)
                                 order by e.starts_on, e.opens nulls first)
                          from public.venue_hours_exceptions e where e.set_id = p_set), '[]'::jsonb)) end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reading hours (place page, list rows, map pins)
-- ---------------------------------------------------------------------------
-- Readable for published places (demo places only when demo content is on), exactly like
-- public.venue_detail. Who checked is never shown: only when, and the source.
create function public.venue_hours(p_venue_id uuid, p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.venues;
  s public.venue_hours_sets;
  v_status jsonb;
  v_today date;
begin
  select * into v from public.venues
   where id = p_venue_id and status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not is_demo);
  if not found then raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404'; end if;
  select * into s from public.venue_hours_sets where venue_id = v.id and state = 'published';
  v_status := app.venue_hours_status(v.id, now());
  v_today := (now() at time zone (v_status ->> 'timezone'))::date;
  return jsonb_build_object(
    'status', v_status,
    'hours', case when s.id is not null then
      app.hours_json(s.id) || jsonb_build_object(
        -- Only exceptions that still matter to a reader.
        'exceptions', coalesce((select jsonb_agg(x) from jsonb_array_elements(app.hours_json(s.id) -> 'exceptions') x
                                 where (x ->> 'endsOn')::date >= v_today), '[]'::jsonb)) end,
    'checkedAt', s.checked_at,
    'freshness', case when s.id is not null then app.freshness_json('hours', s.checked_at) end,
    'source', case when s.id is not null then app.source_summary(s.source_record_id) end);
end;
$$;

-- Status for many places at once (list rows and pins). Unknown or hidden places are left out.
create function public.venue_hours_statuses(p_venue_ids uuid[], p_include_demo boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(v.id, app.venue_hours_status(v.id, now())), '{}'::jsonb)
    from public.venues v
   where v.id = any(p_venue_ids[1:500]) and v.status in ('published', 'temporarily_closed', 'closed')
     and (p_include_demo or not v.is_demo);
$$;

-- Places in a market that are open at a moment.
create function app.open_venue_ids(p_market uuid, p_at timestamptz)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  -- Set-based form of the "open" branch of app.venue_hours_status, so "Open now" reads every
  -- place in one pass instead of one call per place. tests/db/map2-hours.test.ts checks that it
  -- returns exactly the places that app.venue_hours_status calls open, at many moments.
  with s as materialized (
    select v.id as venue_id, st.id as set_id,
           ((p_at at time zone coalesce(v.timezone, m.default_timezone, 'America/New_York'))::date) as today,
           coalesce(v.timezone, m.default_timezone, 'America/New_York') as tz
      from public.venues v
      join public.markets m on m.id = v.market_id
      join public.venue_hours_sets st on st.venue_id = v.id and st.state = 'published'
     where v.market_id = p_market and v.status = 'published'
       and not exists (select 1 from app.freshness_rules f
                        where f.subject = 'hours' and f.expire_days is not null
                          and st.checked_at + make_interval(days => f.expire_days) <= p_at)
       and not exists (select 1 from public.venue_hours_exceptions e
                        where e.set_id = st.id and e.kind = 'temporary_closure'
                          and ((p_at at time zone coalesce(v.timezone, m.default_timezone, 'America/New_York'))::date) between e.starts_on and e.ends_on)
  ), days as (
    select s.venue_id, s.set_id, s.tz, d.d from s cross join lateral (values (s.today - 1), (s.today)) d(d)
  ), slots as (
    select dd.venue_id, dd.tz, dd.d, i.opens, i.closes, i.closes_next_day
      from days dd join public.venue_hours_intervals i on i.set_id = dd.set_id and i.day_of_week = extract(dow from dd.d)
     where not exists (select 1 from public.venue_hours_exceptions e where e.set_id = dd.set_id and dd.d between e.starts_on and e.ends_on)
    union all
    select dd.venue_id, dd.tz, dd.d, e.opens, e.closes, e.closes_next_day
      from days dd join public.venue_hours_exceptions e on e.set_id = dd.set_id and dd.d between e.starts_on and e.ends_on
     where e.kind = 'special_hours'
  )
  select coalesce(array_agg(distinct x.venue_id), '{}'::uuid[])
    from slots x
   where (x.d + x.opens) at time zone x.tz <= p_at
     and p_at < ((x.d + x.closes) + case when x.closes_next_day then interval '1 day' else interval '0' end) at time zone x.tz;
$$;

-- ---------------------------------------------------------------------------
-- 6. "Open now" in the shared candidates (List and Map)
-- ---------------------------------------------------------------------------
-- Identical to 20261115000600 apart from the lines marked MAP-2: with "openNow" only dishes at
-- places open at that moment remain; recipes and packaged foods have no opening hours.
create or replace function app.catalog_candidates(p jsonb)
returns table (
  item_id uuid, kind text, is_demo boolean, rev_id uuid, name text, brand text, published_at timestamptz,
  venue_id uuid, venue_slug text, venue_name text, neighborhood text, locality text, cuisines text[],
  price_band smallint, venue_type text, venue_lat double precision, venue_lon double precision,
  distance_m double precision, relevance double precision,
  pf jsonb, elig jsonb, sort_protein numeric, grp text, not_comparable boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_market_slug text := coalesce(p->>'market', 'boston');
  v_market uuid;
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_kinds text[] := case when p ? 'kinds' and jsonb_typeof(p->'kinds') = 'array'
                         then array(select jsonb_array_elements_text(p->'kinds')) end;
  v_diet text := coalesce(p->>'diet', 'none');
  v_excl text[] := case when p ? 'exclusions' and jsonb_typeof(p->'exclusions') = 'array'
                        then array(select jsonb_array_elements_text(p->'exclusions')) else '{}'::text[] end;
  v_incl_cond boolean := coalesce((p->>'includeConditional')::boolean, false);
  v_hood text := nullif(p->>'neighborhood', '');
  v_lat double precision := (p->>'lat')::double precision;
  v_lon double precision := (p->>'lon')::double precision;
  v_radius integer := coalesce((p->>'radiusM')::integer, 5000);
  v_point extensions.geography;
  v_box jsonb := case when jsonb_typeof(p->'bbox') = 'object' then p->'bbox' end;
  v_west double precision; v_south double precision; v_east double precision; v_north double precision;
  v_envelope extensions.geography;
  v_min_protein numeric := (p->>'minProtein')::numeric;
  v_basis text := coalesce(p->>'basis', 'serving');
  v_estimates boolean := coalesce(p->>'evidenceMode', 'published_calculated') = 'include_estimates';
  v_cuisine text := nullif(p->>'cuisine', '');
  v_max_price integer := (p->>'maxPriceBand')::integer;
  v_venue_type text := nullif(p->>'venueType', '');
  v_venue uuid := (p->>'venueId')::uuid;
  v_demo boolean := coalesce((p->>'includeDemo')::boolean, false);
  v_basis_key text;
  v_open_now boolean := coalesce((p->>'openNow')::boolean, false);                -- MAP-2
  v_at timestamptz := coalesce((p->>'at')::timestamptz, now());                  -- MAP-2 (tests choose the moment)
  v_open uuid[];                                                                 -- MAP-2
begin
  -- Same checks, same order and same messages as search_catalog has always made.
  if length(coalesce(v_q, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_basis not in ('serving', '100g', '100kcal') then raise exception 'INVALID_BASIS' using errcode = 'PT422'; end if;
  if v_kinds is not null and not (v_kinds <@ array['dish', 'recipe', 'packaged', 'ingredient']) then
    raise exception 'INVALID_KIND' using errcode = 'PT422';
  end if;
  if (v_lat is null) <> (v_lon is null) then raise exception 'INVALID_LOCATION' using errcode = 'PT422'; end if;
  if v_lat is not null then
    if v_lat < -90 or v_lat > 90 or v_lon < -180 or v_lon > 180 or v_radius < 100 or v_radius > 50000 then
      raise exception 'INVALID_LOCATION' using errcode = 'PT422';
    end if;
    v_point := extensions.st_setsrid(extensions.st_makepoint(v_lon, v_lat), 4326)::extensions.geography;
  end if;
  if p ? 'bbox' then
    -- A map rectangle: west, south, east, north in degrees; at most 2 degrees each way; not with a point.
    if v_box is null or v_lat is not null then raise exception 'INVALID_AREA' using errcode = 'PT422'; end if;
    v_west := (v_box->>'west')::double precision; v_south := (v_box->>'south')::double precision;
    v_east := (v_box->>'east')::double precision; v_north := (v_box->>'north')::double precision;
    if v_west is null or v_south is null or v_east is null or v_north is null
       or v_south < -90 or v_north > 90 or v_west < -180 or v_east > 180
       or v_west >= v_east or v_south >= v_north or v_east - v_west > 2 or v_north - v_south > 2 then
      raise exception 'INVALID_AREA' using errcode = 'PT422';
    end if;
    v_envelope := extensions.st_makeenvelope(v_west, v_south, v_east, v_north, 4326)::extensions.geography;
  end if;
  if v_min_protein is not null and (v_min_protein < 0 or v_min_protein > 500) then
    raise exception 'INVALID_MIN_PROTEIN' using errcode = 'PT422';
  end if;
  select m.id into v_market from public.markets m where m.slug = v_market_slug;
  if v_market is null then raise exception 'UNKNOWN_MARKET' using errcode = 'PT422'; end if;
  v_basis_key := case v_basis when 'serving' then 'perServing' when '100g' then 'per100g' else 'per100kcal' end;
  if v_open_now then v_open := app.open_venue_ids(v_market, v_at); end if;      -- MAP-2

  return query
  with base as materialized (
    select fi.id as item_id, fi.kind, fi.is_demo, r.id as rev_id, r.name, r.brand, r.published_at,
           v.id as venue_id, v.slug as venue_slug, v.name as venue_name, v.neighborhood, v.locality,
           v.cuisines, v.price_band, v.venue_type,
           extensions.st_y(v.location::extensions.geometry) as venue_lat,
           extensions.st_x(v.location::extensions.geometry) as venue_lon,
           case when v_point is not null and v.location is not null
                then extensions.st_distance(v.location, v_point) end as distance_m,
           (case when v_q is not null then extensions.similarity(r.name, v_q) else 0 end)::double precision as relevance
      from public.food_items fi
      join public.food_revisions r on r.id = fi.current_revision_id
      left join public.dishes d on d.food_item_id = fi.id
      left join public.venues v on v.id = d.venue_id
     where fi.visibility = 'public' and fi.status = 'published' and r.published_at is not null
       and (v_demo or not fi.is_demo)
       and (v_kinds is null or fi.kind = any(v_kinds))
       -- A dish is only discoverable at an open, published venue in the selected market (no silent cross-market results).
       and (fi.kind <> 'dish' or (v.status = 'published' and v.market_id = v_market and d.availability_status <> 'retired'))
       and (not v_open_now or (fi.kind = 'dish' and v.id = any(v_open)))       -- MAP-2
       and (v_q is null or r.name ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
            or v.name ilike '%' || replace(replace(v_q, '%', '\%'), '_', '\_') || '%'
            or v_q = any(v.cuisines)
            or to_tsvector('english', r.name || ' ' || coalesce(r.description, '')) @@ plainto_tsquery('english', v_q))
       and (v_hood is null or v.neighborhood = v_hood)
       and (v_point is null or (v.location is not null and extensions.st_dwithin(v.location, v_point, v_radius)))
       -- Rectangle: the spatial index narrows by bounding box, then the exact edges decide.
       and (v_envelope is null or (v.location is not null and v.location operator(extensions.&&) v_envelope
            and extensions.st_y(v.location::extensions.geometry) between v_south and v_north
            and extensions.st_x(v.location::extensions.geometry) between v_west and v_east))
       and (v_cuisine is null or v_cuisine = any(v.cuisines))
       and (v_max_price is null or v.price_band <= v_max_price)
       and (v_venue_type is null or v.venue_type = v_venue_type)
       and (v_venue is null or v.id = v_venue)
  ), elig as (
    -- The one dietary rule, asked once for all rows (SCALE-1).
    select e.revision_id, e.eligibility
      from app.eligibility_many(array(select b.rev_id from base b), v_diet, v_excl, v_incl_cond) e
  ), facts as materialized (
    select b.*, app.protein_facts(b.rev_id, v_estimates) as pf, el.eligibility as elig
      from base b join elig el on el.revision_id = b.rev_id
  ), grouped as (
    select f.*, (f.pf->>v_basis_key)::numeric as sort_protein,
           case f.elig->>'status'
             when 'excluded' then 'hidden'
             when 'eligible' then 'match'
             when 'conditional' then 'match'      -- only reachable when the person opted in to conditional dishes
             else 'needs_confirmation' end as grp
      from facts f
  )
  -- The minimum-protein filter never treats "unknown" as zero: rows that cannot be compared are set aside and counted.
  select g.item_id, g.kind, g.is_demo, g.rev_id, g.name, g.brand, g.published_at,
         g.venue_id, g.venue_slug, g.venue_name, g.neighborhood, g.locality, g.cuisines,
         g.price_band, g.venue_type, g.venue_lat, g.venue_lon, g.distance_m, g.relevance,
         g.pf, g.elig, g.sort_protein, g.grp,
         (v_min_protein is not null and g.sort_protein is null) as not_comparable
    from grouped g
   where v_min_protein is null or g.sort_protein is null or g.sort_protein >= v_min_protein;
end;
$$;
revoke all on function app.catalog_candidates(jsonb) from public, anon, authenticated;

-- How many places "Open now" left out because their hours are not checked or out of date,
-- for the same search with the same view. Shown in words next to the results.
create function public.open_now_left_out(p jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with c as materialized (
    select distinct c.venue_id
      from app.catalog_candidates(p - 'openNow' - 'limit' - 'offset' - 'sort' - 'limitPlaces' - 'view') c
     where c.venue_id is not null and not c.not_comparable
       and c.grp = case coalesce(p->>'view', 'matches') when 'needs_confirmation' then 'needs_confirmation' else 'match' end
  ), o as (
    select app.open_venue_ids((select m.id from public.markets m where m.slug = coalesce(p->>'market', 'boston')),
                              coalesce((p->>'at')::timestamptz, now())) as ids
  ), nc as (
    -- Not checked, or checked too long ago (a temporarily closed place is counted as closed).
    select c.venue_id
      from c join public.venues v on v.id = c.venue_id
      left join public.venue_hours_sets st on st.venue_id = c.venue_id and st.state = 'published'
     where v.status <> 'temporarily_closed'
       and (st.id is null or exists (select 1 from app.freshness_rules f
                                      where f.subject = 'hours' and f.expire_days is not null
                                        and st.checked_at + make_interval(days => f.expire_days) <= coalesce((p->>'at')::timestamptz, now())))
  )
  select jsonb_build_object(
    'placesNeedConfirmation', (select count(*) from nc),
    'placesClosed', (select count(*) from c where c.venue_id not in (select venue_id from nc)
                                                and not c.venue_id = any ((select ids from o)::uuid[])));
$$;
revoke all on function public.open_now_left_out(jsonb) from public;
grant execute on function public.open_now_left_out(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Entering hours (R2 place change, two people)
-- ---------------------------------------------------------------------------
-- Checks hours sent by an editor and returns them in one tidy shape, or explains the problem.
create function app.clean_hours(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  x jsonb;
  v_weekly jsonb := '[]'::jsonb;
  v_exc jsonb := '[]'::jsonb;
  v_opens time;
  v_closes time;
  v_next boolean;
  v_from date;
  v_to date;
  v_kind text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(coalesce(p -> 'weekly', 'null')) <> 'array' then
    raise exception 'INVALID_HOURS' using errcode = 'PT422';
  end if;
  if jsonb_array_length(p -> 'weekly') = 0 then raise exception 'HOURS_EMPTY' using errcode = 'PT422'; end if;
  if jsonb_array_length(p -> 'weekly') > 28 then raise exception 'INVALID_HOURS' using errcode = 'PT422'; end if;
  for x in select * from jsonb_array_elements(p -> 'weekly') loop
    begin
      v_opens := (x ->> 'opens')::time; v_closes := (x ->> 'closes')::time;
    exception when others then raise exception 'INVALID_TIME' using errcode = 'PT422';
    end;
    v_next := coalesce((x ->> 'closesNextDay')::boolean, false);
    if (x ->> 'day') is null or (x ->> 'day')::int not between 0 and 6 or v_opens is null or v_closes is null then
      raise exception 'INVALID_HOURS' using errcode = 'PT422';
    end if;
    if not v_next and v_closes <= v_opens then raise exception 'CLOSES_BEFORE_OPENS' using errcode = 'PT422'; end if;
    if v_next and v_closes > v_opens then raise exception 'INVALID_HOURS' using errcode = 'PT422'; end if;
    v_weekly := v_weekly || jsonb_build_object('day', (x ->> 'day')::int, 'opens', to_char(v_opens, 'HH24:MI'),
                                               'closes', to_char(v_closes, 'HH24:MI'), 'closesNextDay', v_next);
  end loop;
  if (select count(*) from jsonb_array_elements(v_weekly) w group by w ->> 'day' order by 1 desc limit 1) > 4 then
    raise exception 'TOO_MANY_PERIODS' using errcode = 'PT422';
  end if;
  -- Periods on the same day must not overlap.
  if exists (select 1 from jsonb_array_elements(v_weekly) a, jsonb_array_elements(v_weekly) b
              where a <> b and a ->> 'day' = b ->> 'day'
                and (a ->> 'opens')::time < case when (b ->> 'closesNextDay')::boolean then '24:00'::time else (b ->> 'closes')::time end
                and (b ->> 'opens')::time < case when (a ->> 'closesNextDay')::boolean then '24:00'::time else (a ->> 'closes')::time end) then
    raise exception 'PERIODS_OVERLAP' using errcode = 'PT422';
  end if;
  if jsonb_typeof(coalesce(p -> 'exceptions', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'exceptions', '[]'::jsonb)) > 60 then
    raise exception 'INVALID_HOURS' using errcode = 'PT422';
  end if;
  for x in select * from jsonb_array_elements(coalesce(p -> 'exceptions', '[]'::jsonb)) loop
    begin
      v_from := (x ->> 'startsOn')::date; v_to := coalesce((x ->> 'endsOn')::date, v_from);
      v_opens := (x ->> 'opens')::time; v_closes := (x ->> 'closes')::time;
    exception when others then raise exception 'INVALID_HOURS_DATE' using errcode = 'PT422';
    end;
    v_kind := x ->> 'kind';
    v_next := coalesce((x ->> 'closesNextDay')::boolean, false);
    if v_from is null or v_to < v_from or v_to - v_from > 366 or v_kind is null
       or v_kind not in ('closed', 'special_hours', 'temporary_closure') then
      raise exception 'INVALID_HOURS_DATE' using errcode = 'PT422';
    end if;
    if v_kind = 'special_hours' then
      if v_opens is null or v_closes is null then raise exception 'INVALID_HOURS' using errcode = 'PT422'; end if;
      if not v_next and v_closes <= v_opens then raise exception 'CLOSES_BEFORE_OPENS' using errcode = 'PT422'; end if;
      if v_next and v_closes > v_opens then raise exception 'INVALID_HOURS' using errcode = 'PT422'; end if;
    else
      v_opens := null; v_closes := null; v_next := false;
    end if;
    v_exc := v_exc || jsonb_build_object('startsOn', v_from, 'endsOn', v_to, 'kind', v_kind,
                                         'opens', to_char(v_opens, 'HH24:MI'), 'closes', to_char(v_closes, 'HH24:MI'),
                                         'closesNextDay', v_next, 'reason', app.clean_text(x ->> 'reason', 120));
  end loop;
  return jsonb_build_object('weekly', v_weekly, 'exceptions', v_exc);
end;
$$;

-- The author puts checked hours on their draft place change. They are published only when a
-- different publisher approves the change (editor_review_change below).
create function public.editor_save_hours(p_change_id uuid, p_hours jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  ch public.catalog_changes;
  v_clean jsonb;
begin
  select * into ch from public.catalog_changes where id = p_change_id for update;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  if ch.author_id is distinct from v_uid then raise exception 'NOT_YOUR_DRAFT' using errcode = 'PT403'; end if;
  if ch.state <> 'draft' then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  if ch.kind <> 'venue' then raise exception 'INVALID_PATCH' using errcode = 'PT422'; end if;
  if p_hours is null or jsonb_typeof(p_hours) = 'null' then
    update public.catalog_changes set payload = payload - 'structuredHours' where id = ch.id;
    return jsonb_build_object('changeId', ch.id, 'structuredHours', null);
  end if;
  v_clean := app.clean_hours(p_hours);
  update public.catalog_changes set payload = jsonb_set(payload, '{structuredHours}', v_clean) where id = ch.id;
  perform app.audit('catalog_change.hours_saved', 'catalog_change', ch.id, null);
  return jsonb_build_object('changeId', ch.id, 'structuredHours', v_clean);
end;
$$;
revoke all on function public.editor_save_hours(uuid, jsonb) from public, anon;
grant execute on function public.editor_save_hours(uuid, jsonb) to authenticated;

-- Publishes checked hours for a place: the current set (if any) becomes "replaced" and is kept.
create function app.publish_hours(p_venue uuid, p_hours jsonb, p_source uuid, p_author uuid, p_reviewer uuid, p_change uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean jsonb := app.clean_hours(p_hours);
  v_set uuid;
  x jsonb;
begin
  update public.venue_hours_sets set state = 'replaced', replaced_at = clock_timestamp()
   where venue_id = p_venue and state = 'published';
  insert into public.venue_hours_sets (venue_id, state, change_id, source_record_id, checked_at, author_id, reviewer_id, published_at, is_demo)
  values (p_venue, 'published', p_change, p_source, clock_timestamp(), p_author, p_reviewer, clock_timestamp(),
          (select v.is_demo from public.venues v where v.id = p_venue))
  returning id into v_set;
  for x in select * from jsonb_array_elements(v_clean -> 'weekly') loop
    insert into public.venue_hours_intervals (set_id, day_of_week, opens, closes, closes_next_day)
    values (v_set, (x ->> 'day')::smallint, (x ->> 'opens')::time, (x ->> 'closes')::time, (x ->> 'closesNextDay')::boolean);
  end loop;
  for x in select * from jsonb_array_elements(v_clean -> 'exceptions') loop
    insert into public.venue_hours_exceptions (set_id, starts_on, ends_on, kind, opens, closes, closes_next_day, reason)
    values (v_set, (x ->> 'startsOn')::date, (x ->> 'endsOn')::date, x ->> 'kind', (x ->> 'opens')::time, (x ->> 'closes')::time,
            (x ->> 'closesNextDay')::boolean, x ->> 'reason');
  end loop;
  update public.venue_hours_sets set sealed = true where id = v_set;
  return v_set;
end;
$$;
revoke all on function app.publish_hours(uuid, jsonb, uuid, uuid, uuid, uuid) from public, anon, authenticated;

-- History shows the checked hours before and after each change.
create or replace function app.venue_snapshot(p_venue_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name', v.name, 'neighborhood', v.neighborhood, 'street', v.street, 'locality', v.locality, 'region', v.region,
    'postalCode', v.postal_code, 'venueType', v.venue_type, 'status', v.status,
    'lat', case when v.location is not null then round(extensions.st_y(v.location::extensions.geometry)::numeric, 6) end,
    'lon', case when v.location is not null then round(extensions.st_x(v.location::extensions.geometry)::numeric, 6) end,
    'hours', (select f.typed_value ->> 'text' from public.venue_facts f where f.venue_id = v.id and f.field = 'hours' order by f.checked_at desc, f.id limit 1),
    'statusNote', (select f.typed_value ->> 'text' from public.venue_facts f where f.venue_id = v.id and f.field = 'status_note' order by f.checked_at desc, f.id limit 1),
    'structuredHours', (select app.hours_json(s.id) from public.venue_hours_sets s where s.venue_id = v.id and s.state = 'published'),
    'reviewedAt', v.reviewed_at)
  from public.venues v where v.id = p_venue_id;
$$;

-- The place-change approval, identical to 20261115000300 apart from the lines marked MAP-2:
-- approving a change that carries checked hours publishes them, before the history row is written.
create or replace function public.editor_review_change(
  p_change_id uuid, p_decision text, p_note text default null,
  p_source_checked boolean default false, p_rights_ok boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  ch public.catalog_changes;
  fi public.food_items;
  v_note text := app.clean_text(p_note, 500);
  v_dish jsonb;
  v_venue uuid;
  v_market public.markets;
  v_before jsonb;
  v_after jsonb;
  v_hours text;
  v_note_text text;
  p jsonb;
begin
  if not app.has_role('publisher') then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  select * into ch from public.catalog_changes where id = p_change_id for update;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  if ch.state <> 'submitted' then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  if ch.author_id is null or ch.author_id = v_uid then raise exception 'SECOND_PERSON_REQUIRED' using errcode = 'PT403'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'INVALID_ACTION' using errcode = 'PT422'; end if;

  if p_decision = 'reject' then
    if v_note is null then raise exception 'REASON_REQUIRED' using errcode = 'PT422'; end if;
    perform app.discard_draft(ch);
    update public.catalog_changes set state = 'rejected', reviewer_id = v_uid, reviewed_at = now(), review_note = v_note where id = ch.id;
    perform app.audit('catalog_change.rejected', 'catalog_change', ch.id, v_note);
    return jsonb_build_object('changeId', ch.id, 'state', 'rejected');
  end if;

  if not coalesce(p_source_checked, false) or not coalesce(p_rights_ok, false) then
    raise exception 'CHECKS_REQUIRED' using errcode = 'PT422';
  end if;
  if ch.source_record_id is null then raise exception 'SOURCE_REQUIRED' using errcode = 'PT422'; end if;
  update public.source_records set rights_status = 'cleared' where id = ch.source_record_id;

  if ch.kind = 'food' then
    select * into fi from public.food_items where id = ch.food_item_id;
    perform public.publish_food_revision(ch.draft_revision_id, fi.version, v_note);
    v_dish := ch.payload -> 'dish';
    if v_dish is not null then
      update public.dishes set menu_section = coalesce(v_dish ->> 'menuSection', menu_section) where food_item_id = fi.id;
      if (v_dish ->> 'priceCents') is not null then
        insert into public.dish_prices (dish_id, amount_minor, serving_description, checked_at, source_record_id)
        values (fi.id, (v_dish ->> 'priceCents')::integer, v_dish ->> 'servingDescription', now(), ch.source_record_id);
      end if;
    end if;
    update public.review_flags set resolved_at = now(), resolved_change_id = ch.id where food_item_id = fi.id and resolved_at is null;
  else
    p := ch.payload;
    if app.clean_text(p ->> 'name', 200) is null then raise exception 'NAME_REQUIRED' using errcode = 'PT422'; end if;
    if ch.venue_id is null then
      select * into v_market from public.markets m where m.slug = 'boston';
      insert into public.venues (market_id, slug, name, neighborhood, street, locality, region, postal_code, location, timezone, venue_type, status, is_demo, reviewed_at)
      values (v_market.id,
              left(trim(both '-' from regexp_replace(lower(p ->> 'name'), '[^a-z0-9]+', '-', 'g')), 100) || '-' || left(ch.id::text, 8),
              p ->> 'name', p ->> 'neighborhood', p ->> 'street', p ->> 'locality', p ->> 'region', p ->> 'postalCode',
              case when (p ->> 'lat') is not null and (p ->> 'lon') is not null
                   then extensions.st_setsrid(extensions.st_makepoint((p ->> 'lon')::double precision, (p ->> 'lat')::double precision), 4326)::extensions.geography end,
              v_market.default_timezone, coalesce(p ->> 'venueType', 'restaurant'), coalesce(p ->> 'status', 'published'), app.entry_is_demo(), now())
      returning id into v_venue;
    else
      v_venue := ch.venue_id;
      -- The values published until now, kept before anything is changed.
      v_before := app.venue_snapshot(v_venue);
      update public.venues v
         set name = p ->> 'name', neighborhood = p ->> 'neighborhood', street = p ->> 'street', locality = p ->> 'locality',
             region = p ->> 'region', postal_code = p ->> 'postalCode', venue_type = coalesce(p ->> 'venueType', v.venue_type),
             status = coalesce(p ->> 'status', v.status),
             location = case when (p ->> 'lat') is not null and (p ->> 'lon') is not null
                   then extensions.st_setsrid(extensions.st_makepoint((p ->> 'lon')::double precision, (p ->> 'lat')::double precision), 4326)::extensions.geography
                   else v.location end,
             reviewed_at = now()
       where v.id = v_venue;
    end if;
    -- Hours and note: a new checked fact only when the value changed; otherwise the
    -- existing fact counts as re-checked through this change's history row.
    v_hours := app.clean_text(p ->> 'hours', 500);
    if v_hours is not null and v_hours is distinct from (v_before ->> 'hours') then
      insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at, expires_at)
      values (v_venue, 'hours', jsonb_build_object('text', v_hours), ch.source_record_id, clock_timestamp(), clock_timestamp() + interval '60 days');
    end if;
    v_note_text := app.clean_text(p ->> 'statusNote', 300);
    if v_note_text is not null and v_note_text is distinct from (v_before ->> 'statusNote') then
      insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at, expires_at)
      values (v_venue, 'status_note', jsonb_build_object('text', v_note_text), ch.source_record_id, clock_timestamp(), clock_timestamp() + interval '60 days');
    end if;
    if jsonb_typeof(p -> 'structuredHours') = 'object' then                                         -- MAP-2
      perform app.publish_hours(v_venue, p -> 'structuredHours', ch.source_record_id, ch.author_id, v_uid, ch.id);  -- MAP-2
    end if;                                                                                          -- MAP-2
    update public.catalog_changes set venue_id = v_venue where id = ch.id;
    v_after := app.venue_snapshot(v_venue);
    insert into public.venue_revisions (venue_id, revision_no, change_id, before_values, after_values, source_record_id, source_snapshot,
                                        author_id, reviewer_id, submitted_at, published_at, is_demo)
    values (v_venue,
            coalesce((select max(r.revision_no) from public.venue_revisions r where r.venue_id = v_venue), 0) + 1,
            ch.id, v_before, v_after, ch.source_record_id,
            (select jsonb_build_object('publisher', s.publisher, 'sourceType', s.source_type, 'url', s.canonical_url,
                                       'observedAt', sr.observed_at, 'summary', sr.evidence_summary, 'rightsStatus', sr.rights_status)
               from public.source_records sr join public.sources s on s.id = sr.source_id where sr.id = ch.source_record_id),
            ch.author_id, v_uid, ch.submitted_at, now(),
            (select v.is_demo from public.venues v where v.id = v_venue));
  end if;

  update public.catalog_changes
     set state = 'published', reviewer_id = v_uid, reviewed_at = now(), review_note = v_note,
         draft_snapshot = case when ch.kind = 'food' then app.editor_evidence(ch.draft_revision_id) end
   where id = ch.id;
  if ch.correction_id is not null then
    update public.corrections set applied_change_id = ch.id where id = ch.correction_id;
  end if;
  perform app.audit('catalog_change.published', 'catalog_change', ch.id, v_note);
  return jsonb_build_object('changeId', ch.id, 'state', 'published', 'venueId', v_venue, 'foodItemId', ch.food_item_id);
end;
$$;

-- Withdrawing: the draft is discarded before the change is closed, so the closed

-- ---------------------------------------------------------------------------
-- 8. Who may call what
-- ---------------------------------------------------------------------------
revoke all on function public.venue_hours(uuid, boolean) from public;
grant execute on function public.venue_hours(uuid, boolean) to anon, authenticated;
revoke all on function public.venue_hours_statuses(uuid[], boolean) from public;
grant execute on function public.venue_hours_statuses(uuid[], boolean) to anon, authenticated;
revoke all on function app.venue_hours_status(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.hours_windows(uuid, text, date, date) from public, anon, authenticated;
revoke all on function app.closes_soon_minutes() from public, anon, authenticated;
revoke all on function app.hours_json(uuid) from public, anon, authenticated;
revoke all on function app.open_venue_ids(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.clean_hours(jsonb) from public, anon, authenticated;
revoke all on function app.guard_hours_set() from public, anon, authenticated;
revoke all on function app.guard_hours_row() from public, anon, authenticated;
