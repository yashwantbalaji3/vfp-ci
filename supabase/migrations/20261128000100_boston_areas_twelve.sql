-- Boston areas, refined for the owner's twelve-area Boston charter (28 Nov 2026 00:32 UTC, section 3).
-- Adds nothing and removes nothing: it replaces app.boston_area() (migration 20261127000100) so that
--   * Longwood joins Mission Hill ('Mission Hill / Longwood': 02120, and 02115 west of about 71.098° W),
--   * Kenmore and the Fens read 'Fenway / Kenmore' (02215 east of the Allston line) and 'Fenway / Northeastern' (02115 east).
-- Every other label is unchanged. The place_listings_area trigger uses the new rule for new or moved rows; existing
-- rows change only when `node scripts/boston-areas.mjs --apply` is run (local only, area column only).
-- The JS mirror is scripts/lib/boston-areas.mjs; tests/db/boston-neighbourhoods.test.ts keeps the two in step.
--
-- Rollback (exact): re-run the create-or-replace of app.boston_area from 20261127000100_boston_neighbourhoods.sql,
-- then `node scripts/boston-areas.mjs --apply` to put the earlier labels back.

create or replace function app.boston_area(p_postcode text, p_locality text, p_lon double precision)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    -- 02215 runs from Kenmore out to the Allston line; west of St. Paul Street (about 71.112° W) is Allston.
    when p_postcode = '02215' and p_lon is not null and p_lon < -71.112 then 'Allston / Brighton'
    when p_postcode = '02215' then 'Fenway / Kenmore'
    when p_postcode in ('02116', '02199') then 'Back Bay / Prudential'
    -- 02115 runs from the Fens and Northeastern out to the Longwood Medical Area; west of about 71.098° W is Longwood.
    when p_postcode = '02115' and p_lon is not null and p_lon < -71.098 then 'Mission Hill / Longwood'
    when p_postcode = '02115' then 'Fenway / Northeastern'
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
    when p_postcode = '02120' then 'Mission Hill / Longwood'
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
