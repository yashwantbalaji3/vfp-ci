-- Founder review of staged facts (owner decision 2026-11-15 23:52 UTC: the owner is the only
-- publisher/verifier in the pilot; plan docs/27 A). Read-only view of everything waiting for review,
-- with its evidence, for the LOCAL review tool (scripts/pilot-review.mjs). Still closed to visitors
-- and members: no grant is added, and verifying still goes through staging.review_fact, which keeps
-- the two-person rule and the permanent history.

create function staging.review_queue()
returns table (
  fact_id          uuid,
  place_id         uuid,
  place_label      text,
  area             text,
  shortlist_priority smallint,
  dish_id          uuid,
  dish_label       text,
  kind             text,
  subject          text,
  value            jsonb,
  is_unknown       boolean,
  unknown_reason   text,
  -- For protein and other nutrition facts: which of the four nutrition states this fact supports.
  nutrition_state  text,
  source_url       text,
  source_kind      text,
  source_publisher text,
  source_retrieved_at timestamptz,
  source_terms_note text,
  checked_on       date,
  entered_by       uuid,
  entered_by_email text,
  entered_at       timestamptz,
  replaces_value   jsonb,
  replaces_unknown boolean,
  current_verified jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, p.id, p.label, p.area, p.shortlist_priority, d.id, d.label, f.kind, f.subject, f.value, f.is_unknown, f.unknown_reason,
         case when f.kind = 'published_nutrition' then case when f.is_unknown then 'unknown' else 'restaurant_published' end end,
         s.url, s.page_kind, s.publisher, s.retrieved_at, s.terms_note, f.checked_on,
         f.entered_by, u.email::text, f.entered_at,
         o.value, o.is_unknown,
         -- What is verified today for the same place/dish/kind/subject, so the reviewer sees the change.
         (select jsonb_agg(jsonb_build_object('value', v.value, 'unknown', v.is_unknown, 'reviewedAt', v.reviewed_at) order by v.reviewed_at desc)
            from staging.facts v
           where v.place_id = f.place_id and v.dish_id is not distinct from f.dish_id and v.kind = f.kind
             and v.subject is not distinct from f.subject and v.status = 'verified')
    from staging.facts f
    join staging.places p on p.id = f.place_id
    left join staging.dishes d on d.id = f.dish_id
    join staging.source_pages s on s.id = f.source_page_id
    left join auth.users u on u.id = f.entered_by
    left join staging.facts o on o.id = f.replaces_fact_id
   where f.status = 'submitted'
   order by p.shortlist_priority, p.label, d.label nulls first, f.kind, f.subject nulls first, f.entered_at;
$$;
revoke all on function staging.review_queue() from public, anon, authenticated;
