-- The Boston market on a clean database (found in the hosted rehearsal, 25 Nov 2026). Until now the Boston row came
-- only from supabase/seed.sql, which never runs on a hosted database (docs/79 section 2). Without it every Boston
-- listing is refused ("LISTING_OUTSIDE_MARKET"), so the directory could not be built on the hosted beta.
--
-- Additive only: the row is added only where no Boston market exists, with the same id, centre, 25-mile radius and
-- area the seed and migration 20261124000100 give it. A database that already has Boston (every local copy, the
-- owner's Mac included) changes nothing. The seed now skips its own Boston row when this one is there. Nothing becomes
-- visible to anyone: a market row is not a listing.
--
-- Rollback (only on a database with no listing or venue in Boston): delete from public.markets where slug = 'boston'.
insert into public.markets (id, slug, name, country_code, default_timezone, state, center, radius_m, coverage_geometry)
select '00000000-0000-4000-8000-00000000a001', 'boston', 'Boston area', 'US', 'America/New_York', 'planned',
       extensions.st_setsrid(extensions.st_makepoint(-71.0589, 42.3601), 4326)::extensions.geography, 40234,
       extensions.st_multi(extensions.st_buffer(extensions.st_setsrid(extensions.st_makepoint(-71.0589, 42.3601), 4326)::extensions.geography, 40234)::extensions.geometry)::extensions.geography
 where not exists (select 1 from public.markets where slug = 'boston');
