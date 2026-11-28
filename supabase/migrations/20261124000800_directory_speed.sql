-- Directory speed with six markets loaded (24 Nov 2026). With about 12,900 Boston listings (was 1,242) the directory
-- took 2 seconds for a visitor and 4 for the founder, because app.place_visible was called on every row. The rule is
-- unchanged: rows are first narrowed by cheap tests that can only drop rows app.place_visible would refuse, and a
-- founder's preview rows skip the per-row call (the role is checked once, at the top). Same results, same shape.
--
-- Rollback: restore public.place_directory from 20261118000500_place_cuisine.sql.

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
  v_beta boolean := staging.member_beta_on();
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
    -- The visibility rule is still app.place_visible. The cheap tests in front of it only skip rows it would refuse
    -- anyway, and a founder's preview row (v_preview already checked the role) needs no per-row call.
    select l.* from public.place_listings l
     where l.market_slug = v_market
       and l.visibility in ('public', 'preview')
       and (l.visibility = 'public' or v_preview
            or (v_beta and exists (select 1 from staging.live_catalog_links k join staging.member_beta_places b on b.place_id = k.staging_place
                                    where k.candidate_id = l.candidate_id)))
       and (case when v_preview and l.visibility = 'preview' then true else app.place_visible(l, v_preview) end)
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
