-- Two more staging areas for the Group A research (owner decision 28 Nov 2026 04:49 UTC): Madras Dosa Co at
-- 55 Boston Wharf Rd (Seaport, charter area "South Boston & Seaport") and Dirty Water Dough at 20 Maverick St
-- (charter area "East Boston & Charlestown"). Same function, two names added; add-only, no data changes.
create or replace function staging.area_city(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_area in ('central_square', 'harvard_square', 'kendall_square', 'inman_square', 'porter_square', 'west_cambridge') then 'Cambridge'
    when p_area in ('back_bay', 'fenway_kenmore', 'south_end', 'downtown', 'chinatown', 'beacon_hill', 'longwood', 'mission_hill', 'allston_brighton',
                    'seaport', 'east_boston') then 'Boston'
  end;
$$;

-- Rollback: re-run staging.area_city from 20261118001300 (only if no staged place uses 'seaport' or 'east_boston').
