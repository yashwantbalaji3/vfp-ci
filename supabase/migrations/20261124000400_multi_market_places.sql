-- Six-city place import (owner directive 24 Nov 2026 14:59 UTC, priority 3A; docs/84). Imported place records and
-- the private place listings had coordinate checks drawn round Boston only (latitude 42.2-42.5, longitude -71.3 to
-- -70.9), so no other city's open data could be loaded. The checks now allow the contiguous United States; which
-- market a place belongs to is decided by its position against public.markets (the importer keeps only places
-- inside the chosen market's 25-mile area, and each listing records its market).
--
-- Only check constraints change: no row is added, changed or removed, and every existing row already satisfies the
-- wider checks. Nothing becomes visible to anyone.
--
-- Rollback (only while no row lies outside Boston): drop the four *_us_check constraints and add back
--   check (lat between 42.2 and 42.5) and check (lon between -71.3 and -70.9) on both tables.

alter table catalog_import.source_records drop constraint source_records_lat_check;
alter table catalog_import.source_records drop constraint source_records_lon_check;
alter table catalog_import.source_records add constraint source_records_lat_us_check check (lat between 24.0 and 50.0);
alter table catalog_import.source_records add constraint source_records_lon_us_check check (lon between -125.0 and -66.0);

alter table public.place_listings drop constraint place_listings_lat_check;
alter table public.place_listings drop constraint place_listings_lon_check;
alter table public.place_listings add constraint place_listings_lat_us_check check (lat between 24.0 and 50.0);
alter table public.place_listings add constraint place_listings_lon_us_check check (lon between -125.0 and -66.0);

-- A listing's market must be one of the markets, and its position must be inside that market's area.
create function app.listing_in_market(p_market text, p_lat double precision, p_lon double precision)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.markets m
                  where m.slug = p_market
                    and (m.coverage_geometry is null
                         or extensions.st_covers(m.coverage_geometry,
                              extensions.st_setsrid(extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography)));
$$;
revoke all on function app.listing_in_market(text, double precision, double precision) from public, anon, authenticated;

create function app.guard_listing_market()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not app.listing_in_market(new.market_slug, new.lat, new.lon) then
    raise exception 'LISTING_OUTSIDE_MARKET: % is not inside the % area', new.name, new.market_slug using errcode = 'PT422';
  end if;
  return new;
end $$;
revoke all on function app.guard_listing_market() from public, anon, authenticated;
create trigger place_listings_market_guard before insert or update of market_slug, lat, lon on public.place_listings
  for each row execute function app.guard_listing_market();
