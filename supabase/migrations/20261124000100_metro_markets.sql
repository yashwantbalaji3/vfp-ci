-- Six metropolitan markets (owner directive 24 Nov 2026 07:19 UTC, part 5). Boston stays the lead market; New York
-- City, Chicago, Los Angeles, San Francisco and Dallas enter the same architecture as planned markets. Each market
-- gets a centre and a radius (about 25 miles, 40 234 m), and its coverage area becomes that circle.
--
-- Additive only: two nullable columns, five new rows, and Boston's centre filled in only where it is empty. No
-- market changes state (Boston keeps whatever state it has), no venue, listing or user row is touched, and nothing
-- becomes visible to anyone: the markets table was already readable, and no venue exists outside Boston.
--
-- Rollback: delete from public.markets where slug in ('new-york', 'chicago', 'los-angeles', 'san-francisco', 'dallas')
-- and not exists (select 1 from public.venues v where v.market_id = markets.id);
-- update public.markets set coverage_geometry = null where slug = 'boston';
-- alter table public.markets drop column radius_m, drop column center;

alter table public.markets
  add column if not exists center   extensions.geography(Point, 4326),
  add column if not exists radius_m integer check (radius_m is null or radius_m between 1000 and 200000);

comment on column public.markets.center is 'City centre used for the default map view and the radius below (docs/83).';
comment on column public.markets.radius_m is 'Radius of the market around its centre in metres; 40234 m is about 25 miles (docs/83).';

-- One statement: the five new markets are added; Boston, where it exists, only gets a centre, radius and area where those
-- are empty. Its name, time zone and state are left as they are.
with metro (slug, name, tz, lon, lat) as (
  values
    ('boston',        'Boston area',        'America/New_York',    -71.0589, 42.3601),
    ('new-york',      'New York City area', 'America/New_York',    -74.0060, 40.7128),
    ('chicago',       'Chicago area',       'America/Chicago',     -87.6298, 41.8781),
    ('los-angeles',   'Los Angeles area',   'America/Los_Angeles', -118.2437, 34.0522),
    ('san-francisco', 'San Francisco area', 'America/Los_Angeles', -122.4194, 37.7749),
    ('dallas',        'Dallas area',        'America/Chicago',     -96.7970, 32.7767)
), placed as (
  select m.*, extensions.st_setsrid(extensions.st_makepoint(m.lon, m.lat), 4326)::extensions.geography as pt from metro m
)
insert into public.markets (slug, name, country_code, default_timezone, state, center, radius_m, coverage_geometry)
select p.slug, p.name, 'US', p.tz, 'planned', p.pt, 40234,
       extensions.st_multi(extensions.st_buffer(p.pt, 40234)::extensions.geometry)::extensions.geography
  from placed p
 -- Boston is added by the seed on a fresh local database (with its fixed id); here it is only filled in when present.
 where p.slug <> 'boston' or exists (select 1 from public.markets b where b.slug = 'boston')
on conflict (slug) do update set
  center = coalesce(public.markets.center, excluded.center),
  radius_m = coalesce(public.markets.radius_m, excluded.radius_m),
  coverage_geometry = coalesce(public.markets.coverage_geometry, excluded.coverage_geometry);
