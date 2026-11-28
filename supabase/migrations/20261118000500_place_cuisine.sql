-- Cuisine or style of real places (CAT-CUISINE, docs/49 "Cuisine"). Owner 18 Nov 02:27 UTC, point 4: "Add cuisine
-- classification from the existing Overture data. Distinguish explicitly sourced categories from inferred or
-- uncertain cuisines, and do not misclassify restaurants."
--
-- * catalog_import.overture_taxonomy holds Overture's own taxonomy (primary category, alternates) for each Overture
--   record, from the same public release and licence as the identity import. It is in the closed import schema.
-- * public.place_listings.cuisines is written only by the build step (scripts/lib/cuisine.mjs): each entry has the
--   cuisine, its basis ('dataset_primary': Overture's primary category; 'dataset_alternate': only among Overture's
--   alternates, shown as "possibly") and the Overture category it came from. No name, website or menu is read.
-- * Diet words in a category (vegetarian, vegan, halal …) are never a cuisine and never a dietary claim.
-- * The directory filters on primary-category cuisines; "possibly" matches only when the visitor asks for them.
-- Identity only: nothing here touches menus, diets, allergens or nutrition.

create table catalog_import.overture_taxonomy (
  external_id      text primary key check (length(external_id) between 1 and 200),
  release          text not null check (length(release) between 1 and 40),
  primary_category text check (length(primary_category) <= 100),
  alternates       text[] not null default '{}' check (cardinality(alternates) <= 20),
  loaded_at        timestamptz not null default now()
);
alter table catalog_import.overture_taxonomy enable row level security;
alter table catalog_import.overture_taxonomy force row level security;
revoke all on catalog_import.overture_taxonomy from public, anon, authenticated;

alter table public.place_listings add column cuisines jsonb not null default '[]'::jsonb
  check (jsonb_typeof(cuisines) = 'array' and jsonb_array_length(cuisines) <= 4);

create or replace function public.place_directory(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_market text := coalesce(p->>'market', 'boston');
  v_preview boolean := coalesce((p->>'preview')::boolean, false) and (app.has_role('publisher') or app.has_role('admin'));
  v_map boolean := coalesce(p->>'mode', 'list') = 'map';
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_area text := nullif(btrim(coalesce(p->>'area', '')), '');
  v_kind text := nullif(btrim(coalesce(p->>'kind', '')), '');
  v_checked boolean := coalesce((p->>'checked')::boolean, false);
  v_cuisine text := nullif(btrim(coalesce(p->>'cuisine', '')), '');
  v_possible boolean := coalesce((p->>'possible')::boolean, false);
  v_key text := app.search_key(p->>'q');
  v_lat double precision := round(((p->>'lat')::numeric), 3);
  v_lon double precision := round(((p->>'lon')::numeric), 3);
  v_radius integer := (p->>'radiusM')::integer;
  v_w double precision := (p->>'west')::double precision;
  v_s double precision := (p->>'south')::double precision;
  v_e double precision := (p->>'east')::double precision;
  v_n double precision := (p->>'north')::double precision;
  v_limit integer := coalesce((p->>'limit')::integer, case when coalesce(p->>'mode', 'list') = 'map' then 500 else 24 end);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 or length(coalesce(v_area, '')) > 120 or length(coalesce(v_kind, '')) > 40 or length(coalesce(v_cuisine, '')) > 40 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > (case when v_map then 500 else 50 end) then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  if (v_lat is null) <> (v_lon is null) then raise exception 'INVALID_POINT' using errcode = 'PT422'; end if;
  if v_radius is not null and (v_lat is null or v_radius not between 100 and 50000) then raise exception 'INVALID_RADIUS' using errcode = 'PT422'; end if;
  if num_nulls(v_w, v_s, v_e, v_n) not in (0, 4) or (v_w is not null and (v_w >= v_e or v_s >= v_n or v_e - v_w > 2 or v_n - v_s > 2)) then
    raise exception 'INVALID_BOX' using errcode = 'PT422';
  end if;

  with seen as (
    select l.* from public.place_listings l
     where l.market_slug = v_market and app.place_visible(l, v_preview)
  ), hit as (
    select s.*,
           case when v_lat is not null then 2 * 6371000 * asin(sqrt(power(sin(radians(s.lat - v_lat) / 2), 2)
             + cos(radians(v_lat)) * cos(radians(s.lat)) * power(sin(radians(s.lon - v_lon) / 2), 2))) end as distance_m
      from seen s
     where (v_key is null or strpos(app.search_key(s.name), v_key) > 0 or strpos(coalesce(app.search_key(s.street), ''), v_key) > 0)
       and (v_area is null or s.area = v_area)
       and (v_kind is null or s.category = v_kind)
       and (not v_checked or s.identity_status = 'verified')
       and (v_cuisine is null or exists (select 1 from jsonb_array_elements(s.cuisines) c
                                         where c->>'cuisine' = v_cuisine and (c->>'basis' = 'dataset_primary' or v_possible)))
       and (v_w is null or (s.lon between v_w and v_e and s.lat between v_s and v_n))
  ), near as (
    select h.* from hit h where v_radius is null or h.distance_m <= v_radius
  ), ordered as (
    select h.*, row_number() over (order by h.distance_m asc nulls last, h.name, h.id) as rn from near h
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(case when v_map then jsonb_build_object(
        'id', o.id, 'slug', o.slug, 'name', o.name, 'street', o.street, 'category', o.category, 'area', o.area,
        'lat', round(o.lat::numeric, 5), 'lon', round(o.lon::numeric, 5),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'identityBasis', app.identity_basis(o.identity_status, o.publication_batch))
      else jsonb_build_object(
        'id', o.id, 'slug', o.slug, 'name', o.name, 'street', o.street, 'locality', o.locality, 'postcode', o.postcode,
        'area', o.area, 'category', o.category, 'lat', round(o.lat::numeric, 5), 'lon', round(o.lon::numeric, 5),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'identityStatus', o.identity_status, 'identityBasis', app.identity_basis(o.identity_status, o.publication_batch),
        'menuStatus', o.menu_status, 'visibility', o.visibility,
        'cuisines', (select coalesce(jsonb_agg(jsonb_build_object('cuisine', c->>'cuisine', 'basis', c->>'basis')), '[]'::jsonb) from jsonb_array_elements(o.cuisines) c),
        'reported', exists (select 1 from public.place_reports r where r.listing_id = o.id and r.resolved_at is null),
        'sources', (select coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'attribution', s->>'attribution')), '[]'::jsonb) from jsonb_array_elements(o.sources) s)
      ) end order by o.rn) from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (select count(*) from near),
    'nextOffset', case when (select count(*) from near) > v_offset + v_limit then v_offset + v_limit end,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('area', a.area, 'count', a.n) order by a.n desc, a.area)
                         from (select s.area, count(*) n from seen s where s.area is not null group by s.area) a), '[]'::jsonb),
    'kinds', coalesce((select jsonb_agg(jsonb_build_object('kind', k.category, 'count', k.n) order by k.n desc, k.category)
                         from (select s.category, count(*) n from seen s group by s.category) k), '[]'::jsonb),
    'checked', (select count(*) from seen s where s.identity_status = 'verified'),
    -- Cuisine counts use Overture's primary category only; "possibly" never inflates a count.
    'cuisines', coalesce((select jsonb_agg(jsonb_build_object('cuisine', x.cuisine, 'count', x.n) order by x.n desc, x.cuisine)
                            from (select c->>'cuisine' as cuisine, count(*) n from seen s, jsonb_array_elements(s.cuisines) c
                                   where c->>'basis' = 'dataset_primary' group by 1) x), '[]'::jsonb),
    'preview', v_preview
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.place_directory(jsonb) from public;
grant execute on function public.place_directory(jsonb) to anon, authenticated;

create or replace function public.place_detail(p_slug text, p_preview boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare l public.place_listings; v_batch jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9-]{2,120}$' then return null; end if;
  select * into l from public.place_listings where slug = p_slug;
  if not found or not app.place_visible(l, p_preview) then return null; end if;
  if l.publication_batch is not null and app.identity_basis(l.identity_status, l.publication_batch) = 'batch_sampled' then
    select jsonb_build_object('name', b.name, 'sampleSize', a.sample_size, 'problems', a.problems, 'upperBound', a.upper_bound, 'approvedAt', a.decided_at)
      into v_batch
      from public.publication_batches b
      join lateral (select * from public.batch_approvals x where x.batch_id = b.id order by x.decided_at desc, x.id desc limit 1) a on true
     where b.id = l.publication_batch;
  end if;
  return jsonb_build_object(
    'id', l.id, 'slug', l.slug, 'name', l.name, 'street', l.street, 'locality', l.locality, 'postcode', l.postcode, 'area', l.area,
    'category', l.category, 'lat', round(l.lat::numeric, 5), 'lon', round(l.lon::numeric, 5),
    'identityStatus', l.identity_status, 'identityBasis', app.identity_basis(l.identity_status, l.publication_batch),
    'menuStatus', l.menu_status, 'visibility', l.visibility, 'updatedAt', l.updated_at,
    'cuisines', (select coalesce(jsonb_agg(jsonb_build_object('cuisine', c->>'cuisine', 'basis', c->>'basis', 'category', c->>'category')), '[]'::jsonb) from jsonb_array_elements(l.cuisines) c),
    'batch', v_batch,
    'reported', exists (select 1 from public.place_reports r where r.listing_id = l.id and r.resolved_at is null),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'attribution', s->>'attribution', 'release', s->>'release')), '[]'::jsonb) from jsonb_array_elements(l.sources) s)
  );
end $$;
revoke all on function public.place_detail(text, boolean) from public;
grant execute on function public.place_detail(text, boolean) to anon, authenticated;

-- Rollback (local database): restore public.place_directory from 20261118000300 and public.place_detail from
-- 20261117000500, then drop public.place_listings.cuisines and catalog_import.overture_taxonomy.
