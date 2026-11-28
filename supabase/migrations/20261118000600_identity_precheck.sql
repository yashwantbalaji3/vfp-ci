-- Automatic identity pre-check in the founder's review (docs/51). Owner 18 Nov 2026 05:27 UTC: "introduce automated
-- restaurant identity assessments to minimize manual work on the 61-place founder sample".
--
-- The pre-check is computed by scripts/lib/identity-precheck.mjs when `catalog-preview.mjs build` writes the evidence
-- snapshot, and stored as evidence->'precheck' ({level: agree|look, concerns: [...], version}). This migration only
-- lets the queue list and the summary show it. It decides nothing: no decision, listing, sample result or switch
-- changes, and "agree" never counts as a check by the founder. Both functions keep their signatures, so their grants
-- (founder only, through app.require_founder) are unchanged.

create or replace function public.identity_review_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_founder();
  with items as (
    select i.*, (app.latest_identity_review(i.candidate_id)).decision as decision
      from public.identity_review_items i where i.active
  ), q as (
    select unnest(i.queues) as queue, i.decision from items i
  ), seeds as (
    select i.sample_seed from items i where i.sample_seed is not null limit 1
  )
  select jsonb_build_object(
    'queues', coalesce((select jsonb_agg(jsonb_build_object('queue', x.queue, 'total', x.total, 'decided', x.decided) order by case when x.queue = 'sample' then 0 else 1 end, x.total desc, x.queue)
                          from (select queue, count(*) total, count(decision) decided from q group by queue) x), '[]'::jsonb),
    'sample', (select jsonb_build_object('seed', s.sample_seed,
                 'total', (select count(*) from items where 'sample' = any(queues)),
                 'checked', (select count(decision) from items where 'sample' = any(queues)),
                 'correct', (select count(*) from items where 'sample' = any(queues) and decision = 'verify_identity'),
                 'problems', (select count(*) from items where 'sample' = any(queues) and decision in ('reject', 'needs_more_evidence')),
                 -- New: how many sample places the automatic pre-check found nothing worrying about, and how many it flagged.
                 'precheckAgree', (select count(*) from items where 'sample' = any(queues) and evidence #>> '{precheck,level}' = 'agree'),
                 'precheckLook', (select count(*) from items where 'sample' = any(queues) and evidence #>> '{precheck,level}' = 'look'))
               from seeds s),
    'decisions', jsonb_build_object(
      'verified', (select count(*) from items where decision = 'verify_identity'),
      'rejected', (select count(*) from items where decision = 'reject'),
      'needsMoreEvidence', (select count(*) from items where decision = 'needs_more_evidence'))
  ) into v;
  return v;
end $$;

-- One queue, 25 at a time, undecided first; each item now carries its pre-check result (or null before a rebuild).
create or replace function public.identity_review_list(p_queue text, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_founder();
  if p_queue is null or length(p_queue) > 60 then raise exception 'INVALID_QUEUE' using errcode = 'PT422'; end if;
  if p_offset < 0 or p_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  with items as (
    select i.*, d.decision, d.decided_at
      from public.identity_review_items i
      left join lateral (select r.decision, r.decided_at from public.identity_reviews r where r.candidate_id = i.candidate_id order by r.decided_at desc, r.id desc limit 1) d on true
     where i.active and p_queue = any(i.queues)
  ), ordered as (
    select it.*, row_number() over (order by (it.decision is not null), it.sort_key, it.candidate_id) rn from items it
  )
  select jsonb_build_object(
    'queue', p_queue,
    'total', (select count(*) from items),
    'decided', (select count(decision) from items),
    'items', coalesce((select jsonb_agg(jsonb_build_object('candidateId', o.candidate_id, 'name', o.name, 'street', o.street, 'postcode', o.postcode,
                 'area', o.area, 'queues', to_jsonb(o.queues), 'decision', o.decision,
                 'precheck', case when o.evidence #>> '{precheck,level}' in ('agree', 'look')
                                  then jsonb_build_object('level', o.evidence #>> '{precheck,level}', 'concerns', coalesce(o.evidence #> '{precheck,concerns}', '[]'::jsonb)) end) order by o.rn)
               from ordered o where o.rn > p_offset and o.rn <= p_offset + 25), '[]'::jsonb),
    'nextOffset', case when (select count(*) from items) > p_offset + 25 then p_offset + 25 end
  ) into v;
  return v;
end $$;

-- Rollback (local database): re-run the two function definitions from 20261117000300_identity_review.sql.
-- The stored evidence->'precheck' is harmless to older code and is rewritten by the next build.
