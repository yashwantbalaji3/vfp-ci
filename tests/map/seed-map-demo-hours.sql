-- MAP-2: invented opening hours for demo places (LOCAL ONLY, is_demo places only).
-- Run with -v slug_like='map-demo-%' (the 58 map demo places, scripts/map-demo.mjs) or
-- -v slug_like='%-scale-%' (the scale places, scripts/scale-test.mjs seed).
-- Adds hours only to places that have none, so running it again changes nothing.
-- Every fourth place gets none, so "Hours need confirmation" appears on the map too.
-- The patterns match pg_temp.demo_hours in supabase/seed.sql.
create function pg_temp.demo_hours(p_pattern text) returns jsonb language sql immutable as $$
  select case p_pattern
    when 'all_day' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', case when d = 0 then '12:00' else '11:00' end,
                                           'closes', case when d = 0 then '21:00' else '22:00' end)) from generate_series(0, 6) d))
    when 'split' then jsonb_build_object('weekly',
      (select jsonb_agg(x) from generate_series(0, 6) d,
              lateral (values (jsonb_build_object('day', d, 'opens', '11:30', 'closes', '14:30')),
                              (jsonb_build_object('day', d, 'opens', '17:00', 'closes', '22:00'))) v(x) where d <> 1))
    when 'late' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', '17:00', 'closes', '02:00', 'closesNextDay', true)) from generate_series(0, 6) d))
    when 'breakfast' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', '07:00', 'closes', '15:00')) from generate_series(0, 6) d))
    when 'always' then jsonb_build_object('weekly',
      (select jsonb_agg(jsonb_build_object('day', d, 'opens', '00:00', 'closes', '00:00', 'closesNextDay', true)) from generate_series(0, 6) d))
  end;
$$;
select count(*) as demo_places_given_hours from (
  select app.publish_hours(v.id, pg_temp.demo_hours((array['all_day', 'split', 'late', 'breakfast', 'always'])[1 + (v.rn % 5)]),
                           '00000000-0000-4000-8000-00000000b201', null, null, null)
    from (select v.id, row_number() over (order by v.slug) as rn from public.venues v
           where v.slug like :'slug_like' and v.is_demo) v
   where v.rn % 4 <> 0
     and not exists (select 1 from public.venue_hours_sets s where s.venue_id = v.id)
) x;
