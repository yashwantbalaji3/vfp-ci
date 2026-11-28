-- Real places in the rest of the app (PLACE-LINK, docs/49). Owner 18 Nov 02:27 UTC, point 3: "Connect real
-- restaurant records to saves, ratings, lists, corrections and the broader social infrastructure. Preserve the
-- existing privacy and moderation rules."
--
-- Saves, reviews, rankings and list items all point at public.venues. A real place (public.place_listings) gets
-- its own venue row the first time someone saves, rates or lists it. That venue row:
--   * is never demo (is_demo = false) and stays status 'draft' for ever, so every older query that shows
--     published venues (demo Discover, venue pages, editor tools) keeps ignoring it;
--   * takes its visibility from the listing alone: whoever may see the listing (app.place_visible) may see the
--     venue; when the listing is withdrawn, the venue, its saves and its reviews disappear from every screen;
--   * copies identity fields only (name, address, position, kind). No menu, diet, allergen or nutrition field
--     is set, and the listing's menu status is unchanged.
-- Reviews, lists, rankings, feeds, reports and moderation keep their own rules; only the "may this target be
-- seen" check (app.social_target, ranking entries, the venues read policy) learns about linked venues.

alter table public.place_listings add column venue_id uuid unique references public.venues (id);

-- A venue kind for a listing's category. Identity only.
create function app.listing_venue_type(p_category text)
returns text language sql immutable set search_path = '' as $$
  select case p_category
    when 'Restaurant' then 'restaurant' when 'Quick service' then 'restaurant'
    when 'Café' then 'cafe' when 'Coffee shop' then 'cafe' when 'Juice bar' then 'cafe'
    when 'Food truck' then 'food_truck'
    else 'other' end;
$$;
revoke all on function app.listing_venue_type(text) from public, anon, authenticated;

-- The listing a venue was made for, when the caller may see it (preview counts for the founder only, through
-- app.place_visible's own role check). Null for every demo or editorial venue.
create function app.visible_listing_for_venue(p_venue uuid)
returns public.place_listings language sql stable security definer set search_path = '' as $$
  select l.* from public.place_listings l where l.venue_id = p_venue and app.place_visible(l, true);
$$;
revoke all on function app.visible_listing_for_venue(uuid) from public, anon, authenticated;

create function app.linked_place_visible(p_venue uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (app.visible_listing_for_venue(p_venue)).id is not null;
$$;
revoke all on function app.linked_place_visible(uuid) from public, anon, authenticated;
grant execute on function app.linked_place_visible(uuid) to anon, authenticated; -- used by the venues read policy

-- The venues read policy: as before, plus a linked venue whose listing the caller may see.
drop policy venues_read on public.venues;
create policy venues_read on public.venues for select to anon, authenticated
  using (status in ('published', 'temporarily_closed', 'closed') or app.is_catalog_editor()
         or (status = 'draft' and not is_demo and app.linked_place_visible(id)));

-- Gives a real place its venue row (once) and returns it. Only someone who may see the place can do this.
create function public.place_link_venue(p_listing uuid, p_preview boolean default false)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare l public.place_listings; v_market public.markets; v_slug text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  select * into l from public.place_listings where id = p_listing for update;
  if not found or not app.place_visible(l, p_preview) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if l.venue_id is not null then return l.venue_id; end if;
  select * into v_market from public.markets m where m.slug = l.market_slug;
  if not found then raise exception 'MARKET_MISSING' using errcode = 'PT422'; end if;
  v_slug := l.slug;
  if exists (select 1 from public.venues v where v.market_id = v_market.id and v.slug = v_slug) then
    v_slug := left(l.slug, 111) || '-' || left(replace(l.id::text, '-', ''), 8);
  end if;
  insert into public.venues (market_id, slug, name, neighborhood, street, locality, region, postal_code, location, timezone, venue_type, status, is_demo)
  values (v_market.id, v_slug, l.name, l.area, l.street, l.locality, 'MA', l.postcode,
          extensions.st_setsrid(extensions.st_makepoint(l.lon, l.lat), 4326)::extensions.geography,
          v_market.default_timezone, app.listing_venue_type(l.category), 'draft', false)
  returning id into v_id;
  update public.place_listings set venue_id = v_id where id = l.id;
  return v_id;
end $$;
revoke all on function public.place_link_venue(uuid, boolean) from public, anon;
grant execute on function public.place_link_venue(uuid, boolean) to authenticated;

-- A rebuilt listing keeps its venue's identity fields in step (a later import may correct a name or address).
create function app.sync_listing_venue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.venue_id is not null and (new.name, new.street, new.locality, new.postcode, new.area, new.lat, new.lon, new.category)
       is distinct from (old.name, old.street, old.locality, old.postcode, old.area, old.lat, old.lon, old.category) then
    update public.venues
       set name = new.name, street = new.street, locality = new.locality, postal_code = new.postcode, neighborhood = new.area,
           location = extensions.st_setsrid(extensions.st_makepoint(new.lon, new.lat), 4326)::extensions.geography,
           venue_type = app.listing_venue_type(new.category)
     where id = new.venue_id;
  end if;
  return null;
end $$;
revoke all on function app.sync_listing_venue() from public, anon, authenticated;
create trigger place_listings_sync_venue after update on public.place_listings
  for each row execute function app.sync_listing_venue();

-- A listing's venue link is set once and never moved to another venue.
create function app.guard_listing_venue()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.venue_id is not null and new.venue_id is distinct from old.venue_id then
    raise exception 'A place keeps its venue' using errcode = 'PT403';
  end if;
  return new;
end $$;
revoke all on function app.guard_listing_venue() from public, anon, authenticated;
create trigger place_listings_venue_guard before update of venue_id on public.place_listings
  for each row execute function app.guard_listing_venue();

-- Social targets: a linked venue is visible exactly when its listing is. Its name and area come from the
-- listing, and 'placeSlug' lets screens link to the place page.
create or replace function app.social_target(p_venue uuid, p_food uuid, p_diet text, p_exclusions text[], p_include_conditional boolean, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_venue is not null then (
      select case
        when l.id is not null then
          jsonb_build_object('kind', 'venue', 'id', v.id, 'name', l.name, 'neighborhood', l.area, 'isDemo', false, 'placeSlug', l.slug)
        when v.status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not v.is_demo)
             and not exists (select 1 from public.place_listings x where x.venue_id = v.id) then
          jsonb_build_object('kind', 'venue', 'id', v.id, 'name', v.name, 'neighborhood', v.neighborhood, 'isDemo', v.is_demo)
        end
        from public.venues v
        left join lateral (select * from app.visible_listing_for_venue(v.id) y where y.id is not null) l on true
       where v.id = p_venue)
    else (
      select jsonb_build_object(
               'kind', fi.kind, 'id', fi.id, 'name', r.name, 'isDemo', fi.is_demo,
               'venueId', ve.id, 'venueName', ve.name,
               'eligibility', app.eligibility(r.id, p_diet, p_exclusions, p_include_conditional))
        from public.food_items fi
        join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
        left join public.dishes d on d.food_item_id = fi.id
        left join public.venues ve on ve.id = d.venue_id
       where fi.id = p_food and fi.visibility = 'public' and fi.status = 'published'
         and fi.kind in ('dish', 'recipe', 'packaged') and (p_include_demo or not fi.is_demo))
  end;
$$;

-- A published ranking shows a real place only while the viewer may see it.
create or replace function app.ranking_entries_json(p_snapshot jsonb, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('position', x.ord, 'venueId', v.id, 'name', coalesce(l.name, v.name),
                                               'neighborhood', coalesce(l.area, v.neighborhood), 'isDemo', v.is_demo,
                                               'placeSlug', l.slug) order by x.ord), '[]'::jsonb)
    from jsonb_array_elements_text(p_snapshot) with ordinality as x(venue_id, ord)
    join public.venues v on v.id = x.venue_id::uuid
    left join lateral (select * from app.visible_listing_for_venue(v.id) y where y.id is not null) l on true
   where (l.id is not null)
      or (v.status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not v.is_demo)
          and not exists (select 1 from public.place_listings z where z.venue_id = v.id));
$$;

-- Saved things: the same as before, plus 'places' (saved real places the member may still see).
create or replace function public.my_saves(p_include_demo boolean default false, p_diet text default 'none', p_exclusions text[] default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  return jsonb_build_object(
    'foods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'foodItemId', fi.id, 'revisionId', r.id, 'kind', fi.kind,
        'name', r.name, 'brand', r.brand, 'isDemo', fi.is_demo,
        'venue', (select jsonb_build_object('id', v.id, 'name', v.name, 'neighborhood', v.neighborhood)
                    from public.dishes d join public.venues v on v.id = d.venue_id where d.food_item_id = fi.id),
        'protein', app.protein_facts(r.id, false),
        -- Strict reading: a dish that fits only with a change is reported as 'conditional', never as a plain match.
        'eligibility', app.eligibility(r.id, coalesce(p_diet, 'none'), coalesce(p_exclusions, '{}'), false)) order by s.created_at desc, s.id)
      from public.saves s
      join public.food_items fi on fi.id = s.food_item_id and fi.visibility = 'public' and fi.status = 'published'
                               and (p_include_demo or not fi.is_demo)
      join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
      where s.owner_id = v_uid), '[]'::jsonb),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'id', v.id, 'name', v.name, 'neighborhood', v.neighborhood,
        'locality', v.locality, 'cuisines', to_jsonb(v.cuisines), 'priceBand', v.price_band, 'isDemo', v.is_demo)
        order by s.created_at desc, s.id)
      from public.saves s
      join public.venues v on v.id = s.venue_id and v.status in ('published', 'temporarily_closed')
                          and (p_include_demo or not v.is_demo)
      where s.owner_id = v_uid), '[]'::jsonb),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'venueId', l.venue_id, 'slug', l.slug, 'name', l.name, 'area', l.area,
        'street', l.street, 'category', l.category, 'menuStatus', l.menu_status) order by s.created_at desc, s.id)
      from public.saves s
      join public.place_listings l on l.venue_id = s.venue_id and app.place_visible(l, true)
      where s.owner_id = v_uid), '[]'::jsonb),
    'total', (select count(*) from public.saves s where s.owner_id = v_uid));
end;
$$;
revoke execute on function public.my_saves(boolean, text, text[]) from public, anon, authenticated;
grant execute on function public.my_saves(boolean, text, text[]) to authenticated;

-- The app place record of a real place, for a visitor who may see the place (a guest included, once public
-- listings exist): null until someone has saved, rated or listed it.
create function public.place_venue(p_slug text, p_preview boolean default false)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare l public.place_listings;
begin
  select * into l from public.place_listings where slug = p_slug;
  if not found or not app.place_visible(l, p_preview) then return null; end if;
  return l.venue_id;
end $$;
revoke all on function public.place_venue(text, boolean) from public;
grant execute on function public.place_venue(text, boolean) to anon, authenticated;

-- Old /venues/<id> links (feeds, rankings, lists) to a linked venue find their place page.
create function public.place_slug_for_venue(p_venue uuid)
returns text language sql stable security definer set search_path = '' as $$
  select (app.visible_listing_for_venue(p_venue)).slug;
$$;
revoke all on function public.place_slug_for_venue(uuid) from public;
grant execute on function public.place_slug_for_venue(uuid) to anon, authenticated;

-- Rollback (local database): drop the functions place_venue, place_slug_for_venue, place_link_venue,
-- app.visible_listing_for_venue, app.linked_place_visible, app.listing_venue_type, the two triggers and their
-- functions; restore venues_read, app.social_target, app.ranking_entries_json and public.my_saves from
-- 20261113000400, 20261114000400 and 20261115000100; delete saves, reviews, ranking entries and list items on
-- linked venues, then the linked venues, then drop place_listings.venue_id.
