-- Diary: an estimate stays an estimate (NIE N-4 diary part; owner 15:58 UTC item 5).
-- Snapshots already keep an estimate's low and high values (app.portion_nutrients), but the day and
-- week views returned only the central value, so a logged estimate looked like an exact figure and a
-- goal could be shown as "reached" on the strength of a guess. Now:
--   * each diary entry's nutrient carries 'lower' and 'upper' (null unless it is an estimated range);
--   * day totals add 'low' and 'high': the sum using each estimate's low (or high) end and every
--     exact value as it is. Unknown values stay out of every sum, exactly as before;
--   * the week view adds 'proteinLow' per day, so "goal met" can require the low end.
-- Only these fields are added; every existing field keeps its meaning. The functions are patched
-- in place from their current definitions, and the migration fails if an expected text is missing.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.diary_day(date)'::regprocedure);
  before := d;
  d := replace(d,
    $x$jsonb_build_object('value', (n.value ->> 'value')::numeric, 'method', n.value ->> 'method')$x$,
    $x$jsonb_build_object('value', (n.value ->> 'value')::numeric, 'method', n.value ->> 'method', 'lower', (n.value ->> 'lower')::numeric, 'upper', (n.value ->> 'upper')::numeric)$x$);
  if d = before then raise exception 'diary_day: entry nutrients text not found'; end if;
  before := d;
  d := replace(d,
    $x$'unknownEntries', t.unknown, 'estimatedEntries', t.estimated))$x$,
    $x$'unknownEntries', t.unknown, 'estimatedEntries', t.estimated, 'low', t.low, 'high', t.high))$x$);
  if d = before then raise exception 'diary_day: totals object text not found'; end if;
  before := d;
  d := replace(d,
    $x$sum((n.value ->> 'value')::numeric) as known,$x$,
    $x$sum((n.value ->> 'value')::numeric) as known,
                       sum(case when n.value ->> 'value' is not null then coalesce((n.value ->> 'lower')::numeric, (n.value ->> 'value')::numeric) end) as low,
                       sum(case when n.value ->> 'value' is not null then coalesce((n.value ->> 'upper')::numeric, (n.value ->> 'value')::numeric) end) as high,$x$);
  if d = before then raise exception 'diary_day: totals sum text not found'; end if;
  execute d;

  d := pg_get_functiondef('public.diary_week(date)'::regprocedure);
  before := d;
  d := replace(d,
    $x$'proteinKnown', a.protein_known,$x$,
    $x$'proteinKnown', a.protein_known,
               'proteinLow', a.protein_low,$x$);
  if d = before then raise exception 'diary_week: proteinKnown text not found'; end if;
  before := d;
  d := replace(d,
    $x$sum((s.nutrients -> 'protein_g' ->> 'value')::numeric) as protein_known,$x$,
    $x$sum((s.nutrients -> 'protein_g' ->> 'value')::numeric) as protein_known,
                 sum(case when s.nutrients -> 'protein_g' ->> 'value' is not null
                          then coalesce((s.nutrients -> 'protein_g' ->> 'lower')::numeric, (s.nutrients -> 'protein_g' ->> 'value')::numeric) end) as protein_low,$x$);
  if d = before then raise exception 'diary_week: protein sum text not found'; end if;
  execute d;
end;
$mig$;
