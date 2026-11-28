-- Community evidence (owner directive 24 Nov 2026 14:59 UTC, priority 2B). A member can suggest a missing restaurant,
-- a missing vegetarian or vegan dish, a menu correction, dietary information, ingredients, a price or a nutrition
-- source, each with where it came from. A suggestion is a LEAD for research: it never becomes a restaurant fact, a
-- dietary claim, a verified meal or a published record by itself. Only the founder reviews suggestions, and a review
-- only records what happened to the lead (useful lead, needs more, not used); facts still go through the existing
-- source, confirmation and publication steps.
--
--   * public.community_submissions: one suggestion, linked where possible to a real place listing and/or drafted dish.
--     The contributor reads, edits (while still submitted) and withdraws only their own; their rows are removed with
--     their account (foreign key). Attribution is by contributor code (a one-way hash), never email or name.
--   * Switch app.platform_switches 'community_submissions' (off): while off, only the founder can submit (to test
--     the flow). Turning it on is a release decision that needs the owner's recorded approval.
--   * Limits: 10 suggestions per member per day; text fields are short; a web address must be http(s).
--   * Menu photos are listed as a kind so the record can grow into it, but are refused for now: storing photos needs
--     a storage policy and a rights check that are not built yet.
-- Rollback: drop the five functions and the table, and remove the switch row and its name from the check.

alter table app.platform_switches drop constraint platform_switches_name_check;
alter table app.platform_switches add constraint platform_switches_name_check
  check (name in ('social_public', 'real_catalog_entry', 'pilot_publication', 'real_place_listings', 'community_submissions'));
insert into app.platform_switches (name, enabled) values ('community_submissions', false) on conflict (name) do nothing;

create function public.community_submission_valid(p_kind text, d jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(d) = 'object', false)
     -- Fields any kind may carry, each short.
     and coalesce(length(d ->> 'note'), 0) <= 500
     and coalesce(length(d ->> 'dish'), 0) <= 200
     and coalesce(length(d ->> 'quote'), 0) <= 300
     and (not d ? 'url' or ((d ->> 'url') ~ '^https?://[^\s]{3,}$' and length(d ->> 'url') <= 500))
     and (not d ? 'source' or d ->> 'source' in ('restaurant_website', 'printed_menu', 'asked_staff', 'restaurant_social', 'packaging', 'other'))
     and (not d ? 'seenOn' or ((d ->> 'seenOn') ~ '^\d{4}-\d{2}-\d{2}$' and (d ->> 'seenOn')::date between date '2020-01-01' and current_date + 1))
     and (select count(*) from jsonb_object_keys(d) k
           where k not in ('name', 'street', 'area', 'website', 'dish', 'diet', 'quote', 'ingredients', 'price', 'protein', 'unit',
                           'url', 'source', 'seenOn', 'note', 'field', 'wrong', 'right')) = 0
     and case p_kind
       when 'missing_restaurant' then
             length(btrim(coalesce(d ->> 'name', ''))) between 2 and 120
         and coalesce(length(d ->> 'street'), 0) <= 160 and coalesce(length(d ->> 'area'), 0) <= 80
         and (not d ? 'website' or ((d ->> 'website') ~ '^https?://[^\s]{3,}$' and length(d ->> 'website') <= 300))
       when 'missing_dish' then
             length(btrim(coalesce(d ->> 'dish', ''))) between 2 and 200
         and (not d ? 'diet' or d ->> 'diet' in ('vegan', 'vegetarian', 'not_stated'))
         and d ? 'source'
       when 'menu_correction' then
             d ->> 'field' in ('name', 'description', 'section', 'available', 'other')
         and length(btrim(coalesce(d ->> 'right', ''))) between 1 and 300 and coalesce(length(d ->> 'wrong'), 0) <= 300
         and d ? 'source'
       when 'diet_info' then
             d ->> 'diet' in ('vegan', 'vegetarian', 'egg_free', 'dairy_free', 'contains_egg', 'contains_dairy', 'contains_meat_or_fish')
         and length(btrim(coalesce(d ->> 'quote', ''))) between 3 and 300
         and d ? 'source'
       when 'ingredients' then
             length(btrim(coalesce(d ->> 'ingredients', ''))) between 3 and 1000
         and d ? 'source'
       when 'price' then
             (d ->> 'price') ~ '^\d{1,4}(\.\d{2})?$' and (d ->> 'price')::numeric between 0.5 and 1000
         and d ? 'source'
       when 'nutrition_source' then
             d ? 'url' and (not d ? 'protein' or ((d ->> 'protein') ~ '^\d{1,3}(\.\d)?$'))
         and (not d ? 'unit' or d ->> 'unit' in ('per_serving', 'per_100g'))
       else false end;
$$;
revoke all on function public.community_submission_valid(text, jsonb) from public, anon, authenticated;

create table public.community_submissions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  kind           text not null check (kind in ('missing_restaurant', 'missing_dish', 'menu_correction', 'diet_info',
                                               'ingredients', 'price', 'nutrition_source', 'menu_photo')),
  listing_id     uuid references public.place_listings (id) on delete set null,
  dish_id        uuid references staging.dishes (id) on delete set null,
  details        jsonb not null,
  -- The contributor agreed that the platform may use the suggestion as a research lead and that it is their own
  -- observation or a link, not copied text or photos they have no right to share.
  agreed_terms   text not null check (agreed_terms = 'community-evidence-v1'),
  status         text not null default 'submitted'
                 check (status in ('submitted', 'useful_lead', 'needs_more', 'not_used', 'withdrawn')),
  review_note    text check (length(review_note) <= 500),
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint community_submissions_details_valid check (kind = 'menu_photo' or public.community_submission_valid(kind, details)),
  constraint community_submissions_no_photo_yet check (kind <> 'menu_photo'),
  constraint community_submissions_needs_target check (kind = 'missing_restaurant' or listing_id is not null)
);
create index community_submissions_user on public.community_submissions (user_id, created_at desc);
create index community_submissions_status on public.community_submissions (status, created_at);
create index community_submissions_listing on public.community_submissions (listing_id) where listing_id is not null;
alter table public.community_submissions enable row level security;
alter table public.community_submissions force row level security;
revoke all on public.community_submissions from public, anon, authenticated;
grant select on public.community_submissions to authenticated;
create policy community_submissions_own_read on public.community_submissions for select to authenticated
  using (user_id = (select auth.uid()));
create policy community_submissions_definer on public.community_submissions for all to postgres using (true) with check (true);

create function public.community_contributor_code(p_user uuid)
returns text language sql immutable set search_path = '' as $$
  select substr(encode(extensions.digest('vfp-contributor:' || p_user::text, 'sha256'), 'hex'), 1, 6);
$$;
revoke all on function public.community_contributor_code(uuid) from public, anon, authenticated;

-- May the signed-in person suggest at all? Members only once the switch is on; the founder always (to test it).
create function public.community_submissions_open()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
     and (app.has_role('publisher') or coalesce((select w.enabled from app.platform_switches w where w.name = 'community_submissions'), false));
$$;
revoke all on function public.community_submissions_open() from public, anon;
grant execute on function public.community_submissions_open() to authenticated;

-- Send one suggestion. The listing must be a real place listing (any visibility the person may already see is
-- not widened: only its id is stored), and a dish must belong to that listing's place.
create function public.community_submit(p_kind text, p_listing uuid, p_dish uuid, p_details jsonb, p_terms text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
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

-- The contributor withdraws their own suggestion (kept as withdrawn so a review in progress is not lost).
create function public.community_withdraw(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  perform 1 from public.community_submissions s where s.id = p_id and s.user_id = auth.uid() for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  update public.community_submissions set status = 'withdrawn', updated_at = now()
   where id = p_id and status in ('submitted', 'needs_more');
end;
$$;
revoke all on function public.community_withdraw(uuid) from public, anon;
grant execute on function public.community_withdraw(uuid) to authenticated;

-- The founder's queue: newest first within each status, with the place and dish names, the contributor's code and
-- how many suggestions point at the same place (a sign of where coverage is wanted).
create function public.community_queue()
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

-- The founder records what happened to one lead. This changes nothing else: no fact, dish, diet, price or
-- publication state is touched here.
create function public.community_review(p_id uuid, p_status text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_founder();
  if p_status not in ('useful_lead', 'needs_more', 'not_used') then raise exception 'INVALID_STATUS' using errcode = 'PT422'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'NOTE_TOO_LONG' using errcode = 'PT422'; end if;
  if not exists (select 1 from public.community_submissions where id = p_id and status <> 'withdrawn') then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  update public.community_submissions
     set status = p_status, review_note = nullif(btrim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = p_id;
end;
$$;
revoke all on function public.community_review(uuid, text, text) from public, anon;
grant execute on function public.community_review(uuid, text, text) to authenticated;
