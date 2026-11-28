-- R2 fix-up: faster dietary-filter search, same answers.
--
-- Why: with a diet filter, search_catalog asks app.eligibility about every published row
-- (2,088 rows in the synthetic scale benchmark). For a vegan question eligibility then asked
-- app.family_presence about each of the 7 non-vegan ingredient families, so one search made
-- about 15,000 family checks and 16,000 statement lookups (measured with track_functions:
-- eligibility 596 ms of a 741 ms vegan search). Most rows have no positive evidence at all.
--
-- Change: before the per-family loop, check once whether this revision has any evidence that
-- could make a family "present": a "present" family statement, an egg or milk allergen
-- declaration, or recipe ingredients (whose own statements family_presence would consult).
-- Without any of these, family_presence cannot return "present" for any family, so the loop
-- is skipped. The answer is identical by construction; the explicit-exclusion loop (which
-- must still tell "unknown" from "absent") is unchanged, and so is every other rule.
--
-- Evidence: work/r2/perf/equiv.sql compared old and new answers for every revision x
-- {none, vegan, vegetarian} x 4 exclusion sets x conditional on/off: 50,112 cases, 0 differences.
-- tests/db/eligibility.test.ts "fast path" covers the allergen-only and recipe-ingredient routes.
--
-- Rollback: re-create app.eligibility from this file with the v_may_contain check removed
-- (delete the "v_may_contain := ..." statement and the "where v_may_contain and" condition).
-- The function keeps its existing privileges either way (create or replace preserves them).

CREATE OR REPLACE FUNCTION app.eligibility(p_revision_id uuid, p_diet text, p_exclusions text[], p_include_conditional boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reasons jsonb := '[]'::jsonb;
  v_rank integer := 0;   -- 0 eligible, 1 conditional, 2 needs_confirmation, 3 excluded
  c public.dietary_claims;
  f record;
  v_presence text;
  v_may_contain boolean;
begin
  if p_diet not in ('none', 'vegetarian', 'vegan') then
    raise exception 'INVALID_DIET' using errcode = 'PT422';
  end if;
  if exists (select 1 from unnest(coalesce(p_exclusions, '{}')) x
             where x not in (select code from public.ingredient_families)) then
    raise exception 'INVALID_EXCLUSION' using errcode = 'PT422';
  end if;

  if (p_diet <> 'none' or cardinality(coalesce(p_exclusions, '{}')) > 0)
     and exists (select 1 from public.review_flags rf where rf.flagged_revision_id = p_revision_id and rf.resolved_at is null) then
    v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'needs_review');
  end if;

  if p_diet <> 'none' then
    select * into c from public.dietary_claims where revision_id = p_revision_id and diet = p_diet;
    -- A strict vegan claim also answers a vegetarian question.
    if not found and p_diet = 'vegetarian' then
      select * into c from public.dietary_claims
       where revision_id = p_revision_id and diet = 'vegan' and outcome = 'compatible';
    end if;
    if c.id is null then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'no_dietary_claim', 'diet', p_diet);
    elsif c.outcome = 'incompatible' then
      v_rank := 3; v_reasons := v_reasons || jsonb_build_object('code', 'diet_incompatible', 'diet', p_diet);
    elsif c.conflict_state = 'disputed' then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'dietary_claim_disputed', 'diet', p_diet);
    elsif c.expires_at is not null and c.expires_at <= now() then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'dietary_claim_expired', 'diet', p_diet);
    elsif c.outcome = 'unknown' or c.evidence_tier in ('community_report', 'unknown') then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'dietary_evidence_insufficient', 'diet', p_diet);
    elsif c.outcome = 'conditional' then
      v_rank := greatest(v_rank, case when p_include_conditional then 1 else 2 end);
      v_reasons := v_reasons || jsonb_build_object('code', 'requires_modification', 'diet', p_diet, 'modifications', c.modifications);
    end if;

    -- Positive evidence of a forbidden family overrides any diet claim.
    -- Fast path (same answer): a family can only be "present" when this revision has a "present"
    -- family statement, an egg/milk allergen declaration, or recipe ingredients. With none of
    -- those, no family can be present, so the per-family checks below are skipped.
    v_may_contain := exists (select 1 from public.ingredient_family_statements s
                              where s.revision_id = p_revision_id and s.presence = 'present')
                  or exists (select 1 from public.allergen_statements a
                              where a.revision_id = p_revision_id and a.presence = 'present' and a.allergen in ('egg', 'milk'))
                  or exists (select 1 from public.recipe_ingredients ri where ri.recipe_revision_id = p_revision_id);
    for f in select code from public.ingredient_families
             where v_may_contain
               and ((p_diet = 'vegan' and non_vegan) or (p_diet = 'vegetarian' and non_vegetarian)) loop
      if app.family_presence(p_revision_id, f.code) = 'present' then
        v_rank := 3; v_reasons := v_reasons || jsonb_build_object('code', 'contains_family', 'family', f.code);
      end if;
    end loop;
  end if;

  -- Explicit exclusions: present excludes, unknown needs confirmation (never "safe").
  for f in select distinct x as code from unnest(coalesce(p_exclusions, '{}')) x order by 1 loop
    v_presence := app.family_presence(p_revision_id, f.code);
    if v_presence = 'present' then
      v_rank := 3; v_reasons := v_reasons || jsonb_build_object('code', 'contains_excluded_family', 'family', f.code);
    elsif v_presence = 'unknown' then
      v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object('code', 'unconfirmed_excluded_family', 'family', f.code);
    end if;
  end loop;

  return jsonb_build_object(
    'status', (array['eligible', 'conditional', 'needs_confirmation', 'excluded'])[v_rank + 1],
    'reasons', v_reasons
  );
end;
$function$

;
