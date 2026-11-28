-- Which saved source page each drafted meal was compared against, for the founder's side-by-side review
-- (owner directive 27 Nov 2026 06:04 UTC, section 4: "Original menu wording" next to "our recorded dish information").
--
-- The page bodies are never in the database (they are the restaurants' own menus, kept as private files). This only
-- returns the SHA-256 the automatic comparison recorded for each meal's facts, so the founder's own computer can find
-- its private copy of that exact page and show the menu's wording beside the draft. Founder only. Read-only.
--
-- Adds only. Rollback: drop function if exists public.founder_dish_pages(uuid[]);

create or replace function public.founder_dish_pages(p_dishes uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  if coalesce(array_length(p_dishes, 1), 0) > 500 then
    raise exception 'TOO_MANY: at most 500 meals at a time' using errcode = 'PT422';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('dishId', x.dish_id, 'url', x.url, 'sha256', x.page_sha256, 'savedAt', x.saved_at) order by x.dish_id, x.url)
      from (
        select distinct on (f.dish_id, mc.page_sha256) f.dish_id, sp.url, mc.page_sha256, mc.page_saved_at saved_at
          from staging.facts f
          join staging.fact_machine_checks mc on mc.fact_id = f.id
          join staging.source_pages sp on sp.id = f.source_page_id
         where f.dish_id = any (p_dishes) and mc.page_sha256 is not null
         order by f.dish_id, mc.page_sha256, mc.created_at desc
      ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.founder_dish_pages(uuid[]) from public, anon;
grant execute on function public.founder_dish_pages(uuid[]) to authenticated;
