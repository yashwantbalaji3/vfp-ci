-- "Download my data" now includes everything a member owns (owner decision 5, 26 Nov 2026 19:36 UTC: members must be
-- able to export their own information). Before this, export_my_data() left out saved recipes, meals and restaurants,
-- test feedback, restaurant suggestions, corrections and place reports the member filed, and the member's own
-- restaurant-meal preview saves, reviews, list entries and plans, and their adults-only agreement (20261126000200). Each section lists only the member's own rows.
-- Nothing is read for anyone else; no table changes.
-- Rollback: drop function public.export_my_data(); alter function app.export_with_social() set schema public;
-- alter function public.export_with_social() rename to export_my_data; grant execute on it to authenticated.

alter function public.export_my_data() rename to export_with_social;
alter function public.export_with_social() set schema app;
revoke all on function app.export_with_social() from public, anon, authenticated;

create function public.export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return app.export_with_social() || jsonb_build_object(
    'agreement', (select jsonb_build_object('adultConfirmedAt', a.adult_confirmed_at, 'legalVersion', a.legal_version,
                 'legalAcceptedAt', a.legal_accepted_at) from public.member_agreements a where a.user_id = v_uid),
    'saves', coalesce((select jsonb_agg(jsonb_build_object(
                 'kind', case when s.venue_id is not null then 'restaurant' when fi.kind = 'recipe' then 'recipe' else 'food' end,
                 'name', coalesce(v.name, fr.name), 'savedAt', s.created_at) order by s.created_at)
               from public.saves s
               left join public.venues v on v.id = s.venue_id
               left join public.food_items fi on fi.id = s.food_item_id
               left join public.food_revisions fr on fr.id = fi.current_revision_id
              where s.owner_id = v_uid), '[]'::jsonb),
    'feedback', coalesce((select jsonb_agg(jsonb_build_object('form', b.form, 'answers', b.answers, 'sentAt', b.created_at) order by b.created_at)
               from public.beta_feedback b where b.user_id = v_uid), '[]'::jsonb),
    'suggestions', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'details', c.details, 'status', c.status,
                 'reviewNote', c.review_note, 'reviewedAt', c.reviewed_at, 'sentAt', c.created_at) order by c.created_at)
               from public.community_submissions c where c.user_id = v_uid), '[]'::jsonb),
    'corrections', coalesce((select jsonb_agg(jsonb_build_object('field', c.field, 'proposedValue', c.proposed_value,
                 'evidenceNote', c.evidence_note, 'state', c.state, 'decisionNote', c.decision_note, 'sentAt', c.created_at) order by c.created_at)
               from public.corrections c where c.reporter_id = v_uid), '[]'::jsonb),
    'placeReports', coalesce((select jsonb_agg(jsonb_build_object('reason', r.reason, 'note', r.note, 'resolution', r.resolution,
                 'sentAt', r.created_at) order by r.created_at)
               from public.place_reports r where r.reported_by = v_uid), '[]'::jsonb),
    'mealPreview', jsonb_build_object(
      'saves', coalesce((select jsonb_agg(jsonb_build_object('meal', d.label, 'savedAt', s.saved_at) order by s.saved_at)
                 from staging.preview_saves s join staging.dishes d on d.id = s.dish_id where s.user_id = v_uid), '[]'::jsonb),
      'reviews', coalesce((select jsonb_agg(jsonb_build_object('meal', d.label, 'rating', r.rating, 'text', r.body, 'visitDate', r.visit_date,
                   'createdAt', r.created_at, 'updatedAt', r.updated_at) order by r.created_at)
                 from staging.preview_reviews r join staging.dishes d on d.id = r.dish_id where r.user_id = v_uid), '[]'::jsonb),
      'listEntries', coalesce((select jsonb_agg(jsonb_build_object('listId', e.list_id, 'meal', d.label, 'addedAt', e.added_at) order by e.added_at)
                 from staging.preview_list_entries e join staging.dishes d on d.id = e.dish_id where e.user_id = v_uid), '[]'::jsonb),
      'plans', coalesce((select jsonb_agg(jsonb_build_object('meal', d.label, 'date', p.planned_date, 'mealSlot', p.meal_slot) order by p.planned_date)
                 from staging.preview_meal_plans p join staging.dishes d on d.id = p.dish_id where p.user_id = v_uid), '[]'::jsonb)));
end;
$$;
revoke all on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
