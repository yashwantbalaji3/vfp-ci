-- M2 follow-up (owner request 2026-11-13): a page for a dish or place that does not
-- exist must answer with a real HTTP 404. The page shell streams before the page's own
-- lookup, so the request proxy asks this small yes/no question first.
-- It reveals nothing beyond what food_detail / venue_detail already reveal: whether a
-- public, published item with this id exists.
create function public.catalog_item_exists(p_kind text, p_id uuid, p_include_demo boolean default false)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'food' then exists (
      select 1 from public.food_items fi
        join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
       where fi.id = p_id and fi.visibility = 'public' and fi.status = 'published' and (p_include_demo or not fi.is_demo))
    when 'venue' then exists (
      select 1 from public.venues v
       where v.id = p_id and v.status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not v.is_demo))
    else false
  end;
$$;
revoke execute on function public.catalog_item_exists(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.catalog_item_exists(text, uuid, boolean) to anon, authenticated;
