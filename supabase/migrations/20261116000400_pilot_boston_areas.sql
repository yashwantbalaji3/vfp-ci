-- Pilot staging (LOCAL ONLY): allow places in Boston neighbourhoods as well as the two Cambridge
-- squares. Nothing here verifies or publishes anything. Each area belongs to exactly one city, and
-- the city now follows from the area (it was always 'Cambridge' before), so a Boston place can never
-- be staged as a Cambridge one by mistake. Existing rows are unchanged: they are all Cambridge.

create function staging.area_city(p_area text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_area in ('central_square', 'harvard_square') then 'Cambridge'
    when p_area in ('back_bay', 'fenway_kenmore', 'south_end', 'downtown', 'chinatown', 'beacon_hill', 'longwood') then 'Boston'
  end;
$$;

alter table staging.places drop constraint places_area_check;
alter table staging.places add constraint places_area_check check (staging.area_city(area) is not null);
alter table staging.places add constraint places_city_matches_area check (city = staging.area_city(area));

-- Same signature and checks as before; the only change is that the city comes from the area.
create or replace function staging.add_place(p_actor uuid, p_label text, p_area text, p_priority smallint)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform staging.require_role(p_actor, 'curator');
  if staging.area_city(p_area) is null then
    raise exception 'STAGING_AREA_UNKNOWN' using errcode = 'PT400', detail = p_area;
  end if;
  insert into staging.places (label, area, city, shortlist_priority, created_by)
  values (p_label, p_area, staging.area_city(p_area), p_priority, p_actor) returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail) values (p_actor, 'add_place', v_id, jsonb_build_object('label', p_label));
  return v_id;
end;
$$;

revoke all on function staging.area_city(text) from public, anon, authenticated;
