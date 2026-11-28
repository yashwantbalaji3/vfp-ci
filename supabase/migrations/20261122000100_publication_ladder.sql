-- Publication eligibility ladder (owner decision D1, 2026-11-22 03:56 UTC; APPROVALS A-1122-D1D6).
--
-- Every researched fact reports six separate states, each read from its own record:
--   extracted              the fact was drafted from a named source page (every fact)
--   autoCompared           the latest automatic comparison with the saved source page: found / not_found / not_checked
--   independentlyReviewed  a second person reviewed a publication change holding the fact: the reviewer is neither
--                          the change's author nor the person who entered the fact (the two-person editor review)
--   founderConfirmed       the founder confirmed the transcription or verified the fact
--   rightsEligible         the source's access record clears reuse (terms or written permission)
--   published              the fact is in a publication change that was actually published
-- No state implies another. An automatic comparison never counts as a review or a confirmation. Nothing in this
-- migration changes data, the publication locks or who can call the function (founder screens only, through the
-- server). Additive: the existing 'statuses' keys are unchanged.

create or replace function public.menu_review_fact_json(f staging.facts, p_me uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select staging.source_access_state((select p.url from staging.source_pages p where p.id = f.source_page_id)) as access,
           exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription') as transcribed,
           staging.single_published_value(f) as single,
           (select mc.result from staging.current_machine_check(f.id) mc where mc.id is not null) as machine,
           exists (select 1 from staging.publication_changes pc join public.catalog_changes cc on cc.id = pc.change_id
                    where f.id = any (pc.fact_ids) and cc.state = 'published') as published,
           exists (select 1 from staging.publication_changes pc join public.catalog_changes cc on cc.id = pc.change_id
                    where f.id = any (pc.fact_ids) and cc.reviewer_id is not null and cc.reviewed_at is not null
                      and cc.state = 'published'
                      and cc.reviewer_id is distinct from cc.author_id and cc.reviewer_id <> f.entered_by) as second_review
  )
  select jsonb_build_object(
    'factId', f.id, 'kind', f.kind, 'subject', f.subject, 'value', f.value, 'unknown', f.is_unknown,
    'unknownReason', f.unknown_reason, 'status', f.status, 'confidence', f.confidence,
    'sourceId', f.source_page_id, 'checkedOn', f.checked_on, 'access', s.access,
    'confirmAs', case when f.status <> 'submitted' or f.entered_by = p_me then null
                      when s.access = 'cleared' and s.single then 'verify'
                      when s.access = 'private_pilot' and not s.transcribed then 'transcription' end,
    'canConfirm', f.status = 'submitted' and f.entered_by <> p_me
                  and ((s.access = 'cleared' and s.single) or (s.access = 'private_pilot' and not s.transcribed)),
    'canReject', f.status = 'submitted' and f.entered_by <> p_me,
    'statuses', jsonb_build_object(
      'extracted', true,
      'transcriptionConfirmed', s.transcribed or f.status = 'verified',
      'dietaryVerified', f.status = 'verified' and f.kind in ('dietary_status', 'allergen_statement'),
      'nutritionVerified', f.status = 'verified' and f.kind in ('published_nutrition', 'serving_size'),
      'reuseEligible', s.access = 'cleared',
      'publicationApproved', s.published),
    -- Owner decision D1 (22 Nov 2026): six states that are never interchangeable. Each is computed from its own
    -- record; nothing here is set by another state, and no state is ever recorded on anyone's behalf.
    'ladder', jsonb_build_object(
      'extracted', true,
      'autoCompared', coalesce(s.machine, 'not_checked'),
      'independentlyReviewed', s.second_review,
      'founderConfirmed', s.transcribed or f.status = 'verified',
      'rightsEligible', s.access = 'cleared',
      'published', s.published),
    -- What the founder's private confirmation rested on: their own comparison, or the automatic one
    -- that they accepted. Never shown as a comparison by the founder when it was not.
    'confirmationBasis', (select case when c.note like 'Basis: automatic comparison accepted%' then 'automatic_comparison' else 'founder' end
                            from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription'),
    'machineCheck', (select jsonb_build_object('result', mc.result, 'detail', mc.detail, 'pageSavedAt', mc.page_saved_at, 'at', mc.created_at)
                       from staging.current_machine_check(f.id) mc where mc.id is not null))
  from s;
$$;
revoke all on function public.menu_review_fact_json(staging.facts, uuid) from public, anon, authenticated;

-- Rollback: re-run public.menu_review_fact_json from 20261118001700_quality_checks.sql (drops the 'ladder' key).
