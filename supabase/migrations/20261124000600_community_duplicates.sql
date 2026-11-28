-- Community suggestions: duplicate detection (owner decision 5, 24 Nov 2026 17:45 UTC).
--
-- The switch `community_submissions` stays OFF for members; nothing here turns it on.
--
--   * community_submit refuses ALREADY_SENT when the same person already has an open suggestion (submitted or needs
--     more) of the same kind about the same place and dish with the same details, or, for a missing restaurant or a
--     missing dish, the same name. One person cannot inflate a lead by sending it twice.
--   * community_queue adds, for the founder only:
--       duplicates     other open suggestions about the same thing (same kind and place and dish, or the same missing
--                      restaurant or dish name), counted across people;
--       alreadyListed  for "a restaurant we're missing": up to three directory listings with the same name (folded
--                      with app.search_key), so the founder sees at once when the restaurant is already there.
--   * An index on the folded listing name keeps that lookup fast with every market loaded.
-- Changes no fact, dish, listing, publication state or row.
--
-- Rollback: drop index public.place_listings_name_key; restore community_submit and community_queue from
-- 20261124000300 (create or replace with those bodies).

create index if not exists place_listings_name_key on public.place_listings (app.search_key(name));

-- The thing a suggestion is about, as one comparable key: kind, place, dish, and the folded name for missing items.
create or replace function app.community_subject(p_kind text, p_listing uuid, p_dish uuid, p_details jsonb)
returns text language sql immutable parallel safe set search_path = '' as $$
  select concat_ws('|', p_kind, coalesce(p_listing::text, '-'), coalesce(p_dish::text, '-'),
                   case when p_kind in ('missing_restaurant', 'missing_dish') then coalesce(app.search_key(coalesce(p_details->>'name', p_details->>'dish')), '-') else '-' end);
$$;
revoke all on function app.community_subject(text, uuid, uuid, jsonb) from public, anon, authenticated;

create or replace function public.community_submit(p_kind text, p_listing uuid, p_dish uuid, p_details jsonb, p_terms text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_subject text;
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not public.community_submissions_open() then raise exception 'NOT_OPEN' using errcode = 'PT403'; end if;
  if p_terms is distinct from 'community-evidence-v1' then raise exception 'TERMS_NOT_AGREED' using errcode = 'PT422'; end if;
  if p_kind = 'menu_photo' then raise exception 'PHOTOS_NOT_YET' using errcode = 'PT422'; end if;
  if not public.community_submission_valid(p_kind, p_details) then raise exception 'INVALID_SUGGESTION' using errcode = 'PT422'; end if;
  if p_kind <> 'missing_restaurant' and p_listing is null then raise exception 'PLACE_NEEDED' using errcode = 'PT422'; end if;
  if p_listing is not null and not exists (select 1 from public.place_listings l where l.id = p_listing) then
    raise exception 'UNKNOWN_PLACE' using errcode = 'PT422';
  end if;
  if p_dish is not null and not exists (
       select 1 from staging.dishes d
         join staging.live_catalog_links k on k.staging_place = d.place_id
         join public.place_listings l on l.candidate_id = k.candidate_id
        where d.id = p_dish and l.id = p_listing) then
    raise exception 'DISH_NOT_AT_PLACE' using errcode = 'PT422';
  end if;
  perform pg_advisory_xact_lock(hashtext('community:' || v_uid::text));
  v_subject := app.community_subject(p_kind, p_listing, p_dish, p_details);
  if exists (select 1 from public.community_submissions s
              where s.user_id = v_uid and s.status in ('submitted', 'needs_more')
                and (s.details = p_details and s.kind = p_kind and s.listing_id is not distinct from p_listing and s.dish_id is not distinct from p_dish
                     or (p_kind in ('missing_restaurant', 'missing_dish') and app.community_subject(s.kind, s.listing_id, s.dish_id, s.details) = v_subject))) then
    raise exception 'ALREADY_SENT' using errcode = 'PT409';
  end if;
  if (select count(*) from public.community_submissions where user_id = v_uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'TOO_MANY' using errcode = 'PT429';
  end if;
  insert into public.community_submissions (user_id, kind, listing_id, dish_id, details, agreed_terms)
  values (v_uid, p_kind, p_listing, p_dish, p_details, p_terms) returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', 'submitted', 'contributor', public.community_contributor_code(v_uid));
end;
$$;
revoke all on function public.community_submit(text, uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.community_submit(text, uuid, uuid, jsonb, text) to authenticated;

create or replace function public.community_queue()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'kind', s.kind, 'status', s.status, 'details', s.details,
             'contributor', public.community_contributor_code(s.user_id),
             'listing', case when l.id is not null then jsonb_build_object('id', l.id, 'slug', l.slug, 'name', l.name, 'street', l.street, 'area', l.area) end,
             'dish', case when d.id is not null then jsonb_build_object('id', d.id, 'label', d.label) end,
             'samePlace', (select count(*) from public.community_submissions o where o.listing_id = s.listing_id and o.status <> 'withdrawn'),
             'duplicates', (select count(*) from public.community_submissions o
                             where o.id <> s.id and o.status in ('submitted', 'needs_more', 'useful_lead')
                               and app.community_subject(o.kind, o.listing_id, o.dish_id, o.details) = app.community_subject(s.kind, s.listing_id, s.dish_id, s.details)),
             'alreadyListed', case when s.kind = 'missing_restaurant' then coalesce((
                 select jsonb_agg(jsonb_build_object('slug', x.slug, 'name', x.name, 'street', x.street, 'market', x.market_slug) order by x.name)
                   from (select m.slug, m.name, m.street, m.market_slug from public.place_listings m
                          where app.search_key(m.name) = app.search_key(s.details->>'name') and m.visibility <> 'withdrawn'
                          order by m.name limit 3) x), '[]'::jsonb) end,
             'reviewNote', s.review_note, 'reviewedAt', s.reviewed_at, 'createdAt', s.created_at)
           order by (s.status = 'submitted') desc, s.created_at desc)
      from public.community_submissions s
      left join public.place_listings l on l.id = s.listing_id
      left join staging.dishes d on d.id = s.dish_id
     where s.status <> 'withdrawn'), '[]'::jsonb);
end;
$$;
revoke all on function public.community_queue() from public, anon;
grant execute on function public.community_queue() to authenticated;
