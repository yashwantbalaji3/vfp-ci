-- MAP-1 step 1 (SCALE-1): the dietary rule for many dishes at once.
--
-- Why: a dietary search asks app.eligibility about every candidate dish, one function call
-- at a time; each call makes up to about 30 more calls (family checks and statement lookups).
-- At 2,000 dishes that is the 354-487 ms measured on 15 November (SCALE-1). The map asks the
-- same question about every dish in view, so it would start above the 300 ms target.
--
-- What: app.eligibility_many answers the same question for a whole list of revisions in one
-- set-based query: the same statements, the same allergen rule, the same recipe-ingredient
-- rule, the same claim checks, the same needs-review flag, the same reasons. Nothing calls it
-- yet. Owner decision M-3 (15 Nov 2026): "prove dietary-result equivalence before enabling the
-- optimized queries". The proof is tests/db/map1-eligibility.test.ts plus the comparison over
-- the scale data recorded in LEDGER; the next migration switches the searches over.
--
-- One deliberate difference, in presentation only: when a dish contains more than one
-- forbidden family, the "contains_family" reasons are listed alphabetically. The old loop
-- listed them in the table's physical order, which Postgres does not guarantee. Status and
-- the set of reasons are identical.
--
-- Rollback: drop function app.eligibility_many(uuid[], text, text[], boolean);

create function app.eligibility_many(
  p_revision_ids uuid[], p_diet text, p_exclusions text[], p_include_conditional boolean default false
)
returns table (revision_id uuid, eligibility jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_diet is null or p_diet not in ('none', 'vegetarian', 'vegan') then
    raise exception 'INVALID_DIET' using errcode = 'PT422';
  end if;
  if exists (select 1 from unnest(coalesce(p_exclusions, '{}')) x
             where x not in (select code from public.ingredient_families)) then
    raise exception 'INVALID_EXCLUSION' using errcode = 'PT422';
  end if;

  return query
  with revs as (
    select distinct r as rev from unnest(coalesce(p_revision_ids, '{}')) r
  ), diet_fams as (
    -- Families a diet forbids.
    select f.code from public.ingredient_families f
     where (p_diet = 'vegan' and f.non_vegan) or (p_diet = 'vegetarian' and f.non_vegetarian)
  ), excl as (
    select distinct x as code from unnest(coalesce(p_exclusions, '{}')) x
  ), wanted as (
    select code from diet_fams union select code from excl
  ), ings as (
    -- Included recipe ingredients (as in app.family_presence: optional ones only when included by default).
    select ri.recipe_revision_id as rev, ri.ingredient_revision_id as ing
      from public.recipe_ingredients ri join revs on revs.rev = ri.recipe_revision_id
     where not ri.optional or ri.included_by_default
  ), subjects as (
    select rev as subj from revs union select ing from ings
  ), stmt as (
    select s.revision_id as subj, s.family as code,
           bool_or(s.presence = 'present') as is_present,
           bool_or(s.presence = 'absent_by_statement' and (s.expires_at is null or s.expires_at > now())) as is_absent
      from public.ingredient_family_statements s
      join subjects on subjects.subj = s.revision_id
      join wanted on wanted.code = s.family
     group by 1, 2
  ), alg as (
    -- An allergen declaration of egg or milk is positive evidence of the family.
    select distinct a.revision_id as subj, case a.allergen when 'egg' then 'egg' else 'dairy' end as code
      from public.allergen_statements a join subjects on subjects.subj = a.revision_id
     where a.presence = 'present' and a.allergen in ('egg', 'milk')
  ), direct as (
    -- app.direct_family_presence for every (subject, family) pair at once.
    select su.subj, w.code,
           case when coalesce(st.is_present, false) or al.subj is not null then 'present'
                when coalesce(st.is_absent, false) then 'absent_by_statement'
                else 'unknown' end as presence
      from subjects su cross join wanted w
      left join stmt st on st.subj = su.subj and st.code = w.code
      left join alg al on al.subj = su.subj and al.code = w.code
  ), ing_summary as (
    select i.rev, d.code, count(*) as n,
           bool_or(d.presence = 'present') as any_present, bool_or(d.presence = 'unknown') as any_unknown
      from ings i join direct d on d.subj = i.ing
     group by 1, 2
  ), presence as (
    -- app.family_presence: direct evidence first, then the included ingredients.
    select r.rev, d.code,
           case when d.presence = 'present' then 'present'
                when coalesce(s.n, 0) = 0 then d.presence
                when s.any_present then 'present'
                when s.any_unknown then 'unknown'
                else 'absent_by_statement' end as presence
      from revs r join direct d on d.subj = r.rev
      left join ing_summary s on s.rev = r.rev and s.code = d.code
  ), claim as (
    select r.rev, c.id, c.outcome, c.conflict_state, c.expires_at, c.evidence_tier, c.modifications
      from revs r
      left join lateral (
        select c1.* from public.dietary_claims c1 where c1.revision_id = r.rev and c1.diet = p_diet
        union all
        -- A strict vegan claim also answers a vegetarian question, only when there is no vegetarian claim.
        select c2.* from public.dietary_claims c2
         where p_diet = 'vegetarian' and c2.revision_id = r.rev and c2.diet = 'vegan' and c2.outcome = 'compatible'
           and not exists (select 1 from public.dietary_claims c3 where c3.revision_id = r.rev and c3.diet = 'vegetarian')
        limit 1
      ) c on true
     where p_diet <> 'none'
  ), parts as (
    select r.rev, 1 as sec, ''::text as k, 2 as rank, jsonb_build_object('code', 'needs_review') as reason
      from revs r
     where (p_diet <> 'none' or cardinality(coalesce(p_exclusions, '{}')) > 0)
       and exists (select 1 from public.review_flags rf where rf.flagged_revision_id = r.rev and rf.resolved_at is null)
    union all
    select c.rev, 2, '',
           case when c.id is null then 2
                when c.outcome = 'incompatible' then 3
                when c.conflict_state = 'disputed' then 2
                when c.expires_at is not null and c.expires_at <= now() then 2
                when c.outcome = 'unknown' or c.evidence_tier in ('community_report', 'unknown') then 2
                when c.outcome = 'conditional' then case when p_include_conditional then 1 else 2 end
                else 0 end,
           case when c.id is null then jsonb_build_object('code', 'no_dietary_claim', 'diet', p_diet)
                when c.outcome = 'incompatible' then jsonb_build_object('code', 'diet_incompatible', 'diet', p_diet)
                when c.conflict_state = 'disputed' then jsonb_build_object('code', 'dietary_claim_disputed', 'diet', p_diet)
                when c.expires_at is not null and c.expires_at <= now() then jsonb_build_object('code', 'dietary_claim_expired', 'diet', p_diet)
                when c.outcome = 'unknown' or c.evidence_tier in ('community_report', 'unknown')
                  then jsonb_build_object('code', 'dietary_evidence_insufficient', 'diet', p_diet)
                when c.outcome = 'conditional'
                  then jsonb_build_object('code', 'requires_modification', 'diet', p_diet, 'modifications', c.modifications)
           end
      from claim c
    union all
    -- Positive evidence of a forbidden family overrides any diet claim.
    select p.rev, 3, p.code, 3, jsonb_build_object('code', 'contains_family', 'family', p.code)
      from presence p join diet_fams df on df.code = p.code
     where p.presence = 'present'
    union all
    -- Explicit exclusions: present excludes, unknown needs confirmation (never "safe").
    select p.rev, 4, p.code, case when p.presence = 'present' then 3 else 2 end,
           jsonb_build_object('code', case when p.presence = 'present' then 'contains_excluded_family' else 'unconfirmed_excluded_family' end,
                              'family', p.code)
      from presence p join excl e on e.code = p.code
     where p.presence in ('present', 'unknown')
  )
  select r.rev,
         jsonb_build_object(
           'status', (array['eligible', 'conditional', 'needs_confirmation', 'excluded'])[coalesce(max(pt.rank), 0) + 1],
           'reasons', coalesce(jsonb_agg(pt.reason order by pt.sec, pt.k) filter (where pt.reason is not null), '[]'::jsonb))
    from revs r left join parts pt on pt.rev = r.rev
   group by r.rev;
end;
$$;

revoke all on function app.eligibility_many(uuid[], text, text[], boolean) from public, anon, authenticated;
