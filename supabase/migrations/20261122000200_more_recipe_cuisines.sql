-- More recipe cuisines (owner direction 22 Nov 2026: recipes with cuisine and diet filters). The recipe library
-- now has Mexican, Italian, Middle Eastern, East African and American dishes that were filed as "everyday" or
-- "mediterranean" because the cuisine list had only four values. Additive: the four old values stay valid, no
-- row changes here (the recipe loader sets the new values), and recipe_list accepts the new filters.

alter table public.recipe_revisions drop constraint if exists recipe_revisions_cuisine_check;
alter table public.recipe_revisions add constraint recipe_revisions_cuisine_check
  check (cuisine is null or cuisine in ('indian', 'asian', 'mediterranean', 'everyday', 'mexican', 'italian', 'middle_eastern', 'east_african', 'american'));

-- recipe_list has been patched in place before (20261118000900), so the cuisine check is patched the same way.
do $m$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.recipe_list(jsonb)'::regprocedure);
  before := d;
  d := replace(d,
    $x$v_cuisine not in ('indian', 'asian', 'mediterranean', 'everyday')$x$,
    $x$v_cuisine not in ('indian', 'asian', 'mediterranean', 'everyday', 'mexican', 'italian', 'middle_eastern', 'east_african', 'american')$x$);
  if d = before then raise exception 'recipe_list: cuisine check text not found'; end if;
  execute d;
end $m$;

-- Rollback: only if no recipe uses a new value, restore the four-value check and replace the cuisine list in
-- recipe_list back to the four values the same way.
