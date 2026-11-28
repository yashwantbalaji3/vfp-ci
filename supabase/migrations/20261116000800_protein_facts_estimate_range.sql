-- Protein facts: an estimate carries its range (owner 19:54 UTC 16 Nov, priority 2: published,
-- calculated, estimated-range and unknown values consistently distinguished everywhere).
-- app.protein_facts feeds every card, Protein Explorer row and comparison. It returned only the
-- central value of an estimate, so those screens could say "about 28 g" but not "24–32 g".
-- It now adds 'estimateLow' and 'estimateHigh': the estimate's low and high ends on the record's own
-- basis (the same basis as 'basisValue'), present only when the shown value is an estimated range
-- and null otherwise (exact, unknown or hidden estimate). Screens scale them by the same factor as
-- the value for per-serving, per-100 g and per-100 kcal views. No other field changes. The function
-- is patched from its current definition, and the migration fails if the expected text is missing.
do $mig$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('app.protein_facts(uuid, boolean)'::regprocedure);
  before := d;
  d := replace(d,
    $x$'energyMethod', en.method
  );$x$,
    $x$'energyMethod', en.method,
    'estimateLow', case when v_protein is not null and pn.method = 'estimated' then pn.lower_value end,
    'estimateHigh', case when v_protein is not null and pn.method = 'estimated' then pn.upper_value end
  );$x$);
  if d = before then raise exception 'protein_facts: result object text not found'; end if;
  execute d;
end;
$mig$;
