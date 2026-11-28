-- Faster founder review (owner 18 Nov 2026 15:15 UTC, "reduce manual work without misrepresenting automated
-- results as founder verification"). docs/57.
--
-- In every review queue, places whose automatic pre-check says "look closer" come before places where every
-- check agrees, both in the list and in "next place". Undecided places still come before decided ones. Only
-- the order changes: nothing is decided, counted or published, and the signatures stay the same.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.identity_review_list(text, integer)'::regprocedure);
  before := d;
  d := replace(d,
    $x$row_number() over (order by (it.decision is not null), it.sort_key, it.candidate_id) rn$x$,
    $x$row_number() over (order by (it.decision is not null), (coalesce(it.evidence #>> '{precheck,level}', '') <> 'look'), it.sort_key, it.candidate_id) rn$x$);
  if d = before then raise exception 'identity_review_list: text not found'; end if;
  execute d;

  d := pg_get_functiondef('public.identity_review_item(uuid, text)'::regprocedure);
  before := d;
  d := replace(d,
    $x$order by n.sort_key, n.candidate_id limit 1)$x$,
    $x$order by (coalesce(n.evidence #>> '{precheck,level}', '') <> 'look'), n.sort_key, n.candidate_id limit 1)$x$);
  if d = before then raise exception 'identity_review_item: text not found'; end if;
  execute d;
end;
$mig$;

-- Rollback: re-run public.identity_review_list and public.identity_review_item from
-- 20261118000600_identity_precheck.sql (or wherever they were last defined). No data changes.
