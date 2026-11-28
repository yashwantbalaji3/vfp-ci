-- Directory filters (owner 18 Nov 01:06 UTC, point 4: search, filtering): forgiving search that ignores
-- case, accents, apostrophes and punctuation ("Felipes" finds "Felipe's", "cafe" finds "Café"), a
-- filter by kind of place (the listing's own category), and a filter for places whose identity the
-- founder has checked. Identity only: nothing here reads or implies a menu, a diet or nutrition.
-- The visibility rule is unchanged (app.place_visible).

-- Lower case, accents folded, apostrophes dropped, any other punctuation a single space.
create function app.search_key(t text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select nullif(btrim(regexp_replace(
           translate(lower(coalesce(t, '')), 'áàâäãåāéèêëēíìîïīóòôöõøōúùûüūñçß’‘`''', 'aaaaaaaeeeeeiiiiiooooooouuuuuncs'),
           '[^a-z0-9]+', ' ', 'g')), '');
$$;
revoke all on function app.search_key(text) from public, anon, authenticated;

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
  if length(coalesce(v_q, '')) > 120 or length(coalesce(v_area, '')) > 120 or length(coalesce(v_kind, '')) > 40 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
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
    'preview', v_preview
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.place_directory(jsonb) from public;
grant execute on function public.place_directory(jsonb) to anon, authenticated;
