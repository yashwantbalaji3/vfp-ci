-- Founder decision 17 Nov 2026 05:49 UTC (decision card "Which sample rule should replace
-- 'at most 2 problems in 120'?", option "0 in 61, or at most 2 in 125").
-- 2 problems in 120 gives a 95% upper bound of about 5.15%, above the 5% quality target.
-- 2 in 125 gives about 4.95%; 0 in 61 gives about 4.79%. Only the larger sample size changes.
create or replace function app.sample_passes(k integer, n integer, checked integer)
returns boolean language sql immutable set search_path = '' as $$
  select checked = n and n > 0 and ((n >= 61 and k = 0) or (n >= 125 and k <= 2));
$$;
revoke all on function app.sample_passes(integer, integer, integer) from public, anon, authenticated;

-- A batch's sample result, computed only from the founder's latest decision on each sampled place.
-- A problem is a "reject" or "needs more evidence" decision.
create or replace function app.batch_status(p_batch uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.publication_batches; v_n integer; v_checked integer; v_k integer; v_appr public.batch_approvals; v_bound numeric;
begin
  select * into b from public.publication_batches where id = p_batch;
  if not found then return null; end if;
  select count(*), count(d.decision), count(*) filter (where d.decision in ('reject', 'needs_more_evidence'))
    into v_n, v_checked, v_k
    from public.publication_batch_places bp
    left join lateral (select r.decision from public.identity_reviews r where r.candidate_id = bp.candidate_id order by r.decided_at desc, r.id desc limit 1) d on true
   where bp.batch_id = p_batch and bp.in_sample;
  select * into v_appr from public.batch_approvals a where a.batch_id = p_batch order by a.decided_at desc, a.id desc limit 1;
  v_bound := app.binomial_upper_95(v_k, v_checked);
  return jsonb_build_object(
    'id', b.id, 'name', b.name, 'sampleSeed', b.sample_seed, 'places', b.place_count, 'frozenAt', b.frozen_at,
    'sampleSize', v_n, 'checked', v_checked, 'problems', v_k,
    'upperBound', v_bound,
    'passes', app.sample_passes(v_k, v_n, v_checked),
    'rule', 'All sampled places checked, and 0 problems in at least 61, or at most 2 problems in at least 125.',
    'approved', coalesce(v_appr.decision = 'approve' and v_appr.decided_at > now() - interval '90 days', false),
    'approvalExpired', coalesce(v_appr.decision = 'approve' and v_appr.decided_at <= now() - interval '90 days', false),
    'excluded', (select count(*) from public.publication_batch_places bp
                   where bp.batch_id = p_batch
                     and (select r.decision from public.identity_reviews r where r.candidate_id = bp.candidate_id order by r.decided_at desc, r.id desc limit 1) in ('reject', 'needs_more_evidence'))
  );
end $$;
revoke all on function app.batch_status(uuid) from public, anon, authenticated;
