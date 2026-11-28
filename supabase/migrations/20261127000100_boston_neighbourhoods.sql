-- One neighbourhood definition for every Boston-area listing (owner directive 27 Nov 2026 06:04 UTC, Boston first).
--
-- Before this, a listing had an area only when its postcode was in one of six "focus" areas, so most Boston-area
-- listings (Allston, Brighton, Brookline, Somerville, East Boston and more) had none and could not be browsed by
-- neighbourhood. This adds app.boston_area(), the only place the answer is decided, and a trigger that applies it to
-- every Boston-market listing on insert and update. It changes no existing row: listings already in a database get
-- their area from `node scripts/boston-areas.mjs --apply` (a separate, checked step that rewrites only the area), or
-- from the next listing rebuild.
--
-- The answer comes from the listing's own address: its postcode, then (for postcode 02215, which runs from Kenmore
-- out to Allston) its longitude, then its town name. Postcodes follow neighbourhood lines only roughly, so an area is
-- an address-based shortcut for browsing, never a claim about the place. The six earlier labels are kept exactly.
-- scripts/lib/boston-areas.mjs holds the same table for the importer; tests/db/boston-neighbourhoods.test.ts keeps the
-- two in step.
--
-- Adds only. Changes no decision, review, fact, visibility or switch.
--
-- Rollback (exact; after scripts/boston-areas.mjs --apply, the update restores the earlier six-area rule):
--   drop trigger if exists place_listings_area on public.place_listings;
--   update public.place_listings set area = case
--       when postcode = '02215' then 'Fenway / Kenmore / Longwood'
--       when postcode in ('02116', '02199') then 'Back Bay / Prudential'
--       when postcode = '02115' then 'Fenway / Northeastern / Mission Hill'
--       when postcode = '02118' then 'South End'
--       when postcode in ('02108', '02109', '02110', '02111') then 'Downtown / Financial District / Chinatown'
--       when postcode in ('02138', '02139', '02142') then 'Cambridge (Central, Harvard, Kendall)'
--       else null end
--     where market_slug = 'boston';
--   drop function if exists app.place_listing_area(); drop function if exists app.boston_area(text, text, double precision);

create or replace function app.boston_area(p_postcode text, p_locality text, p_lon double precision)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    -- 02215 runs from Kenmore out to the Allston line; west of St. Paul Street (about 71.112° W) is Allston.
    when p_postcode = '02215' and p_lon is not null and p_lon < -71.112 then 'Allston / Brighton'
    when p_postcode = '02215' then 'Fenway / Kenmore / Longwood'
    when p_postcode in ('02116', '02199') then 'Back Bay / Prudential'
    when p_postcode = '02115' then 'Fenway / Northeastern / Mission Hill'
    when p_postcode = '02118' then 'South End'
    when p_postcode in ('02108', '02109', '02110', '02111', '02201', '02203', '02205') then 'Downtown / Financial District / Chinatown'
    when p_postcode in ('02138', '02139', '02142') then 'Cambridge (Central, Harvard, Kendall)'
    when p_postcode in ('02140', '02141') then 'Cambridge (Porter, Inman, East Cambridge)'
    when p_postcode in ('02134', '02135', '02163') then 'Allston / Brighton'
    when p_postcode in ('02445', '02446', '02447') then 'Brookline'
    when p_postcode = '02113' then 'North End'
    when p_postcode = '02114' then 'Beacon Hill / West End'
    when p_postcode in ('02127', '02210') then 'South Boston / Seaport'
    when p_postcode = '02128' then 'East Boston'
    when p_postcode = '02129' then 'Charlestown'
    when p_postcode = '02130' then 'Jamaica Plain'
    when p_postcode = '02120' then 'Mission Hill'
    when p_postcode = '02119' then 'Roxbury'
    when p_postcode in ('02121', '02122', '02124', '02125') then 'Dorchester'
    when p_postcode = '02126' then 'Mattapan'
    when p_postcode = '02131' then 'Roslindale'
    when p_postcode = '02132' then 'West Roxbury'
    when p_postcode = '02136' then 'Hyde Park'
    when p_postcode in ('02143', '02144', '02145') then 'Somerville'
    -- Elsewhere, the town the address names (never "Boston" on its own: that says nothing about where).
    when lower(btrim(p_locality)) like 'newton%' then 'Newton'
    when lower(btrim(p_locality)) = 'brookline' then 'Brookline'
    when lower(btrim(p_locality)) in ('allston', 'brighton') then 'Allston / Brighton'
    when nullif(btrim(p_locality), '') is not null and lower(btrim(p_locality)) <> 'boston' then initcap(btrim(p_locality))
    else null
  end
$$;

create or replace function app.place_listing_area()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.market_slug = 'boston' then
    new.area := app.boston_area(new.postcode, new.locality, new.lon);
  end if;
  return new;
end $$;

drop trigger if exists place_listings_area on public.place_listings;
create trigger place_listings_area
  before insert or update of postcode, locality, lon, area, market_slug on public.place_listings
  for each row execute function app.place_listing_area();

revoke all on function app.boston_area(text, text, double precision) from public, anon, authenticated;
revoke all on function app.place_listing_area() from public, anon, authenticated;
