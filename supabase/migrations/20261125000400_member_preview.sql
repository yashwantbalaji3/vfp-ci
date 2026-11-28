-- Founder-only, read-only preview of what an invited member would see (owner direction 25 Nov 2026 17:10 UTC).
--
-- public.member_preview_meal(p_dish) returns the same shape as public.member_beta_place for one meal, built with the
-- same member rule (staging.member_fact_ok: facts found on the saved page or verified, from a private-pilot or cleared
-- source, never demo), but WITHOUT the switch, enrolment and inclusion gates, so the founder can see the member view
-- before any gate passes. It also returns each gate and whether a member would see the meal right now. It writes
-- nothing, publishes nothing, and only the founder can call it.
--
-- Rollback: drop function public.member_preview_meal(uuid).

create function public.member_preview_meal(p_dish uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d staging.dishes;
  p staging.places;
  c jsonb;
begin
  perform app.require_founder();
  select * into d from staging.dishes where id = p_dish;
  if d.id is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  select * into p from staging.places where id = d.place_id;
  c := staging.tester_meal_checks(d.id);
  return jsonb_build_object(
    'gates', jsonb_build_object(
      'evidence', staging.tester_meal_all_pass(c || '{"place": true, "reviewed": true}'::jsonb),
      'enrolled', exists (select 1 from staging.member_beta_places b where b.place_id = p.id),
      'reviewed', coalesce((c ->> 'reviewed')::boolean, false),
      'included', staging.tester_meal_included(d.id),
      'switchOn', staging.member_beta_on(),
      'visibleNow', staging.member_dish_ok(d.id),
      'checks', c),
    'place', jsonb_build_object(
      'placeId', p.id, 'label', p.label, 'area', p.area, 'city', p.city,
      'sources', coalesce((
        select jsonb_agg(jsonb_build_object('sourceId', s.id, 'url', s.url, 'host', staging.url_host(s.url), 'kind', s.page_kind,
                                            'publisher', s.publisher, 'retrievedAt', s.retrieved_at,
                                            'access', staging.source_access_state(s.url)) order by s.retrieved_at, s.url)
          from staging.source_pages s
         where s.id in (select f.source_page_id from staging.facts f
                         where (f.dish_id = d.id or (f.place_id = p.id and f.dish_id is null)) and staging.member_fact_ok(f))), '[]'::jsonb),
      'placeFacts', coalesce((
        select jsonb_agg(public.menu_review_fact_json(f, f.entered_by) order by f.kind, f.entered_at)
          from staging.facts f where f.place_id = p.id and f.dish_id is null and staging.member_fact_ok(f)), '[]'::jsonb),
      'dishes', jsonb_build_array(jsonb_build_object(
        'dishId', d.id, 'label', d.label,
        'structure', (select case when st.id is null then null else jsonb_build_object(
                          'type', st.dish_type, 'parentDishId', st.parent_dish_id, 'section', st.section,
                          'portion', st.portion_label, 'basis', st.basis, 'evidence', st.evidence) end
                        from staging.current_structure(d.id) st),
        -- Options that point at another dish are left out: in the member beta each meal is gated on its own.
        'options', coalesce((select jsonb_agg(jsonb_build_object('kind', o.option_kind, 'label', o.label,
                                                                 'componentDishId', o.component_dish_id,
                                                                 'priceDeltaUsd', o.price_delta_usd, 'sourceId', o.source_page_id)
                                              order by o.option_kind, o.label)
                               from staging.dish_options o where o.dish_id = d.id and o.component_dish_id is null), '[]'::jsonb),
        'estimate', staging.estimate_json(d.id),
        'facts', coalesce((select jsonb_agg(public.menu_review_fact_json(f, f.entered_by) order by f.kind, f.subject nulls first, f.entered_at)
                             from staging.facts f where f.dish_id = d.id and staging.member_fact_ok(f)), '[]'::jsonb),
        'corrections', '[]'::jsonb))));
end;
$$;
revoke all on function public.member_preview_meal(uuid) from public, anon;
grant execute on function public.member_preview_meal(uuid) to authenticated;
