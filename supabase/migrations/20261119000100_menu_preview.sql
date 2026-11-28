-- Founder-only private beta on real data (owner direction 19 Nov 2026 01:08 UTC, docs/59).
--
--   1. A third way to tie a researched restaurant profile to its real catalog place: the website
--      match. The menu page the research read lives on the same website that the open place data
--      (Overture) records for exactly one catalog place, and the names share a distinctive word.
--      A file host (a PDF on a menu platform's CDN) never counts, and a website shared by several
--      catalog places (a chain with several branches) is refused, so no branch is guessed.
--   2. public.menu_preview_index(): the founder's list of linked profiles and their catalog place,
--      so Discover, place pages and Protein Explorer can show the drafted menus as an "Unverified
--      preview". Only the founder can call it; ordinary accounts and visitors get FOUNDER_ONLY or no
--      access at all. It returns no menu facts: those come from menu_review_place, which is already
--      founder-only. Nothing here publishes, confirms or verifies anything.

alter table staging.catalog_links drop constraint catalog_links_method_check;
alter table staging.catalog_links add constraint catalog_links_method_check
  check (method in ('address_match', 'website_match', 'person'));
alter table staging.catalog_links drop constraint catalog_links_check1;
alter table staging.catalog_links add constraint catalog_links_check1
  check (action = 'link' and method in ('address_match', 'website_match') or note is not null);

-- Hosts that serve files for many restaurants (menu PDFs, images): never evidence of whose website it is.
create function staging.is_file_host(p_host text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_host in ('images.getbento.com', 'media-cdn.getbento.com', 'a.storyblok.com'), false)
      or coalesce(p_host ~ '(^|\.)(cloudfront\.net|amazonaws\.com|squarespace-cdn\.com|wixstatic\.com|googleusercontent\.com)$', false);
$$;
revoke all on function staging.is_file_host(text) from public, anon, authenticated;

-- The websites a candidate's open-data records name, without "www.".
create function staging.candidate_hosts(p_candidate uuid)
returns setof text language sql stable set search_path = '' as $$
  select distinct staging.url_host(r.website)
    from catalog_import.candidate_links l join catalog_import.source_records r on r.id = l.record_id
   where l.candidate_id = p_candidate and r.website is not null and staging.url_host(r.website) is not null;
$$;
revoke all on function staging.candidate_hosts(uuid) from public, anon, authenticated;

create or replace function staging.link_catalog(p_actor uuid, p_place uuid, p_candidate uuid, p_method text, p_note text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_addr record;
  v_cand record;
  v_host text;
  v_sharing int;
  v_id bigint;
begin
  if p_method = 'person' then
    perform staging.require_role(p_actor, 'publisher');
    if p_note is null then raise exception 'LINK_NOTE_REQUIRED' using errcode = 'PT400'; end if;
  elsif p_method in ('address_match', 'website_match') then
    if not (staging.actor_has_role(p_actor, 'curator') or staging.actor_has_role(p_actor, 'publisher')) then
      raise exception 'Only a curator or the publisher may link a profile' using errcode = 'PT403';
    end if;
  else
    raise exception 'LINK_METHOD_UNKNOWN' using errcode = 'PT400', detail = p_method;
  end if;
  if not exists (select 1 from staging.places where id = p_place) then raise exception 'STAGING_PLACE_UNKNOWN' using errcode = 'PT404'; end if;
  select id, name, street, postcode, quality into v_cand from catalog_import.place_candidates where id = p_candidate;
  if not found then raise exception 'CANDIDATE_UNKNOWN' using errcode = 'PT404'; end if;
  if v_cand.quality = 'rejected' then raise exception 'CANDIDATE_REJECTED' using errcode = 'PT409'; end if;
  if exists (select 1 from staging.live_catalog_links where staging_place = p_place) then
    raise exception 'PROFILE_ALREADY_LINKED' using errcode = 'PT409';
  end if;
  if exists (select 1 from staging.live_catalog_links where candidate_id = p_candidate) then
    raise exception 'PLACE_ALREADY_LINKED' using errcode = 'PT409';
  end if;

  select f.id, f.value ->> 'street' as street, f.value ->> 'postcode' as postcode into v_addr
    from staging.facts f
   where f.place_id = p_place and f.kind = 'address' and not f.is_unknown and f.status in ('submitted', 'verified')
   order by f.entered_at desc limit 1;
  if p_method = 'address_match' then
    if v_addr.id is null then raise exception 'NO_ADDRESS_FACT' using errcode = 'PT409'; end if;
    if staging.address_key(v_addr.street, v_addr.postcode) is null
       or staging.address_key(v_addr.street, v_addr.postcode) is distinct from staging.address_key(v_cand.street, v_cand.postcode) then
      raise exception 'ADDRESS_MISMATCH' using errcode = 'PT409',
        detail = format('%s %s vs %s %s', v_addr.street, v_addr.postcode, v_cand.street, v_cand.postcode);
    end if;
  elsif p_method = 'website_match' then
    -- A website the research read for this profile (not demo, not a file host) that the candidate's
    -- open-data records also name.
    select h into v_host
      from (select distinct staging.url_host(s.url) h
              from staging.source_pages s
             where not s.is_demo and s.id in (select f.source_page_id from staging.facts f where f.place_id = p_place)) staged
     where h is not null and not staging.is_file_host(h) and h in (select staging.candidate_hosts(p_candidate))
     order by h limit 1;
    if v_host is null then raise exception 'WEBSITE_MISMATCH' using errcode = 'PT409', detail = v_cand.name; end if;
    select count(*) into v_sharing
      from catalog_import.place_candidates c
     where c.quality <> 'rejected' and v_host in (select staging.candidate_hosts(c.id));
    if v_sharing <> 1 then
      raise exception 'WEBSITE_SHARED' using errcode = 'PT409',
        detail = format('%s is named by %s catalog places; link by address or by the founder', v_host, v_sharing);
    end if;
  end if;
  if p_method in ('address_match', 'website_match') then
    -- Many places share an address (food courts, office towers): the names must agree too.
    if not staging.names_share_word((select label from staging.places where id = p_place), v_cand.name) then
      raise exception 'NAME_MISMATCH' using errcode = 'PT409', detail = v_cand.name;
    end if;
  end if;

  insert into staging.catalog_links (staging_place, candidate_id, action, method, evidence, note, actor_id)
  values (p_place, p_candidate, 'link', p_method,
          jsonb_strip_nulls(jsonb_build_object('addressFact', v_addr.id, 'stagedStreet', v_addr.street, 'stagedPostcode', v_addr.postcode,
                             'website', v_host,
                             'candidateName', v_cand.name, 'candidateStreet', v_cand.street, 'candidatePostcode', v_cand.postcode)),
          p_note, p_actor)
  returning id into v_id;
  insert into staging.events (actor_id, action, place_id, detail)
  values (p_actor, 'link_catalog', p_place, jsonb_build_object('candidateId', p_candidate, 'method', p_method, 'linkId', v_id));
  return v_id;
end;
$$;
revoke all on function staging.link_catalog(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- The founder's list of linked, researched profiles and the catalog place each belongs to. Demo
-- profiles never appear. Only places in the founder-only preview listing are returned, so nothing
-- here can surface a place the catalog itself keeps out.
create function public.menu_preview_index()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'placeId', p.id, 'label', p.label,
             'listingId', pl.id, 'slug', pl.slug, 'name', pl.name, 'street', pl.street, 'area', pl.area,
             'lat', pl.lat, 'lon', pl.lon, 'cuisines', pl.cuisines,
             'linkMethod', k.method, 'linkedAt', k.at)
           order by pl.name)
      from staging.live_catalog_links k
      join staging.places p on p.id = k.staging_place
      join public.place_listings pl on pl.candidate_id = k.candidate_id
     where not exists (select 1 from staging.facts f join staging.source_pages s on s.id = f.source_page_id
                        where f.place_id = p.id and s.is_demo)), '[]'::jsonb);
end;
$$;
revoke all on function public.menu_preview_index() from public, anon;
grant execute on function public.menu_preview_index() to authenticated;

-- The founder's saved meals in the private preview. A saved meal is a drafted staging dish, so it stays
-- in the staging area with everything else that is private: no catalog row, no public object, nothing a
-- friend or visitor can read. Only the founder can save, unsave or list, and only their own saves.
create table staging.preview_saves (
  user_id  uuid not null references auth.users (id) on delete cascade,
  dish_id  uuid not null references staging.dishes (id),
  saved_at timestamptz not null default now(),
  primary key (user_id, dish_id)
);
alter table staging.preview_saves enable row level security;
alter table staging.preview_saves force row level security;
revoke all on staging.preview_saves from public, anon, authenticated;
create policy preview_saves_owner on staging.preview_saves for all to postgres using (true) with check (true);

create function public.menu_preview_save(p_dish uuid, p_saved boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  if not exists (select 1 from staging.dishes where id = p_dish) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_saved then
    insert into staging.preview_saves (user_id, dish_id) values (auth.uid(), p_dish) on conflict do nothing;
  else
    delete from staging.preview_saves where user_id = auth.uid() and dish_id = p_dish;
  end if;
  return jsonb_build_object('dishId', p_dish, 'saved', p_saved);
end;
$$;
revoke all on function public.menu_preview_save(uuid, boolean) from public, anon;
grant execute on function public.menu_preview_save(uuid, boolean) to authenticated;

create function public.menu_preview_saved()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  return coalesce((select jsonb_agg(s.dish_id order by s.saved_at desc) from staging.preview_saves s where s.user_id = auth.uid()), '[]'::jsonb);
end;
$$;
revoke all on function public.menu_preview_saved() from public, anon;
grant execute on function public.menu_preview_saved() to authenticated;

-- Rollback: drop public.menu_preview_saved, public.menu_preview_save, staging.preview_saves (the founder's preview saves), public.menu_preview_index, staging.candidate_hosts and staging.is_file_host; re-run
-- staging.link_catalog from 20261117000800. catalog_links is append-only, so the method check keeps
-- 'website_match' once any such link has been recorded (unlink those first, then restore the checks).
