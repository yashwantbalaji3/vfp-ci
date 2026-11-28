-- Community contributions v2 (owner directive 25 Nov 2026 04:01 UTC, section 3.2). Builds on 20261124000300 and
-- 20261124000600; no new disconnected model.
--
--   * Three more kinds of suggestion:
--       branch_correction     the listing's branch details are wrong (address, closed, moved, other)
--       duplicate_restaurant  this listing is the same restaurant as another listing (named in "right")
--       stale_menu            the menu we hold is out of date (what changed goes in the note)
--   * public.community_review_events: an append-only history of every status change (submitted, reviewed,
--     withdrawn), with who and when. A row is never updated or deleted (guard trigger). Founder-only.
--     The suggestion's own review_note / reviewed_by / reviewed_at still hold the latest review for display.
--   * community_queue adds, for the founder only:
--       history              that suggestion's events, oldest first
--       current              for a suggestion about a dish: what our drafted facts say now (diet claims, price,
--                            whether ingredients are listed)
--       conflicts            where the suggestion disagrees with those facts (for example "says vegan" against a
--                            drafted "vegan: no", or a different price)
--       publicationEligible  always false: a suggestion is a lead and is never published or turned into a fact here
--   * The switch 'community_submissions' stays OFF. Nothing here changes a fact, dish, listing or publication state.
--
-- Rollback: drop the guard trigger and function, public.community_review_events; restore
-- community_submission_valid, community_submit, community_withdraw, community_review and community_queue from
-- 20261124000300/20261124000600 (create or replace with those bodies); restore the kind check without the three
-- new kinds (only after deleting or exporting rows of those kinds).

alter table public.community_submissions drop constraint community_submissions_kind_check;
alter table public.community_submissions add constraint community_submissions_kind_check
  check (kind in ('missing_restaurant', 'missing_dish', 'menu_correction', 'diet_info', 'ingredients', 'price',
                  'nutrition_source', 'menu_photo', 'branch_correction', 'duplicate_restaurant', 'stale_menu'));

create or replace function public.community_submission_valid(p_kind text, d jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(d) = 'object', false)
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
       when 'branch_correction' then
             d ->> 'field' in ('address', 'closed', 'moved', 'other')
         and length(btrim(coalesce(d ->> 'right', ''))) between 2 and 300 and coalesce(length(d ->> 'wrong'), 0) <= 300
         and d ? 'source'
       when 'duplicate_restaurant' then
             length(btrim(coalesce(d ->> 'right', ''))) between 2 and 200
       when 'stale_menu' then
             length(btrim(coalesce(d ->> 'note', ''))) between 3 and 500
         and d ? 'source'
       else false end;
$$;
revoke all on function public.community_submission_valid(text, jsonb) from public, anon, authenticated;

create table public.community_review_events (
  id            bigint generated always as identity primary key,
  submission_id uuid not null references public.community_submissions (id) on delete cascade,
  from_status   text,
  to_status     text not null check (to_status in ('submitted', 'useful_lead', 'needs_more', 'not_used', 'withdrawn')),
  note          text check (length(note) <= 500),
  -- 'contributor' or 'founder': who acted, without storing the person (the contributor is already on the suggestion).
  actor_role    text not null check (actor_role in ('contributor', 'founder')),
  actor         uuid references auth.users (id) on delete set null,
  at            timestamptz not null default clock_timestamp()
);
create index community_review_events_submission on public.community_review_events (submission_id, at);
alter table public.community_review_events enable row level security;
alter table public.community_review_events force row level security;
revoke all on public.community_review_events from public, anon, authenticated;
create policy community_review_events_definer on public.community_review_events for all to postgres using (true) with check (true);

-- Append-only, except the cascade when a contributor's account (and so their suggestion) is deleted.
create function app.guard_community_review_event()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.community_submissions s where s.id = old.submission_id) then
    return old;
  end if;
  if tg_op = 'UPDATE' and old.actor is not null and new.actor is null and new.id = old.id
     and new.to_status = old.to_status and new.from_status is not distinct from old.from_status
     and new.note is not distinct from old.note and new.at = old.at then
    return new; -- the reviewer's account was deleted (on delete set null)
  end if;
  raise exception 'RECORD_IMMUTABLE' using errcode = 'PT409';
end $$;
revoke all on function app.guard_community_review_event() from public, anon, authenticated;
create trigger community_review_events_guard before update or delete on public.community_review_events
  for each row execute function app.guard_community_review_event();

-- Existing suggestions get their history started from what is on record.
insert into public.community_review_events (submission_id, from_status, to_status, actor_role, actor, at)
select s.id, null, 'submitted', 'contributor', s.user_id, s.created_at from public.community_submissions s;
insert into public.community_review_events (submission_id, from_status, to_status, note, actor_role, actor, at)
select s.id, 'submitted', s.status, s.review_note, 'founder', s.reviewed_by, s.reviewed_at
  from public.community_submissions s where s.reviewed_at is not null and s.status in ('useful_lead', 'needs_more', 'not_used');

-- Submit: unchanged rules (20261124000600), plus the first history event.
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
  insert into public.community_review_events (submission_id, from_status, to_status, actor_role, actor)
  values (v_id, null, 'submitted', 'contributor', v_uid);
  return jsonb_build_object('id', v_id, 'status', 'submitted', 'contributor', public.community_contributor_code(v_uid));
end;
$$;
revoke all on function public.community_submit(text, uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.community_submit(text, uuid, uuid, jsonb, text) to authenticated;

create or replace function public.community_withdraw(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_from text;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  select s.status into v_from from public.community_submissions s where s.id = p_id and s.user_id = auth.uid() for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if v_from in ('submitted', 'needs_more') then
    update public.community_submissions set status = 'withdrawn', updated_at = now() where id = p_id;
    insert into public.community_review_events (submission_id, from_status, to_status, actor_role, actor)
    values (p_id, v_from, 'withdrawn', 'contributor', auth.uid());
  end if;
end;
$$;
revoke all on function public.community_withdraw(uuid) from public, anon;
grant execute on function public.community_withdraw(uuid) to authenticated;

create or replace function public.community_review(p_id uuid, p_status text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_from text;
begin
  perform app.require_founder();
  if p_status not in ('useful_lead', 'needs_more', 'not_used') then raise exception 'INVALID_STATUS' using errcode = 'PT422'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'NOTE_TOO_LONG' using errcode = 'PT422'; end if;
  select s.status into v_from from public.community_submissions s where s.id = p_id and s.status <> 'withdrawn' for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  update public.community_submissions
     set status = p_status, review_note = nullif(btrim(p_note), ''), reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   where id = p_id;
  insert into public.community_review_events (submission_id, from_status, to_status, note, actor_role, actor)
  values (p_id, v_from, p_status, nullif(btrim(p_note), ''), 'founder', auth.uid());
end;
$$;
revoke all on function public.community_review(uuid, text, text) from public, anon;
grant execute on function public.community_review(uuid, text, text) to authenticated;

-- What our drafted facts say now about one dish (not rejected, not unknown). Founder-only through the queue.
create or replace function app.community_dish_now(p_dish uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'diet', coalesce((select jsonb_object_agg(f.subject, f.value ->> 'status')
                        from staging.facts f
                       where f.dish_id = p_dish and f.kind = 'dietary_status' and f.status <> 'rejected' and not f.is_unknown), '{}'::jsonb),
    'price', (select f.value ->> 'usd' from staging.facts f
               where f.dish_id = p_dish and f.kind = 'price' and f.status <> 'rejected' and not f.is_unknown
               order by f.checked_on desc, f.entered_at desc limit 1),
    'ingredientsListed', exists (select 1 from staging.facts f where f.dish_id = p_dish and f.kind = 'listed_ingredients'
                                    and f.status <> 'rejected' and not f.is_unknown));
$$;
revoke all on function app.community_dish_now(uuid) from public, anon, authenticated;

-- Where a suggestion disagrees with the drafted facts. Each entry is a short code the page puts into words.
create or replace function app.community_conflicts(p_kind text, d jsonb, now_ jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(c) filter (where c is not null), '[]'::jsonb) from (values
    (case when p_kind = 'diet_info' and d ->> 'diet' in ('vegan', 'vegetarian') and now_ -> 'diet' ->> (d ->> 'diet') = 'no'
          then 'says_' || (d ->> 'diet') || '_menu_says_no' end),
    (case when p_kind = 'diet_info' and d ->> 'diet' in ('contains_egg', 'contains_dairy') and now_ -> 'diet' ->> 'vegan' = 'yes'
          then 'says_' || (d ->> 'diet') || '_menu_says_vegan' end),
    (case when p_kind = 'diet_info' and d ->> 'diet' = 'contains_meat_or_fish'
           and (now_ -> 'diet' ->> 'vegan' = 'yes' or now_ -> 'diet' ->> 'vegetarian' = 'yes')
          then 'says_meat_or_fish_menu_says_suitable' end),
    (case when p_kind = 'price' and now_ ->> 'price' is not null and (now_ ->> 'price')::numeric <> (d ->> 'price')::numeric
          then 'price_differs' end)
  ) v(c);
$$;
revoke all on function app.community_conflicts(text, jsonb, jsonb) from public, anon, authenticated;

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
             'current', n.now_,
             'conflicts', case when n.now_ is not null then app.community_conflicts(s.kind, s.details, n.now_) else '[]'::jsonb end,
             'publicationEligible', false,
             'history', (select coalesce(jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'note', e.note, 'by', e.actor_role, 'at', e.at)
                                                    order by e.at, e.id), '[]'::jsonb)
                           from public.community_review_events e where e.submission_id = s.id),
             'reviewNote', s.review_note, 'reviewedAt', s.reviewed_at, 'createdAt', s.created_at)
           order by (s.status = 'submitted') desc, s.created_at desc)
      from public.community_submissions s
      left join public.place_listings l on l.id = s.listing_id
      left join staging.dishes d on d.id = s.dish_id
      left join lateral (select app.community_dish_now(d.id) as now_ where d.id is not null) n on true
     where s.status <> 'withdrawn'), '[]'::jsonb);
end;
$$;
revoke all on function public.community_queue() from public, anon;
grant execute on function public.community_queue() to authenticated;
