-- MAP-1 step 2: switch the searches to the set-based dietary rule, and add the map search.
--
-- Authority: APPROVALS A-MAP-1 (owner, 15 Nov 2026 06:54 UTC). Synthetic data, local only.
--
-- 1. Searches (list and map) use the set-based app.eligibility_many: one call for all the
--    candidate rows. app.eligibility, the one-dish form used by dish pages, feeds, lists and
--    recipes, is left exactly as it was: measured on the scale data, routing single-dish
--    callers through the set-based form made them slower (recommendations about 50 ms -> 160 ms),
--    so each caller keeps the form that is fast for it. The two forms must always agree; that is
--    proved by tests/db/map1-eligibility.test.ts (every revision x diets x exclusion sets) and
--    was shown before this switch on the demo catalog (2,580 cases) and on the 2,000-dish
--    scale data (62,640 cases): LEDGER 15 Nov.
-- 2. app.catalog_candidates(p) is the one place that decides which published rows a search
--    may return and how each fits the person's dietary choice. public.search_catalog (the
--    list) and public.search_map (the map) both read it, so they cannot disagree. It also
--    accepts a map rectangle ("bbox") as well as a point and radius.
-- 3. public.geo_areas and public.map_areas(): approximate centres of Boston-area
--    neighbourhoods, cities and ZIP codes for typed place search (owner decision M-4).
--    Entered by hand, marked approximate; no outlines and no outside service.
-- 4. public.search_map(p): places with at least one dish in the chosen group, each with
--    those dishes; for a signed-in member only, their own saved places, their own lists and
--    picks from people they follow under the M5 rules.
--
-- Location: a position arrives inside the request body, is used for this one query and is
-- written nowhere: no table here stores it, and the functions never log or audit it.
--
-- Rollback (local): drop function public.search_map(jsonb), public.map_areas(text),
--   app.followed_picks(uuid, boolean), app.catalog_candidates(jsonb); drop table public.geo_areas;
--   then re-create public.search_catalog from 20261113000600_m2_discovery.sql and apply the
--   "materialized" step from 20261115000100_r1_hardening.sql.

-- ---------------------------------------------------------------------------
-- 2. Shared candidates for the list and the map
-- ---------------------------------------------------------------------------
create function app.catalog_candidates(p jsonb)
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

-- The list search, now reading the shared candidates. Its answer is unchanged.
create or replace function public.search_catalog(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_market_slug text := coalesce(p->>'market', 'boston');
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_diet text := coalesce(p->>'diet', 'none');
  v_excl text[] := case when p ? 'exclusions' and jsonb_typeof(p->'exclusions') = 'array'
                        then array(select jsonb_array_elements_text(p->'exclusions')) else '{}'::text[] end;
  v_view text := coalesce(p->>'view', 'matches');
  v_has_point boolean := (p->>'lat') is not null;
  v_basis text := coalesce(p->>'basis', 'serving');
  v_sort text := coalesce(p->>'sort', 'default');
  v_limit integer := coalesce((p->>'limit')::integer, 20);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_view not in ('matches', 'needs_confirmation') then raise exception 'INVALID_VIEW' using errcode = 'PT422'; end if;
  if v_basis not in ('serving', '100g', '100kcal') then raise exception 'INVALID_BASIS' using errcode = 'PT422'; end if;
  if v_sort not in ('default', 'protein') then raise exception 'INVALID_SORT' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > 50 then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;

  with filtered as materialized (
    select * from app.catalog_candidates(p)
  ), visible as (
    select * from filtered
     where grp = case v_view when 'matches' then 'match' else 'needs_confirmation' end
       and not not_comparable
  ), ordered as (
    select v.*, row_number() over (
             order by
               case when v_sort = 'protein' then v.sort_protein end desc nulls last,
               case when v_sort = 'default' and v_has_point then v.distance_m end asc nulls last,
               case when v_sort = 'default' and v_q is not null then v.relevance end desc nulls last,
               v.published_at desc, v.item_id) as rn
      from visible v
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'foodItemId', o.item_id, 'revisionId', o.rev_id, 'kind', o.kind, 'name', o.name, 'brand', o.brand, 'isDemo', o.is_demo,
        'venue', case when o.venue_id is not null then jsonb_build_object(
            'id', o.venue_id, 'slug', o.venue_slug, 'name', o.venue_name, 'neighborhood', o.neighborhood,
            'locality', o.locality, 'cuisines', to_jsonb(o.cuisines), 'priceBand', o.price_band) end,
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'protein', o.pf,
        'eligibility', o.elig,
        'families', coalesce((
            select jsonb_agg(jsonb_build_object('family', fam.code, 'label', fam.label, 'presence', app.family_presence(o.rev_id, fam.code)) order by fam.code)
              from public.ingredient_families fam
             where app.family_presence(o.rev_id, fam.code) <> 'unknown'), '[]'::jsonb)
      ) order by o.rn)
      from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'nextOffset', case when (select count(*) from ordered) > v_offset + v_limit then v_offset + v_limit end,
    'counts', jsonb_build_object(
      'matches', (select count(*) from filtered where grp = 'match' and not not_comparable),
      'needsConfirmation', (select count(*) from filtered where grp = 'needs_confirmation' and not not_comparable),
      'hidden', (select count(*) from filtered where grp = 'hidden'),
      'notComparable', (select count(*) from filtered where not_comparable and grp <> 'hidden')),
    -- Why rows are hidden, without listing them as results.
    'hiddenReasons', coalesce((
      select jsonb_agg(jsonb_build_object('code', x.code, 'family', x.family, 'count', x.n) order by x.n desc, x.family)
        from (select reason->>'code' as code, reason->>'family' as family, count(distinct f2.item_id) as n
                from filtered f2, jsonb_array_elements(f2.elig->'reasons') reason
               where f2.grp = 'hidden' and reason->>'code' in ('contains_excluded_family', 'contains_family', 'diet_incompatible')
               group by 1, 2) x), '[]'::jsonb),
    'applied', jsonb_build_object('diet', v_diet, 'exclusions', to_jsonb(v_excl), 'view', v_view, 'basis', v_basis,
                                  'sort', case when v_sort = 'protein' then 'protein'
                                               when v_has_point then 'distance'
                                               when v_q is not null then 'relevance' else 'freshness' end,
                                  'market', v_market_slug)
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Approximate place centres for typed place search (M-4)
-- ---------------------------------------------------------------------------
create table public.geo_areas (
  slug        text primary key check (slug ~ '^[a-z0-9-]{2,60}$'),
  market_slug text not null check (market_slug ~ '^[a-z0-9-]{2,60}$'),
  kind        text not null check (kind in ('neighborhood', 'city', 'zip')),
  name        text not null check (length(name) between 1 and 80),
  context     text check (context is null or length(context) <= 80),
  center      extensions.geography(Point, 4326) not null,
  approximate boolean not null default true,
  note        text not null default 'Approximate centre entered by hand for the synthetic-data prototype (MAP-1, decision M-4). Not a boundary.'
);
alter table public.geo_areas enable row level security;
alter table public.geo_areas force row level security;
-- No table privileges: read through public.map_areas() only.
revoke all on public.geo_areas from public, anon, authenticated;

insert into public.geo_areas (slug, market_slug, kind, name, context, center)
select a.slug, 'boston', a.kind, a.name, a.context,
       extensions.st_setsrid(extensions.st_makepoint(a.lon, a.lat), 4326)::extensions.geography
  from (values
    -- Cities
    ('boston', 'city', 'Boston', 'Massachusetts', 42.3601, -71.0589),
    ('cambridge', 'city', 'Cambridge', 'Massachusetts', 42.3736, -71.1097),
    ('somerville', 'city', 'Somerville', 'Massachusetts', 42.3876, -71.0995),
    ('brookline', 'city', 'Brookline', 'Massachusetts', 42.3318, -71.1212),
    -- Boston neighbourhoods
    ('allston', 'neighborhood', 'Allston', 'Boston', 42.3539, -71.1320),
    ('brighton', 'neighborhood', 'Brighton', 'Boston', 42.3480, -71.1530),
    ('back-bay', 'neighborhood', 'Back Bay', 'Boston', 42.3503, -71.0810),
    ('beacon-hill', 'neighborhood', 'Beacon Hill', 'Boston', 42.3588, -71.0707),
    ('north-end', 'neighborhood', 'North End', 'Boston', 42.3647, -71.0542),
    ('west-end', 'neighborhood', 'West End', 'Boston', 42.3640, -71.0640),
    ('downtown', 'neighborhood', 'Downtown', 'Boston', 42.3555, -71.0605),
    ('chinatown', 'neighborhood', 'Chinatown', 'Boston', 42.3496, -71.0621),
    ('south-end', 'neighborhood', 'South End', 'Boston', 42.3417, -71.0720),
    ('fenway', 'neighborhood', 'Fenway', 'Boston', 42.3429, -71.1003),
    ('mission-hill', 'neighborhood', 'Mission Hill', 'Boston', 42.3325, -71.1030),
    ('jamaica-plain', 'neighborhood', 'Jamaica Plain', 'Boston', 42.3097, -71.1151),
    ('roxbury', 'neighborhood', 'Roxbury', 'Boston', 42.3152, -71.0914),
    ('south-boston', 'neighborhood', 'South Boston', 'Boston', 42.3381, -71.0476),
    ('seaport', 'neighborhood', 'Seaport', 'Boston', 42.3519, -71.0446),
    ('dorchester', 'neighborhood', 'Dorchester', 'Boston', 42.3016, -71.0676),
    ('east-boston', 'neighborhood', 'East Boston', 'Boston', 42.3702, -71.0389),
    ('charlestown', 'neighborhood', 'Charlestown', 'Boston', 42.3782, -71.0602),
    ('roslindale', 'neighborhood', 'Roslindale', 'Boston', 42.2832, -71.1270),
    ('west-roxbury', 'neighborhood', 'West Roxbury', 'Boston', 42.2799, -71.1627),
    ('hyde-park', 'neighborhood', 'Hyde Park', 'Boston', 42.2565, -71.1241),
    ('mattapan', 'neighborhood', 'Mattapan', 'Boston', 42.2771, -71.0914),
    -- Cambridge and Somerville squares
    ('central-square', 'neighborhood', 'Central Square', 'Cambridge', 42.3655, -71.1040),
    ('harvard-square', 'neighborhood', 'Harvard Square', 'Cambridge', 42.3736, -71.1190),
    ('kendall-square', 'neighborhood', 'Kendall Square', 'Cambridge', 42.3626, -71.0843),
    ('inman-square', 'neighborhood', 'Inman Square', 'Cambridge', 42.3734, -71.1006),
    ('porter-square', 'neighborhood', 'Porter Square', 'Cambridge', 42.3884, -71.1191),
    ('davis-square', 'neighborhood', 'Davis Square', 'Somerville', 42.3967, -71.1226),
    ('union-square', 'neighborhood', 'Union Square', 'Somerville', 42.3796, -71.0935),
    -- ZIP codes (approximate centres)
    ('zip-02108', 'zip', '02108', 'Beacon Hill, Boston', 42.3576, -71.0657),
    ('zip-02109', 'zip', '02109', 'Waterfront, Boston', 42.3600, -71.0540),
    ('zip-02110', 'zip', '02110', 'Financial District, Boston', 42.3570, -71.0520),
    ('zip-02111', 'zip', '02111', 'Chinatown, Boston', 42.3500, -71.0610),
    ('zip-02113', 'zip', '02113', 'North End, Boston', 42.3650, -71.0550),
    ('zip-02114', 'zip', '02114', 'West End, Boston', 42.3610, -71.0680),
    ('zip-02115', 'zip', '02115', 'Fenway, Boston', 42.3430, -71.0920),
    ('zip-02116', 'zip', '02116', 'Back Bay, Boston', 42.3490, -71.0760),
    ('zip-02118', 'zip', '02118', 'South End, Boston', 42.3370, -71.0710),
    ('zip-02119', 'zip', '02119', 'Roxbury, Boston', 42.3240, -71.0850),
    ('zip-02120', 'zip', '02120', 'Mission Hill, Boston', 42.3320, -71.0960),
    ('zip-02121', 'zip', '02121', 'Dorchester, Boston', 42.3070, -71.0830),
    ('zip-02122', 'zip', '02122', 'Dorchester, Boston', 42.2910, -71.0430),
    ('zip-02124', 'zip', '02124', 'Dorchester, Boston', 42.2860, -71.0710),
    ('zip-02125', 'zip', '02125', 'Dorchester, Boston', 42.3160, -71.0590),
    ('zip-02126', 'zip', '02126', 'Mattapan, Boston', 42.2740, -71.0930),
    ('zip-02127', 'zip', '02127', 'South Boston', 42.3360, -71.0390),
    ('zip-02128', 'zip', '02128', 'East Boston', 42.3750, -71.0280),
    ('zip-02129', 'zip', '02129', 'Charlestown, Boston', 42.3780, -71.0610),
    ('zip-02130', 'zip', '02130', 'Jamaica Plain, Boston', 42.3110, -71.1120),
    ('zip-02131', 'zip', '02131', 'Roslindale, Boston', 42.2850, -71.1300),
    ('zip-02132', 'zip', '02132', 'West Roxbury, Boston', 42.2800, -71.1590),
    ('zip-02134', 'zip', '02134', 'Allston, Boston', 42.3550, -71.1320),
    ('zip-02135', 'zip', '02135', 'Brighton, Boston', 42.3480, -71.1560),
    ('zip-02136', 'zip', '02136', 'Hyde Park, Boston', 42.2550, -71.1260),
    ('zip-02210', 'zip', '02210', 'Seaport, Boston', 42.3480, -71.0400),
    ('zip-02215', 'zip', '02215', 'Fenway and Kenmore, Boston', 42.3470, -71.1020),
    ('zip-02138', 'zip', '02138', 'Harvard Square, Cambridge', 42.3770, -71.1250),
    ('zip-02139', 'zip', '02139', 'Central Square, Cambridge', 42.3640, -71.1030),
    ('zip-02140', 'zip', '02140', 'North Cambridge', 42.3920, -71.1330),
    ('zip-02141', 'zip', '02141', 'East Cambridge', 42.3700, -71.0830),
    ('zip-02142', 'zip', '02142', 'Kendall Square, Cambridge', 42.3620, -71.0830),
    ('zip-02143', 'zip', '02143', 'Union Square, Somerville', 42.3820, -71.1000),
    ('zip-02144', 'zip', '02144', 'Davis Square, Somerville', 42.3990, -71.1220),
    ('zip-02145', 'zip', '02145', 'East Somerville', 42.3910, -71.0890)
  ) as a(slug, kind, name, context, lat, lon);

create function public.map_areas(p_market text default 'boston')
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', g.slug, 'kind', g.kind, 'name', g.name, 'context', g.context,
           'lat', round(extensions.st_y(g.center::extensions.geometry)::numeric, 4),
           'lon', round(extensions.st_x(g.center::extensions.geometry)::numeric, 4),
           'approximate', g.approximate)
         order by case g.kind when 'city' then 1 when 'neighborhood' then 2 else 3 end, g.name), '[]'::jsonb)
    from public.geo_areas g where g.market_slug = p_market;
$$;
revoke all on function public.map_areas(text) from public;
grant execute on function public.map_areas(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The map search
-- ---------------------------------------------------------------------------
-- What people the member follows rated 4 or 5, under exactly the rules of
-- public.social_recommendations (M5): only people the member may see, public and visible
-- reviews only, and nothing the member has reviewed themselves.
create function app.followed_picks(p_uid uuid, p_include_demo boolean)
returns table (venue_id uuid, food_item_id uuid, reasons jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with ok as (
    select f.followed_id as id from public.follows f
     where p_uid is not null and f.follower_id = p_uid and app.profile_ok(p_uid, f.followed_id, p_include_demo)
  )
  select r.venue_id, r.food_item_id,
         jsonb_agg(jsonb_build_object('person', app.person_json(r.author_id), 'rating', r.rating) order by r.rating desc, r.published_at desc)
    from public.reviews r join ok on ok.id = r.author_id
   where r.audience = 'public' and r.publication_state = 'visible' and r.rating >= 4
     and not exists (select 1 from public.reviews mine
                      where mine.author_id = p_uid and (mine.venue_id = r.venue_id or mine.food_item_id = r.food_item_id))
   group by r.venue_id, r.food_item_id;
$$;
revoke all on function app.followed_picks(uuid, boolean) from public, anon, authenticated;

create function public.search_map(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_view text := coalesce(p->>'view', 'matches');
  v_limit integer := coalesce((p->>'limitPlaces')::integer, 200);
  v_demo boolean := coalesce((p->>'includeDemo')::boolean, false);
  v_has_point boolean := (p->>'lat') is not null;
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_view not in ('matches', 'needs_confirmation') then raise exception 'INVALID_VIEW' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > 200 then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if p ? 'kinds' and p->'kinds' is distinct from '["dish"]'::jsonb then raise exception 'INVALID_KIND' using errcode = 'PT422'; end if;

  with c as materialized (
    -- Exactly what the list would consider: same function, same filters; places only hold dishes.
    select * from app.catalog_candidates((p - 'limit' - 'offset' - 'sort' - 'limitPlaces' - 'view') || '{"kinds": ["dish"]}'::jsonb)
  ), shown as (
    -- Never mixed: the "matches" map shows only confirmed dishes, the "needs confirmation" map only those.
    select * from c
     where venue_id is not null and not not_comparable
       and grp = case v_view when 'matches' then 'match' else 'needs_confirmation' end
  ), picks as materialized (
    select * from app.followed_picks(v_uid, v_demo)
  ), places as (
    select s.venue_id, s.venue_slug, s.venue_name, s.neighborhood, s.locality, s.cuisines, s.price_band, s.venue_type,
           s.venue_lat, s.venue_lon, min(s.distance_m) as distance_m, count(*) as n,
           jsonb_agg(jsonb_build_object(
             'foodItemId', s.item_id, 'revisionId', s.rev_id, 'kind', s.kind, 'name', s.name, 'brand', s.brand, 'isDemo', s.is_demo,
             'distanceM', case when s.distance_m is not null then round(s.distance_m::numeric) end,
             'protein', s.pf, 'eligibility', s.elig,
             'recommendedBy', (select pk.reasons from picks pk where pk.food_item_id = s.item_id))
             order by s.sort_protein desc nulls last, s.name, s.item_id) as dishes
      from shown s
     group by s.venue_id, s.venue_slug, s.venue_name, s.neighborhood, s.locality, s.cuisines, s.price_band, s.venue_type,
              s.venue_lat, s.venue_lon
  ), ordered as (
    select pl.*, row_number() over (
             order by case when v_has_point then pl.distance_m end asc nulls last, pl.n desc, pl.venue_name, pl.venue_id) as rn
      from places pl
  )
  select jsonb_build_object(
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.venue_id, 'slug', o.venue_slug, 'name', o.venue_name, 'neighborhood', o.neighborhood, 'locality', o.locality,
        'cuisines', to_jsonb(o.cuisines), 'priceBand', o.price_band, 'venueType', o.venue_type,
        'lat', round(o.venue_lat::numeric, 6), 'lon', round(o.venue_lon::numeric, 6),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'dishCount', o.n, 'dishes', o.dishes,
        -- The member's own things only; nothing for guests.
        'mine', case when v_uid is null then null else jsonb_build_object(
            'saved', exists (select 1 from public.saves sv where sv.owner_id = v_uid and sv.venue_id = o.venue_id),
            'lists', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title) order by l.title, l.id)
                                 from public.food_lists l join public.food_list_items li on li.list_id = l.id
                                where l.owner_id = v_uid and li.venue_id = o.venue_id), '[]'::jsonb),
            'recommendedBy', (select pk.reasons from picks pk where pk.venue_id = o.venue_id)) end)
        order by o.rn)
        from ordered o where o.rn <= v_limit), '[]'::jsonb),
    'truncated', (select count(*) from places) > v_limit,
    'counts', jsonb_build_object(
      'places', (select count(*) from places),
      'dishes', (select count(*) from shown),
      'placesMatches', (select count(distinct venue_id) from c where venue_id is not null and grp = 'match' and not not_comparable),
      'placesNeedsConfirmation', (select count(distinct venue_id) from c where venue_id is not null and grp = 'needs_confirmation' and not not_comparable),
      'dishesMatches', (select count(*) from c where venue_id is not null and grp = 'match' and not not_comparable),
      'dishesNeedsConfirmation', (select count(*) from c where venue_id is not null and grp = 'needs_confirmation' and not not_comparable),
      'hidden', (select count(*) from c where grp = 'hidden'),
      'notComparable', (select count(*) from c where not_comparable and grp <> 'hidden')),
    'applied', jsonb_build_object(
      'view', v_view, 'diet', coalesce(p->>'diet', 'none'),
      'area', case when v_has_point then 'radius' when p ? 'bbox' then 'box' else 'market' end,
      'radiusM', case when v_has_point then coalesce((p->>'radiusM')::integer, 5000) end,
      'market', coalesce(p->>'market', 'boston'))
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.search_map(jsonb) from public;
grant execute on function public.search_map(jsonb) to anon, authenticated;
