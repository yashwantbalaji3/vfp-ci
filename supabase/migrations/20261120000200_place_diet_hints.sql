-- Place-level vegetarian/vegan hints from Overture Maps' own category (owner 20 Nov 2026 21:20 UTC, item 5; docs/64):
-- "Open-map vegetarian categories may appear only as attributed place-level hints, never as verified dish-level claims."
--
-- Nothing is stored on public.place_listings and public.place_detail is unchanged: a listing still holds no
-- dietary field and a visitor's place page can never carry one. The hint is read, only for the founder, from the
-- closed taxonomy table (catalog_import.overture_taxonomy) through public.menu_preview_index, as
-- {hint: vegetarian|vegan, basis: dataset_primary|dataset_alternate, category}. No diet check, count or filter reads it.
-- Additive: one private helper, and menu_preview_index replaced with one extra key.

create function staging.place_diet_hints(p_candidate uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (
    select x.primary_category, x.alternates
      from catalog_import.candidate_links cl
      join catalog_import.source_records r on r.id = cl.record_id and r.source_key = 'overture_places'
      join catalog_import.overture_taxonomy x on x.external_id = r.external_id
     where cl.candidate_id = p_candidate
     order by r.external_id
     limit 1
  ), h as (
    select c.category, case when c.ord = 0 then 'dataset_primary' else 'dataset_alternate' end as basis, c.ord
      from t, lateral (select t.primary_category as category, 0 as ord
                       union all select a, n from unnest(t.alternates) with ordinality as u(a, n)) c
     where c.category in ('vegetarian_restaurant', 'vegan_restaurant')
  ), firsts as (
    select distinct on (category) category, basis, ord from h order by category, ord
  )
  select coalesce(jsonb_agg(jsonb_build_object('hint', case category when 'vegan_restaurant' then 'vegan' else 'vegetarian' end,
                                               'basis', basis, 'category', category) order by ord), '[]'::jsonb)
    from firsts;
$$;
revoke all on function staging.place_diet_hints(uuid) from public, anon, authenticated;

create or replace function public.menu_preview_index()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'placeId', p.id, 'label', p.label,
             'listingId', pl.id, 'slug', pl.slug, 'name', pl.name, 'street', pl.street, 'area', pl.area,
             'lat', pl.lat, 'lon', pl.lon, 'cuisines', pl.cuisines, 'dietHints', staging.place_diet_hints(pl.candidate_id),
             'linkMethod', k.method, 'linkedAt', k.at)
           order by pl.name)
      from staging.live_catalog_links k
      join staging.places p on p.id = k.staging_place
      join public.place_listings pl on pl.candidate_id = k.candidate_id
     where not exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id
                        where f.place_id = p.id and s.is_demo)), '[]'::jsonb);
end;
$$;
revoke all on function public.menu_preview_index() from public, anon;
grant execute on function public.menu_preview_index() to authenticated;

-- Rollback (local database): restore public.menu_preview_index from 20261119000100, then
-- drop function staging.place_diet_hints(uuid).
