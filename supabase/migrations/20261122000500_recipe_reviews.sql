-- Recipe reviews (owner direction 22 Nov 2026 06:25 UTC: strengthen real-data social across ordinary accounts;
-- docs/68). Until now a review could be about a restaurant or a restaurant dish only (R-S02), so in real mode an
-- ordinary member had nothing real to review: real places stay founder-only until publication. The 50 original
-- recipes are public, so a member may now rate and review one, with the same audiences (only me / friends /
-- everyone), the same first-public-post check, rate limit and moderation as any review. Nothing else changes.
-- save_review and export_my_data have been replaced several times, so each is patched in place.
do $m$
declare
  d text;
  before text;
begin
  d := pg_get_functiondef('public.save_review(text, uuid, integer, text, date, integer, boolean)'::regprocedure);
  before := d;
  d := replace(d, $x$->> 'kind', '') not in ('venue', 'dish') then$x$, $x$->> 'kind', '') not in ('venue', 'dish', 'recipe') then$x$);
  if d = before then raise exception 'save_review: target kind check not found'; end if;
  execute d;

  d := pg_get_functiondef('public.export_my_data()'::regprocedure);
  before := d;
  d := replace(d, $x$case when r.venue_id is not null then 'restaurant' else 'dish' end$x$,
                  $x$case when r.venue_id is not null then 'restaurant'
                          when (select fi.kind from public.food_items fi where fi.id = r.food_item_id) = 'recipe' then 'recipe'
                          else 'dish' end$x$);
  if d = before then raise exception 'export_my_data: review kind text not found'; end if;
  execute d;
end $m$;

-- Rollback: only once no review is about a recipe (delete those reviews first, with their owners' knowledge), patch
-- the two functions back the same way: 'recipe' out of save_review's target check and export_my_data's kind case.
