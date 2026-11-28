-- Linked menus waiting for the founder's identity check (owner follow-up, 22 Nov 2026 15:37 UTC: Cafe Landwer Back
-- Bay was imported and linked but did not appear). A researched menu shows in the preview only once its catalog
-- place is a preview listing, and some places (near twins, two records at one address) enter the preview only on
-- the founder's own identity decision. This read-only, founder-only list names those places so the preview can say
-- why they are missing. It changes nothing and decides nothing.
create function public.menu_preview_waiting()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object('label', p.label, 'candidateId', c.id, 'name', c.name, 'street', c.street, 'postcode', c.postcode,
                                        'quality', c.quality,
                                        'listing', (select l.visibility from public.place_listings l where l.candidate_id = c.id))
                     order by p.label)
      from staging.live_catalog_links k
      join staging.places p on p.id = k.staging_place
      join catalog_import.place_candidates c on c.id = k.candidate_id
     where not exists (select 1 from public.place_listings l where l.candidate_id = c.id and l.visibility = 'preview')
       and not exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id
                        where f.place_id = p.id and s.is_demo)), '[]'::jsonb);
end;
$$;
revoke all on function public.menu_preview_waiting() from public, anon;
grant execute on function public.menu_preview_waiting() to authenticated;

-- Rollback: drop function public.menu_preview_waiting().
