-- Two more areas for the Tier B menu pilot (18 Nov 2026): Base Crave on Huron Ave (West Cambridge)
-- and Brown Sugar Cafe on Commonwealth Ave (Allston-Brighton). Same function, two names added.
create or replace function staging.area_city(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_area in ('central_square', 'harvard_square', 'kendall_square', 'inman_square', 'porter_square', 'west_cambridge') then 'Cambridge'
    when p_area in ('back_bay', 'fenway_kenmore', 'south_end', 'downtown', 'chinatown', 'beacon_hill', 'longwood', 'mission_hill', 'allston_brighton') then 'Boston'
  end;
$$;

-- Rollback: re-run staging.area_city from 20261118001200 (only if no staged place uses the two new areas).
