-- Log screens: an estimate stays an estimate before it is logged too (owner 18:17 UTC, A-MERGE-33-34:
-- "Estimated protein must never be displayed as an exact measurement").
-- loggable_food returned only the central value of each portion's nutrients, so the log form showed
-- an estimated dish as "28 g protein". Each portion nutrient now also carries 'lower' and 'upper'
-- (null unless the value is an estimated range), exactly as the diary day view does since
-- 20261116000600. recent_foods ("Logged recently") adds 'proteinMethod', 'proteinLow' and 'proteinHigh'
-- from the same snapshot. No other field changes. The function is patched from its current definition, and
-- the migration fails if the expected text is missing.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.loggable_food(uuid, boolean)'::regprocedure);
  before := d;
  d := replace(d,
    $x$jsonb_build_object('value', (n.value ->> 'value')::numeric, 'method', n.value ->> 'method')$x$,
    $x$jsonb_build_object('value', (n.value ->> 'value')::numeric, 'method', n.value ->> 'method', 'lower', (n.value ->> 'lower')::numeric, 'upper', (n.value ->> 'upper')::numeric)$x$);
  if d = before then raise exception 'loggable_food: portion nutrients text not found'; end if;
  execute d;

  d := pg_get_functiondef('public.recent_foods(integer)'::regprocedure);
  before := d;
  d := replace(d,
    $x$(s.nutrients -> 'protein_g' ->> 'value')::numeric as "proteinG",$x$,
    $x$(s.nutrients -> 'protein_g' ->> 'value')::numeric as "proteinG",
             s.nutrients -> 'protein_g' ->> 'method' as "proteinMethod",
             (s.nutrients -> 'protein_g' ->> 'lower')::numeric as "proteinLow",
             (s.nutrients -> 'protein_g' ->> 'upper')::numeric as "proteinHigh",$x$);
  if d = before then raise exception 'recent_foods: protein text not found'; end if;
  execute d;
end;
$mig$;
