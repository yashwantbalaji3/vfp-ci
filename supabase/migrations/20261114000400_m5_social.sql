-- ============================================================================
-- M5 · Social: profiles, blocks, following, friendships, reviews, rankings,
-- lists, feeds, recommendations, reports and moderation (R-S01 to R-S10, docs/18).
--
-- Rules that shape everything below:
--   * No social table has a column that points at a diary entry, snapshot, goal,
--     own food, cook session, meal plan or preference. Nothing here reads them,
--     except the member's own dietary filter, which is applied to what THEY see
--     and shown on their profile only if they switch that on.
--   * Members never write these tables directly. Every change goes through a
--     checked function that takes the acting member from the verified session.
--   * Every read applies, in this order: block, audience, publication state,
--     then the reader's dietary rule.
--   * A new account's first public post waits for a moderator. Pending and
--     removed content is never shown to others and never counts in an average.
--   * Demo members and their content appear only when demo content is enabled,
--     and never count toward real averages.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Profiles (extends M1 profiles_public). Dietary and taste details stay
--    private unless the member switches them on.
-- ---------------------------------------------------------------------------
alter table public.profiles_public
  add column bio text check (bio is null or length(bio) <= 300),
  add column taste_tags text[] not null default '{}' check (cardinality(taste_tags) <= 8),
  add column show_tastes boolean not null default false,
  add column show_diet boolean not null default false,
  add column updated_at timestamptz not null default now();

-- The old policy let the owner write any column directly. Writes now go through
-- save_my_profile(); the owner can still read their own row.
drop policy profiles_owner_all on public.profiles_public;
create policy profiles_owner_read on public.profiles_public
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.profiles_public from authenticated;

-- Facts about a member that the member must not be able to edit.
create table public.member_standing (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  first_public_approved_at timestamptz,
  profile_hidden_at        timestamptz,
  is_demo                  boolean not null default false
);

-- Small log used only for rate limits. Holds no content.
create table public.social_action_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  action  text not null check (length(action) between 1 and 40),
  at      timestamptz not null default now()
);
create index social_action_log_idx on public.social_action_log (user_id, action, at);

-- ---------------------------------------------------------------------------
-- 2. Relationships. Three separate things: block, follow (one-way, public
--    content only) and friendship (two-way, unlocks "friends" content only).
-- ---------------------------------------------------------------------------
create table public.blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocked_idx on public.blocks (blocked_id);

create table public.follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  followed_id uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);
create index follows_followed_idx on public.follows (followed_id);

create table public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  state        text not null default 'pending' check (state in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  check (requester_id <> recipient_id),
  check ((state = 'accepted') = (accepted_at is not null))
);
-- One row per pair of people, whichever of them asked.
create unique index friendships_pair_idx
  on public.friendships (least(requester_id, recipient_id), greatest(requester_id, recipient_id));
create index friendships_recipient_idx on public.friendships (recipient_id, state);
create index friendships_requester_idx on public.friendships (requester_id, state);

-- ---------------------------------------------------------------------------
-- 3. Reviews. A review is about exactly one restaurant OR one dish; the two
--    kinds of rating are never mixed. Audience (who may see it) and publication
--    state (draft, pending, visible, removed) are separate fields.
--    A later milestone can attach photos, comments or reactions by adding tables
--    that reference reviews.id; nothing here needs to change for that.
-- ---------------------------------------------------------------------------
create table public.reviews (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid not null references auth.users (id) on delete cascade,
  venue_id          uuid references public.venues (id) on delete cascade,
  food_item_id      uuid references public.food_items (id) on delete cascade,
  rating            smallint not null check (rating between 1 and 5),
  body              text check (body is null or length(body) between 1 and 2000),
  visit_date        date,
  audience          text not null default 'private' check (audience in ('private', 'friends', 'public')),
  publication_state text not null default 'draft' check (publication_state in ('draft', 'pending', 'visible', 'removed')),
  needs_review      boolean not null default false,
  version           integer not null default 1 check (version >= 1),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  published_at      timestamptz,
  check ((venue_id is null) <> (food_item_id is null)),
  -- A private review is a draft; a draft is always private.
  check ((audience = 'private') = (publication_state = 'draft') or publication_state = 'removed')
);
create unique index reviews_author_venue_idx on public.reviews (author_id, venue_id) where venue_id is not null;
create unique index reviews_author_food_idx on public.reviews (author_id, food_item_id) where food_item_id is not null;
create index reviews_venue_idx on public.reviews (venue_id) where venue_id is not null;
create index reviews_food_idx on public.reviews (food_item_id) where food_item_id is not null;
create index reviews_feed_idx on public.reviews (author_id, published_at desc) where publication_state = 'visible';

create table public.review_revisions (
  review_id   uuid not null references public.reviews (id) on delete cascade,
  revision_no integer not null check (revision_no >= 1),
  rating      smallint not null,
  body        text,
  visit_date  date,
  audience    text not null,
  created_at  timestamptz not null default now(),
  primary key (review_id, revision_no)
);

-- ---------------------------------------------------------------------------
-- 4. Personal restaurant ranking: a private order, plus fixed published copies.
-- ---------------------------------------------------------------------------
create table public.ranking_entries (
  owner_id uuid not null references auth.users (id) on delete cascade,
  venue_id uuid not null references public.venues (id) on delete cascade,
  position integer not null check (position between 1 and 200),
  primary key (owner_id, venue_id),
  constraint ranking_entries_position_key unique (owner_id, position) deferrable initially deferred
);

create table public.ranking_publications (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  snapshot          jsonb not null check (jsonb_typeof(snapshot) = 'array'),
  publication_state text not null check (publication_state in ('pending', 'visible', 'removed')),
  published_at      timestamptz not null default now(),
  withdrawn_at      timestamptz
);
create index ranking_publications_owner_idx on public.ranking_publications (owner_id, published_at desc);

-- ---------------------------------------------------------------------------
-- 5. Lists: ordered collections of restaurants, dishes and recipes.
-- ---------------------------------------------------------------------------
create table public.food_lists (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  title             text not null check (length(title) between 1 and 80),
  description       text check (description is null or length(description) between 1 and 500),
  visibility        text not null default 'private' check (visibility in ('private', 'public')),
  publication_state text not null default 'draft' check (publication_state in ('draft', 'pending', 'visible', 'removed')),
  needs_review      boolean not null default false,
  is_editorial      boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  published_at      timestamptz,
  check ((visibility = 'private') = (publication_state = 'draft') or publication_state = 'removed')
);
create index food_lists_owner_idx on public.food_lists (owner_id, updated_at desc);

create table public.food_list_items (
  id           uuid primary key default gen_random_uuid(),
  list_id      uuid not null references public.food_lists (id) on delete cascade,
  venue_id     uuid references public.venues (id) on delete cascade,
  food_item_id uuid references public.food_items (id) on delete cascade,
  position     integer not null check (position between 1 and 100),
  note         text check (note is null or length(note) between 1 and 200),
  check ((venue_id is null) <> (food_item_id is null)),
  constraint food_list_items_position_key unique (list_id, position) deferrable initially deferred
);
create unique index food_list_items_venue_idx on public.food_list_items (list_id, venue_id) where venue_id is not null;
create unique index food_list_items_food_idx on public.food_list_items (list_id, food_item_id) where food_item_id is not null;

-- A member's own food can never be put on a list, whatever calls this table.
create function app.guard_list_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.food_item_id is not null and not exists (
    select 1 from public.food_items fi
     where fi.id = new.food_item_id and fi.visibility = 'public' and fi.kind in ('dish', 'recipe', 'packaged')
  ) then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404';
  end if;
  return new;
end;
$$;
create trigger food_list_items_guard before insert or update on public.food_list_items
  for each row execute function app.guard_list_item();

-- ---------------------------------------------------------------------------
-- 6. Reports. Moderator decisions are written to audit_events.
-- ---------------------------------------------------------------------------
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users (id) on delete cascade,
  target_type text not null check (target_type in ('review', 'list', 'ranking', 'profile')),
  target_id   uuid not null,
  reason      text not null check (reason in ('spam', 'harassment', 'false_information', 'unsafe_dietary_claim', 'other')),
  details     text check (details is null or length(details) between 1 and 500),
  state       text not null default 'open' check (state in ('open', 'actioned', 'dismissed')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references auth.users (id) on delete set null
);
create unique index reports_once_idx on public.reports (reporter_id, target_type, target_id) where state = 'open';
create index reports_open_idx on public.reports (state, created_at);

-- ---------------------------------------------------------------------------
-- 7. Row level security. Deny by default; a member may read only their own rows
--    directly. Everything else is served by the functions below.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'member_standing', 'social_action_log', 'blocks', 'follows', 'friendships', 'reviews', 'review_revisions',
    'ranking_entries', 'ranking_publications', 'food_lists', 'food_list_items', 'reports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;
revoke all on public.member_standing, public.social_action_log from authenticated;

create policy blocks_owner_read on public.blocks for select to authenticated using (blocker_id = (select auth.uid()));
create policy follows_own_read on public.follows for select to authenticated using (follower_id = (select auth.uid()));
create policy friendships_party_read on public.friendships for select to authenticated
  using (requester_id = (select auth.uid()) or recipient_id = (select auth.uid()));
create policy reviews_author_read on public.reviews for select to authenticated using (author_id = (select auth.uid()));
create policy review_revisions_author_read on public.review_revisions for select to authenticated
  using (exists (select 1 from public.reviews r where r.id = review_id and r.author_id = (select auth.uid())));
create policy ranking_entries_owner_read on public.ranking_entries for select to authenticated using (owner_id = (select auth.uid()));
create policy ranking_publications_owner_read on public.ranking_publications for select to authenticated using (owner_id = (select auth.uid()));
create policy food_lists_owner_read on public.food_lists for select to authenticated using (owner_id = (select auth.uid()));
create policy food_list_items_owner_read on public.food_list_items for select to authenticated
  using (exists (select 1 from public.food_lists l where l.id = list_id and l.owner_id = (select auth.uid())));
create policy reports_reporter_read on public.reports for select to authenticated using (reporter_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 8. Helpers (schema app; not callable over HTTP).
-- ---------------------------------------------------------------------------
create function app.require_member()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'NOT_SIGNED_IN' using errcode = 'PT401';
  end if;
  return v;
end;
$$;

create function app.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.has_role('moderator') or app.has_role('admin');
$$;

create function app.is_demo_member(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.is_demo from public.member_standing s where s.user_id = p_user), false);
$$;

create function app.blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_a is not null and p_b is not null and exists (
    select 1 from public.blocks b
     where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a));
$$;

create function app.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_a is not null and p_b is not null and exists (
    select 1 from public.friendships f
     where f.state = 'accepted'
       and ((f.requester_id = p_a and f.recipient_id = p_b) or (f.requester_id = p_b and f.recipient_id = p_a)));
$$;

-- May p_viewer (null for a guest) see that p_target has a profile at all?
-- The public social switch. While it is off (the default), someone who is not signed
-- in gets nothing a member wrote: no profile, review, ranking or list, whichever way
-- they ask (the app, the API or the database's own HTTP interface). Signed-in members
-- are not affected. Turning it on in a hosted environment is a release decision that
-- needs the owner's recorded approval. The app has its own switch as well
-- (SOCIAL_PUBLIC_ENABLED); a guest can read only when both are on.
create table app.platform_switches (
  name       text primary key check (name in ('social_public')),
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table app.platform_switches enable row level security;
alter table app.platform_switches force row level security;
revoke all on app.platform_switches from public, anon, authenticated;
insert into app.platform_switches (name, enabled) values ('social_public', false);

create function app.guest_may_read(p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_viewer is not null
      or coalesce((select w.enabled from app.platform_switches w where w.name = 'social_public'), false);
$$;

create function app.profile_ok(p_viewer uuid, p_target uuid, p_include_demo boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles_public p
      left join public.member_standing s on s.user_id = p.user_id
     where p.user_id = p_target and p.handle is not null
       and (p_viewer is not distinct from p_target
            or (app.guest_may_read(p_viewer)
                and s.profile_hidden_at is null
                and (p_include_demo or not coalesce(s.is_demo, false))
                and not app.blocked_between(p_viewer, p_target))));
$$;

create function app.person_json(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('handle', p.handle, 'displayName', coalesce(p.display_name, p.handle), 'isDemo', app.is_demo_member(p.user_id))
    from public.profiles_public p where p.user_id = p_user;
$$;

create function app.user_by_handle(p_handle text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id from public.profiles_public p where p.handle = lower(trim(p_handle));
$$;

-- Counts one action and refuses when the member has done it too often.
create function app.social_rate(p_user uuid, p_action text, p_max integer, p_window interval)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.social_action_log l where l.user_id = p_user and l.at < now() - interval '2 days';
  if (select count(*) from public.social_action_log l
       where l.user_id = p_user and l.action = p_action and l.at > now() - p_window) >= p_max then
    raise exception 'RATE_LIMITED' using errcode = 'PT429';
  end if;
  insert into public.social_action_log (user_id, action) values (p_user, p_action);
end;
$$;

-- The state a NEW public post gets: visible once the member has had one public
-- post approved, otherwise pending.
create function app.public_post_state(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (select 1 from public.member_standing s where s.user_id = p_user and s.first_public_approved_at is not null)
              then 'visible' else 'pending' end;
$$;

-- A public restaurant, dish or recipe as shown inside social content, with the
-- READER's dietary result for foods. Null when it is not publicly available.
create function app.social_target(p_venue uuid, p_food uuid, p_diet text, p_exclusions text[], p_include_conditional boolean, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_venue is not null then (
      select jsonb_build_object('kind', 'venue', 'id', v.id, 'name', v.name, 'neighborhood', v.neighborhood, 'isDemo', v.is_demo)
        from public.venues v
       where v.id = p_venue and v.status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not v.is_demo))
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

-- How the strict dietary rule treats one social item for the reader:
-- 'match' (show), 'unsure' (only in the opt-in view) or 'hidden' (never).
create function app.social_diet_group(p_target jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_target is null then 'hidden'
    when p_target ->> 'kind' = 'venue' then 'match'
    when p_target #>> '{eligibility,status}' in ('eligible', 'conditional') then 'match'
    when p_target #>> '{eligibility,status}' = 'needs_confirmation' then 'unsure'
    else 'hidden'
  end;
$$;

create function app.review_visible(p_viewer uuid, r public.reviews, p_include_demo boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select r.author_id is not distinct from p_viewer
      or (r.publication_state = 'visible'
          and app.profile_ok(p_viewer, r.author_id, p_include_demo)
          and (r.audience = 'public' or (r.audience = 'friends' and app.are_friends(p_viewer, r.author_id))));
$$;

create function app.review_json(r public.reviews, p_viewer uuid, p_diet text, p_exclusions text[], p_include_conditional boolean, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'reviewId', r.id, 'rating', r.rating, 'body', r.body, 'visitDate', r.visit_date,
    'audience', r.audience, 'state', r.publication_state, 'version', r.version,
    'createdAt', r.created_at, 'updatedAt', r.updated_at, 'publishedAt', r.published_at,
    'edited', r.version > 1, 'isMine', r.author_id is not distinct from p_viewer,
    'author', app.person_json(r.author_id),
    'target', app.social_target(r.venue_id, r.food_item_id, p_diet, p_exclusions, p_include_conditional, p_include_demo));
$$;

-- Public rating summary for one restaurant or one dish. Only approved public
-- reviews count. Demo members count only where demo content is enabled.
create function app.rating_summary(p_venue uuid, p_food uuid, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'count', count(*),
           'average', case when count(*) > 0 then round(avg(r.rating), 1) end,
           'early', count(*) < 5)
    from public.reviews r
    left join public.member_standing s on s.user_id = r.author_id
   where r.audience = 'public' and r.publication_state = 'visible'
     and ((p_venue is not null and r.venue_id = p_venue) or (p_food is not null and r.food_item_id = p_food))
     and s.profile_hidden_at is null
     and (p_include_demo or not coalesce(s.is_demo, false));
$$;

create function app.list_items_json(p_list uuid, p_diet text, p_exclusions text[], p_include_conditional boolean, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('itemId', i.id, 'position', i.position, 'note', i.note, 'target', t.target) order by i.position), '[]'::jsonb)
    from public.food_list_items i
    cross join lateral (select app.social_target(i.venue_id, i.food_item_id, p_diet, p_exclusions, p_include_conditional, p_include_demo) as target) t
   where i.list_id = p_list and t.target is not null;
$$;

create function app.list_visible(p_viewer uuid, l public.food_lists, p_include_demo boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select l.owner_id is not distinct from p_viewer
      or (l.visibility = 'public' and l.publication_state = 'visible' and app.profile_ok(p_viewer, l.owner_id, p_include_demo));
$$;

create function app.list_json(l public.food_lists, p_viewer uuid, p_with_items boolean, p_diet text, p_exclusions text[], p_include_conditional boolean, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'listId', l.id, 'title', l.title, 'description', l.description, 'visibility', l.visibility,
    'state', l.publication_state, 'isEditorial', l.is_editorial, 'isMine', l.owner_id is not distinct from p_viewer,
    'updatedAt', l.updated_at, 'publishedAt', l.published_at,
    'itemCount', (select count(*) from public.food_list_items i where i.list_id = l.id),
    'owner', app.person_json(l.owner_id),
    'items', case when p_with_items then app.list_items_json(l.id, p_diet, p_exclusions, p_include_conditional, p_include_demo) end);
$$;

-- A published ranking stores only the ordered restaurant ids. Names are looked
-- up when it is read, so a restaurant that is no longer public drops out.
create function app.ranking_entries_json(p_snapshot jsonb, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('position', x.ord, 'venueId', v.id, 'name', v.name,
                                               'neighborhood', v.neighborhood, 'isDemo', v.is_demo) order by x.ord), '[]'::jsonb)
    from jsonb_array_elements_text(p_snapshot) with ordinality as x(venue_id, ord)
    join public.venues v on v.id = x.venue_id::uuid
     and v.status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not v.is_demo);
$$;

-- The active published ranking of a member, as p_viewer may see it.
create function app.public_ranking_json(p_owner uuid, p_viewer uuid, p_include_demo boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('publicationId', rp.id, 'publishedAt', rp.published_at, 'state', rp.publication_state,
                            'isMine', rp.owner_id is not distinct from p_viewer,
                            'entries', app.ranking_entries_json(rp.snapshot, p_include_demo), 'owner', app.person_json(rp.owner_id))
    from public.ranking_publications rp
   where rp.owner_id = p_owner and rp.withdrawn_at is null
     and (rp.owner_id is not distinct from p_viewer
          or (rp.publication_state = 'visible' and app.profile_ok(p_viewer, rp.owner_id, p_include_demo)))
   order by rp.published_at desc limit 1;
$$;

create function app.clean_text(p text, p_max integer)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Removes control characters and trims; an empty result becomes null.
  select nullif(left(trim(regexp_replace(coalesce(p, ''), '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', '', 'g')), p_max), '');
$$;

create function app.require_profile()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v uuid := app.require_member();
begin
  if not exists (select 1 from public.profiles_public p where p.user_id = v and p.handle is not null) then
    raise exception 'PROFILE_REQUIRED' using errcode = 'PT409';
  end if;
  return v;
end;
$$;

-- A profile as OTHER people see it. Tastes and diet appear only when switched on.
-- The diet shown is the broad choice only (for example "vegan"); ingredient
-- exclusions can reveal an allergy and are never shown.
create function app.profile_json(p_target uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'handle', p.handle, 'displayName', coalesce(p.display_name, p.handle), 'bio', p.bio,
    'isDemo', app.is_demo_member(p.user_id),
    'tastes', case when p.show_tastes then to_jsonb(p.taste_tags) end,
    'diet', case when p.show_diet then (select nullif(up.diet, 'none') from public.user_preferences up where up.user_id = p.user_id) end,
    'followerCount', (select count(*) from public.follows f where f.followed_id = p.user_id),
    'followingCount', (select count(*) from public.follows f where f.follower_id = p.user_id),
    'joined', to_char(p.created_at, 'YYYY-MM'))
    from public.profiles_public p where p.user_id = p_target;
$$;

-- Finds the person behind a handle, or says "not found". A blocked, hidden or
-- missing profile all give the same answer, so a block cannot be detected.
create function app.resolve_person(p_viewer uuid, p_handle text, p_include_demo boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v uuid := app.user_by_handle(p_handle);
begin
  if v is null or not app.profile_ok(p_viewer, v, p_include_demo) then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'PT404';
  end if;
  return v;
end;
$$;

create function app.check_view(p_view text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_view is null or p_view not in ('matches', 'needs_confirmation') then
    raise exception 'INVALID_VIEW' using errcode = 'PT422';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Profiles and finding people
-- ---------------------------------------------------------------------------
create function public.my_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return jsonb_build_object(
    'profile', (select jsonb_build_object(
                  'handle', p.handle, 'displayName', p.display_name, 'bio', p.bio, 'tasteTags', to_jsonb(p.taste_tags),
                  'discoverable', p.discoverable, 'showTastes', p.show_tastes, 'showDiet', p.show_diet,
                  'followerCount', (select count(*) from public.follows f where f.followed_id = v_uid),
                  'followingCount', (select count(*) from public.follows f where f.follower_id = v_uid))
                  from public.profiles_public p where p.user_id = v_uid and p.handle is not null),
    'firstPublicApproved', exists (select 1 from public.member_standing s where s.user_id = v_uid and s.first_public_approved_at is not null),
    'profileHidden', exists (select 1 from public.member_standing s where s.user_id = v_uid and s.profile_hidden_at is not null),
    'incomingRequests', (select count(*) from public.friendships f where f.recipient_id = v_uid and f.state = 'pending'
                            and not app.blocked_between(v_uid, f.requester_id)),
    'isModerator', app.is_moderator(),
    'isCurator', app.has_role('curator') or app.has_role('admin'));
end;
$$;

create function public.save_my_profile(
  p_handle text, p_display_name text, p_bio text, p_taste_tags text[],
  p_discoverable boolean, p_show_tastes boolean, p_show_diet boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_handle text := lower(trim(coalesce(p_handle, '')));
  v_tags text[];
begin
  if v_handle !~ '^[a-z0-9_]{3,30}$' then
    raise exception 'INVALID_HANDLE' using errcode = 'PT422';
  end if;
  if v_handle in ('admin', 'administrator', 'moderator', 'support', 'help', 'staff', 'team', 'editorial', 'official', 'system')
     and not (app.has_role('admin') or app.has_role('publisher')) then
    raise exception 'HANDLE_TAKEN' using errcode = 'PT409';
  end if;
  select coalesce(array_agg(distinct t), '{}') into v_tags
    from (select lower(trim(x)) as t from unnest(coalesce(p_taste_tags, '{}'::text[])) x) y
   where t <> '';
  if cardinality(v_tags) > 8 or exists (select 1 from unnest(v_tags) t where t !~ '^[a-z0-9][a-z0-9 &-]{0,23}$') then
    raise exception 'INVALID_TASTES' using errcode = 'PT422';
  end if;
  perform app.social_rate(v_uid, 'profile', 20, interval '1 hour');
  begin
    insert into public.profiles_public (user_id, handle, display_name, bio, taste_tags, discoverable, show_tastes, show_diet)
    values (v_uid, v_handle, app.clean_text(p_display_name, 80), app.clean_text(p_bio, 300), v_tags,
            coalesce(p_discoverable, false), coalesce(p_show_tastes, false), coalesce(p_show_diet, false))
    on conflict (user_id) do update
      set handle = excluded.handle, display_name = excluded.display_name, bio = excluded.bio, taste_tags = excluded.taste_tags,
          discoverable = excluded.discoverable, show_tastes = excluded.show_tastes, show_diet = excluded.show_diet, updated_at = now();
  exception when unique_violation then
    raise exception 'HANDLE_TAKEN' using errcode = 'PT409';
  end;
  insert into public.member_standing (user_id) values (v_uid) on conflict (user_id) do nothing;
  return jsonb_build_object('handle', v_handle);
end;
$$;

create function public.profile_view(
  p_handle text, p_view text default 'matches', p_diet text default 'none', p_exclusions text[] default '{}',
  p_include_conditional boolean default false, p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_target uuid;
  v_reviews jsonb;
  v_unsure integer;
begin
  perform app.check_view(p_view);
  v_target := app.resolve_person(v_uid, p_handle, p_include_demo);
  with vis as (
    select r.published_at, app.review_json(r, v_uid, p_diet, p_exclusions, p_include_conditional, p_include_demo) as j
      from public.reviews r
     where r.author_id = v_target and r.publication_state = 'visible'
       and (r.audience = 'public' or (r.audience = 'friends' and (v_uid is not distinct from v_target or app.are_friends(v_uid, v_target))))
  ), g as (select v.*, app.social_diet_group(v.j -> 'target') as grp from vis v)
  select coalesce((select jsonb_agg(x.j order by x.published_at desc) from (
                     select g.j, g.published_at from g
                      where g.grp = case when p_view = 'matches' then 'match' else 'unsure' end
                      order by g.published_at desc limit 40) x), '[]'::jsonb),
         (select count(*) from g where g.grp = 'unsure')
    into v_reviews, v_unsure;
  return jsonb_build_object(
    'profile', app.profile_json(v_target),
    'isMe', v_uid is not distinct from v_target,
    'relationship', case when v_uid is null or v_uid = v_target then null else jsonb_build_object(
        'following', exists (select 1 from public.follows f where f.follower_id = v_uid and f.followed_id = v_target),
        'followsMe', exists (select 1 from public.follows f where f.follower_id = v_target and f.followed_id = v_uid),
        'friendship', coalesce((select case when f.state = 'accepted' then 'friends'
                                            when f.requester_id = v_uid then 'outgoing' else 'incoming' end
                                  from public.friendships f
                                 where (f.requester_id = v_uid and f.recipient_id = v_target)
                                    or (f.requester_id = v_target and f.recipient_id = v_uid)), 'none'),
        'canRequestFriend', (select p.discoverable from public.profiles_public p where p.user_id = v_target)
                            or exists (select 1 from public.follows f where f.follower_id = v_target and f.followed_id = v_uid)) end,
    'reviews', v_reviews,
    'needsConfirmationCount', v_unsure,
    'ranking', (select case when rj is null or (rj ->> 'state') <> 'visible' then null else rj end
                  from (select app.public_ranking_json(v_target, v_uid, p_include_demo) as rj) q),
    'lists', coalesce((select jsonb_agg(app.list_json(l, v_uid, false, p_diet, p_exclusions, p_include_conditional, p_include_demo) order by l.published_at desc)
                         from public.food_lists l
                        where l.owner_id = v_target and l.visibility = 'public' and l.publication_state = 'visible'), '[]'::jsonb));
end;
$$;

-- Exact-handle search only, and only for people who chose to be findable.
create function public.find_people(p_handle text, p_include_demo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_target uuid;
begin
  perform app.social_rate(v_uid, 'search', 30, interval '1 minute');
  v_target := app.user_by_handle(regexp_replace(coalesce(p_handle, ''), '^@', ''));
  return jsonb_build_object('results', coalesce((
    select jsonb_agg(app.person_json(p.user_id))
      from public.profiles_public p
     where p.user_id = v_target and p.user_id <> v_uid and p.discoverable
       and app.profile_ok(v_uid, p.user_id, p_include_demo)), '[]'::jsonb));
end;
$$;

-- People with approved public reviews who chose to be findable, whom the member
-- does not follow yet. The reason shown is simply how many reviews they have.
create function public.suggested_people(p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return jsonb_build_object('people', coalesce((
    select jsonb_agg(app.person_json(x.user_id) || jsonb_build_object('publicReviews', x.n) order by x.latest desc)
      from (select p.user_id, count(*) as n, max(r.published_at) as latest
              from public.profiles_public p
              join public.reviews r on r.author_id = p.user_id and r.audience = 'public' and r.publication_state = 'visible'
             where p.discoverable and p.user_id <> v_uid
               and app.profile_ok(v_uid, p.user_id, p_include_demo)
               and not exists (select 1 from public.follows f where f.follower_id = v_uid and f.followed_id = p.user_id)
             group by p.user_id order by max(r.published_at) desc limit 6) x), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Following, friendships and blocks
-- ---------------------------------------------------------------------------
create function public.follow_user(p_handle text, p_include_demo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_profile();
  v_target uuid := app.resolve_person(v_uid, p_handle, p_include_demo);
begin
  if v_target = v_uid then raise exception 'NOT_YOURSELF' using errcode = 'PT422'; end if;
  perform app.social_rate(v_uid, 'follow', 60, interval '1 hour');
  insert into public.follows (follower_id, followed_id) values (v_uid, v_target) on conflict do nothing;
  return jsonb_build_object('following', true);
end;
$$;

create function public.unfollow_user(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  delete from public.follows f where f.follower_id = v_uid and f.followed_id = app.user_by_handle(p_handle);
  return jsonb_build_object('following', false);
end;
$$;

-- The member's own lists of people. Nobody else can read these.
create function public.my_connections(p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return jsonb_build_object(
    'following', coalesce((select jsonb_agg(app.person_json(f.followed_id) order by f.created_at desc)
                             from public.follows f where f.follower_id = v_uid and app.profile_ok(v_uid, f.followed_id, p_include_demo)), '[]'::jsonb),
    'followers', coalesce((select jsonb_agg(app.person_json(f.follower_id) order by f.created_at desc)
                             from public.follows f where f.followed_id = v_uid and app.profile_ok(v_uid, f.follower_id, p_include_demo)), '[]'::jsonb),
    'friends', coalesce((select jsonb_agg(app.person_json(o.id) order by f.accepted_at desc)
                           from public.friendships f
                           cross join lateral (select case when f.requester_id = v_uid then f.recipient_id else f.requester_id end as id) o
                          where f.state = 'accepted' and v_uid in (f.requester_id, f.recipient_id)
                            and app.profile_ok(v_uid, o.id, p_include_demo)), '[]'::jsonb),
    'incoming', coalesce((select jsonb_agg(app.person_json(f.requester_id) order by f.created_at desc)
                            from public.friendships f where f.recipient_id = v_uid and f.state = 'pending'
                             and app.profile_ok(v_uid, f.requester_id, p_include_demo)), '[]'::jsonb),
    'outgoing', coalesce((select jsonb_agg(app.person_json(f.recipient_id) order by f.created_at desc)
                            from public.friendships f where f.requester_id = v_uid and f.state = 'pending'
                             and app.profile_ok(v_uid, f.recipient_id, p_include_demo)), '[]'::jsonb),
    'blocked', coalesce((select jsonb_agg(app.person_json(b.blocked_id) order by b.created_at desc)
                           from public.blocks b where b.blocker_id = v_uid and app.person_json(b.blocked_id) is not null), '[]'::jsonb));
end;
$$;

create function public.request_friend(p_handle text, p_include_demo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_profile();
  v_target uuid := app.resolve_person(v_uid, p_handle, p_include_demo);
  v_row public.friendships;
begin
  if v_target = v_uid then raise exception 'NOT_YOURSELF' using errcode = 'PT422'; end if;
  select * into v_row from public.friendships f
   where (f.requester_id = v_uid and f.recipient_id = v_target) or (f.requester_id = v_target and f.recipient_id = v_uid)
   for update;
  if found then
    if v_row.state = 'accepted' then return jsonb_build_object('friendship', 'friends'); end if;
    if v_row.requester_id = v_uid then return jsonb_build_object('friendship', 'outgoing'); end if;
    -- They had already asked me: asking back is the same as accepting.
    update public.friendships set state = 'accepted', accepted_at = now() where id = v_row.id;
    return jsonb_build_object('friendship', 'friends');
  end if;
  -- A request may only go to someone who chose to be findable, or who follows me.
  if not ((select p.discoverable from public.profiles_public p where p.user_id = v_target)
          or exists (select 1 from public.follows f where f.follower_id = v_target and f.followed_id = v_uid)) then
    raise exception 'REQUEST_NOT_ALLOWED' using errcode = 'PT403';
  end if;
  perform app.social_rate(v_uid, 'friend_request', 20, interval '1 day');
  insert into public.friendships (requester_id, recipient_id) values (v_uid, v_target);
  return jsonb_build_object('friendship', 'outgoing');
end;
$$;

create function public.respond_friend(p_handle text, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_target uuid := app.user_by_handle(p_handle);
  v_id uuid;
begin
  select f.id into v_id from public.friendships f
   where f.requester_id = v_target and f.recipient_id = v_uid and f.state = 'pending' for update;
  if v_id is null or app.blocked_between(v_uid, v_target) then
    raise exception 'REQUEST_NOT_FOUND' using errcode = 'PT404';
  end if;
  if p_accept then
    perform app.require_profile();
    update public.friendships set state = 'accepted', accepted_at = now() where id = v_id;
    return jsonb_build_object('friendship', 'friends');
  end if;
  delete from public.friendships where id = v_id;
  return jsonb_build_object('friendship', 'none');
end;
$$;

-- Cancels my own request, or ends an accepted friendship. Either side may end it.
create function public.remove_friend(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_target uuid := app.user_by_handle(p_handle);
begin
  delete from public.friendships f
   where (f.requester_id = v_uid and f.recipient_id = v_target)
      or (f.requester_id = v_target and f.recipient_id = v_uid and f.state = 'accepted');
  return jsonb_build_object('friendship', 'none');
end;
$$;

-- Blocking ends following and friendship in both directions at once.
create function public.block_user(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_target uuid := app.user_by_handle(p_handle);
begin
  if v_target is null then raise exception 'PROFILE_NOT_FOUND' using errcode = 'PT404'; end if;
  if v_target = v_uid then raise exception 'NOT_YOURSELF' using errcode = 'PT422'; end if;
  perform app.social_rate(v_uid, 'block', 60, interval '1 hour');
  insert into public.blocks (blocker_id, blocked_id) values (v_uid, v_target) on conflict do nothing;
  delete from public.follows f
   where (f.follower_id = v_uid and f.followed_id = v_target) or (f.follower_id = v_target and f.followed_id = v_uid);
  delete from public.friendships f
   where (f.requester_id = v_uid and f.recipient_id = v_target) or (f.requester_id = v_target and f.recipient_id = v_uid);
  return jsonb_build_object('blocked', true);
end;
$$;

create function public.unblock_user(p_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  delete from public.blocks b where b.blocker_id = v_uid and b.blocked_id = app.user_by_handle(p_handle);
  return jsonb_build_object('blocked', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Reviews
-- ---------------------------------------------------------------------------
create function public.save_review(
  p_kind text, p_target_id uuid, p_rating integer, p_body text default null, p_visit_date date default null,
  p_expected_version integer default null, p_include_demo boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_venue uuid := case when p_kind = 'venue' then p_target_id end;
  v_food uuid := case when p_kind = 'food' then p_target_id end;
  v_body text := app.clean_text(p_body, 2000);
  v_row public.reviews;
begin
  if p_kind is null or p_kind not in ('venue', 'food') or p_target_id is null then
    raise exception 'INVALID_TARGET' using errcode = 'PT422';
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'INVALID_RATING' using errcode = 'PT422';
  end if;
  if length(coalesce(p_body, '')) > 2000 then
    raise exception 'TEXT_TOO_LONG' using errcode = 'PT422';
  end if;
  if p_visit_date is not null and (p_visit_date > current_date + 1 or p_visit_date < date '2000-01-01') then
    raise exception 'INVALID_DATE' using errcode = 'PT422';
  end if;
  -- A review is about a restaurant or a restaurant dish (R-S02), nothing else.
  if coalesce(app.social_target(v_venue, v_food, 'none', '{}', false, p_include_demo) ->> 'kind', '') not in ('venue', 'dish') then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404';
  end if;
  perform app.social_rate(v_uid, 'review_write', 30, interval '1 hour');

  select * into v_row from public.reviews r
   where r.author_id = v_uid and ((v_venue is not null and r.venue_id = v_venue) or (v_food is not null and r.food_item_id = v_food))
   for update;
  if found then
    if p_expected_version is not null and p_expected_version <> v_row.version then
      raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
    end if;
    update public.reviews
       set rating = p_rating, body = v_body, visit_date = p_visit_date, version = version + 1, updated_at = now()
     where id = v_row.id returning * into v_row;
  else
    insert into public.reviews (author_id, venue_id, food_item_id, rating, body, visit_date)
    values (v_uid, v_venue, v_food, p_rating, v_body, p_visit_date) returning * into v_row;
  end if;
  insert into public.review_revisions (review_id, revision_no, rating, body, visit_date, audience)
  values (v_row.id, v_row.version, v_row.rating, v_row.body, v_row.visit_date, v_row.audience);
  return jsonb_build_object('reviewId', v_row.id, 'version', v_row.version, 'audience', v_row.audience, 'state', v_row.publication_state);
end;
$$;

-- Choosing who can see a review is its own step. A new account's first public
-- post waits for a moderator; so does anything a moderator removed before.
create function public.set_review_audience(p_review_id uuid, p_audience text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_row public.reviews;
  v_state text;
begin
  if p_audience is null or p_audience not in ('private', 'friends', 'public') then
    raise exception 'INVALID_AUDIENCE' using errcode = 'PT422';
  end if;
  select * into v_row from public.reviews r where r.id = p_review_id and r.author_id = v_uid for update;
  if not found then raise exception 'REVIEW_NOT_FOUND' using errcode = 'PT404'; end if;
  if p_audience = 'private' then
    v_state := 'draft';
  else
    perform app.require_profile();
    perform app.social_rate(v_uid, 'publish', 20, interval '1 hour');
    v_state := case when v_row.needs_review then 'pending'
                    when p_audience = 'friends' then 'visible'
                    else app.public_post_state(v_uid) end;
  end if;
  update public.reviews
     set audience = p_audience, publication_state = v_state, version = version + 1, updated_at = now(),
         published_at = case when v_state = 'visible' then coalesce(case when v_row.publication_state = 'visible' then v_row.published_at end, now()) end
   where id = v_row.id returning * into v_row;
  insert into public.review_revisions (review_id, revision_no, rating, body, visit_date, audience)
  values (v_row.id, v_row.version, v_row.rating, v_row.body, v_row.visit_date, v_row.audience);
  return jsonb_build_object('reviewId', v_row.id, 'version', v_row.version, 'audience', v_row.audience, 'state', v_row.publication_state);
end;
$$;

create function public.delete_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_venue uuid;
begin
  delete from public.reviews r where r.id = p_review_id and r.author_id = v_uid returning r.venue_id into v_venue;
  if not found then raise exception 'REVIEW_NOT_FOUND' using errcode = 'PT404'; end if;
  -- A ranking holds only restaurants the member has reviewed.
  if v_venue is not null then
    delete from public.ranking_entries e where e.owner_id = v_uid and e.venue_id = v_venue;
    update public.ranking_entries e set position = x.rn
      from (select e2.venue_id, row_number() over (order by e2.position) as rn from public.ranking_entries e2 where e2.owner_id = v_uid) x
     where e.owner_id = v_uid and e.venue_id = x.venue_id;
  end if;
  return jsonb_build_object('deleted', true);
end;
$$;

create function public.my_reviews(p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return jsonb_build_object('reviews', coalesce((
    select jsonb_agg(x.j order by x.updated_at desc)
      from (select r.updated_at, app.review_json(r, v_uid, 'none', '{}', false, p_include_demo) as j
              from public.reviews r where r.author_id = v_uid) x
     where x.j -> 'target' is not null and x.j -> 'target' <> 'null'::jsonb), '[]'::jsonb));
end;
$$;

-- Reviews of ONE restaurant or ONE dish, with its own rating summary. A
-- restaurant's summary never includes ratings of its dishes, or the reverse.
create function public.target_reviews(p_kind text, p_target_id uuid, p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_venue uuid := case when p_kind = 'venue' then p_target_id end;
  v_food uuid := case when p_kind = 'food' then p_target_id end;
begin
  if p_kind is null or p_kind not in ('venue', 'food') or p_target_id is null
     or app.social_target(v_venue, v_food, 'none', '{}', false, p_include_demo) is null then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404';
  end if;
  return jsonb_build_object(
    'target', app.social_target(v_venue, v_food, 'none', '{}', false, p_include_demo),
    'summary', app.rating_summary(v_venue, v_food, p_include_demo),
    'mine', (select app.review_json(r, v_uid, 'none', '{}', false, p_include_demo) from public.reviews r
              where v_uid is not null and r.author_id = v_uid
                and ((v_venue is not null and r.venue_id = v_venue) or (v_food is not null and r.food_item_id = v_food))),
    'reviews', coalesce((
      select jsonb_agg(x.j order by x.published_at desc)
        from (select r.published_at, app.review_json(r, v_uid, 'none', '{}', false, p_include_demo) as j
                from public.reviews r
               where ((v_venue is not null and r.venue_id = v_venue) or (v_food is not null and r.food_item_id = v_food))
                 and r.author_id is distinct from v_uid and r.publication_state = 'visible'
                 and app.review_visible(v_uid, r, p_include_demo)
               order by r.published_at desc limit 50) x), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Personal restaurant ranking
-- ---------------------------------------------------------------------------
create function public.my_ranking(p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return jsonb_build_object(
    'entries', coalesce((select jsonb_agg(jsonb_build_object('position', e.position, 'venueId', v.id, 'name', v.name,
                                                             'neighborhood', v.neighborhood, 'isDemo', v.is_demo) order by e.position)
                           from public.ranking_entries e join public.venues v on v.id = e.venue_id
                          where e.owner_id = v_uid and (p_include_demo or not v.is_demo)), '[]'::jsonb),
    'unranked', coalesce((select jsonb_agg(jsonb_build_object('venueId', v.id, 'name', v.name, 'neighborhood', v.neighborhood, 'isDemo', v.is_demo) order by v.name)
                            from public.reviews r join public.venues v on v.id = r.venue_id
                           where r.author_id = v_uid and (p_include_demo or not v.is_demo)
                             and not exists (select 1 from public.ranking_entries e where e.owner_id = v_uid and e.venue_id = v.id)), '[]'::jsonb),
    'publication', app.public_ranking_json(v_uid, v_uid, p_include_demo));
end;
$$;

-- Replaces the whole private order. Only restaurants the member has reviewed
-- (at any audience) can be ranked; the diary is never used to guess visits.
create function public.set_ranking(p_venue_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_ids uuid[] := coalesce(p_venue_ids, '{}');
begin
  if cardinality(v_ids) > 200 or (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
    raise exception 'INVALID_RANKING' using errcode = 'PT422';
  end if;
  if exists (select 1 from unnest(v_ids) x
              where not exists (select 1 from public.reviews r where r.author_id = v_uid and r.venue_id = x)) then
    raise exception 'NOT_REVIEWED' using errcode = 'PT422';
  end if;
  perform app.social_rate(v_uid, 'ranking', 120, interval '1 hour');
  delete from public.ranking_entries e where e.owner_id = v_uid;
  insert into public.ranking_entries (owner_id, venue_id, position)
  select v_uid, x.id, x.ord from unnest(v_ids) with ordinality as x(id, ord);
  return jsonb_build_object('count', cardinality(v_ids));
end;
$$;

-- Publishing shares a fixed copy of the order as it is now. Later private
-- changes do not change the published copy until the member publishes again.
create function public.publish_ranking()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_profile();
  v_snapshot jsonb;
  v_state text;
  v_id uuid;
begin
  select jsonb_agg(e.venue_id order by e.position) into v_snapshot from public.ranking_entries e where e.owner_id = v_uid;
  if v_snapshot is null then raise exception 'EMPTY_RANKING' using errcode = 'PT422'; end if;
  perform app.social_rate(v_uid, 'publish', 20, interval '1 hour');
  -- If a moderator removed the member's last published ranking, the next one waits for a check.
  v_state := case when exists (select 1 from public.ranking_publications rp
                                where rp.owner_id = v_uid and rp.publication_state = 'removed' and rp.withdrawn_at is null)
                  then 'pending' else app.public_post_state(v_uid) end;
  update public.ranking_publications rp set withdrawn_at = now() where rp.owner_id = v_uid and rp.withdrawn_at is null;
  insert into public.ranking_publications (owner_id, snapshot, publication_state) values (v_uid, v_snapshot, v_state) returning id into v_id;
  return jsonb_build_object('publicationId', v_id, 'state', v_state);
end;
$$;

create function public.withdraw_ranking()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  update public.ranking_publications rp set withdrawn_at = now()
   where rp.owner_id = v_uid and rp.withdrawn_at is null and rp.publication_state <> 'removed';
  return jsonb_build_object('withdrawn', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Lists
-- ---------------------------------------------------------------------------
create function public.save_list(p_list_id uuid, p_title text, p_description text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_title text := app.clean_text(p_title, 80);
  v_id uuid;
begin
  if v_title is null then raise exception 'TITLE_REQUIRED' using errcode = 'PT422'; end if;
  perform app.social_rate(v_uid, 'list_write', 60, interval '1 hour');
  if p_list_id is null then
    if (select count(*) from public.food_lists l where l.owner_id = v_uid) >= 30 then
      raise exception 'TOO_MANY_LISTS' using errcode = 'PT422';
    end if;
    insert into public.food_lists (owner_id, title, description) values (v_uid, v_title, app.clean_text(p_description, 500)) returning id into v_id;
  else
    update public.food_lists l set title = v_title, description = app.clean_text(p_description, 500), updated_at = now()
     where l.id = p_list_id and l.owner_id = v_uid returning l.id into v_id;
    if v_id is null then raise exception 'LIST_NOT_FOUND' using errcode = 'PT404'; end if;
  end if;
  return jsonb_build_object('listId', v_id);
end;
$$;

-- Replaces the items of a list, in the order given: [{kind, id, note}].
create function public.set_list_items(p_list_id uuid, p_items jsonb, p_include_demo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
begin
  perform 1 from public.food_lists l where l.id = p_list_id and l.owner_id = v_uid for update;
  if not found then
    raise exception 'LIST_NOT_FOUND' using errcode = 'PT404';
  end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 100
     or exists (select 1 from jsonb_array_elements(v_items) x
                 where x ->> 'kind' is null or x ->> 'kind' not in ('venue', 'food')
                    or (x ->> 'id') is null or (x ->> 'id') !~ '^[0-9a-fA-F-]{36}$') then
    raise exception 'INVALID_ITEMS' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) x
              where app.social_target(case when x ->> 'kind' = 'venue' then (x ->> 'id')::uuid end,
                                      case when x ->> 'kind' = 'food' then (x ->> 'id')::uuid end,
                                      'none', '{}', false, p_include_demo) is null) then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404';
  end if;
  perform app.social_rate(v_uid, 'list_write', 60, interval '1 hour');
  delete from public.food_list_items i where i.list_id = p_list_id;
  begin
    insert into public.food_list_items (list_id, venue_id, food_item_id, position, note)
    select p_list_id,
           case when x.item ->> 'kind' = 'venue' then (x.item ->> 'id')::uuid end,
           case when x.item ->> 'kind' = 'food' then (x.item ->> 'id')::uuid end,
           x.ord, app.clean_text(x.item ->> 'note', 200)
      from jsonb_array_elements(v_items) with ordinality as x(item, ord);
  exception when unique_violation then
    raise exception 'DUPLICATE_ITEM' using errcode = 'PT422';
  end;
  update public.food_lists l set updated_at = now() where l.id = p_list_id;
  return jsonb_build_object('listId', p_list_id, 'count', jsonb_array_length(v_items));
end;
$$;

create function public.add_to_list(p_list_id uuid, p_kind text, p_target_id uuid, p_note text default null, p_include_demo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_venue uuid := case when p_kind = 'venue' then p_target_id end;
  v_food uuid := case when p_kind = 'food' then p_target_id end;
  v_next integer;
begin
  perform 1 from public.food_lists l where l.id = p_list_id and l.owner_id = v_uid for update;
  if not found then
    raise exception 'LIST_NOT_FOUND' using errcode = 'PT404';
  end if;
  if p_kind is null or p_kind not in ('venue', 'food') or p_target_id is null
     or app.social_target(v_venue, v_food, 'none', '{}', false, p_include_demo) is null then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404';
  end if;
  perform app.social_rate(v_uid, 'list_write', 60, interval '1 hour');
  if exists (select 1 from public.food_list_items i where i.list_id = p_list_id
              and ((v_venue is not null and i.venue_id = v_venue) or (v_food is not null and i.food_item_id = v_food))) then
    return jsonb_build_object('listId', p_list_id, 'added', false);
  end if;
  select coalesce(max(i.position), 0) + 1 into v_next from public.food_list_items i where i.list_id = p_list_id;
  if v_next > 100 then raise exception 'LIST_FULL' using errcode = 'PT422'; end if;
  insert into public.food_list_items (list_id, venue_id, food_item_id, position, note)
  values (p_list_id, v_venue, v_food, v_next, app.clean_text(p_note, 200));
  update public.food_lists l set updated_at = now() where l.id = p_list_id;
  return jsonb_build_object('listId', p_list_id, 'added', true);
end;
$$;

create function public.publish_list(p_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_profile();
  v_row public.food_lists;
  v_state text;
begin
  select * into v_row from public.food_lists l where l.id = p_list_id and l.owner_id = v_uid for update;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = 'PT404'; end if;
  if not exists (select 1 from public.food_list_items i where i.list_id = p_list_id) then
    raise exception 'EMPTY_LIST' using errcode = 'PT422';
  end if;
  perform app.social_rate(v_uid, 'publish', 20, interval '1 hour');
  v_state := case when v_row.needs_review then 'pending' else app.public_post_state(v_uid) end;
  update public.food_lists l
     set visibility = 'public', publication_state = v_state, updated_at = now(),
         published_at = case when v_state = 'visible' then coalesce(case when v_row.publication_state = 'visible' then v_row.published_at end, now()) end
   where l.id = p_list_id;
  return jsonb_build_object('listId', p_list_id, 'state', v_state);
end;
$$;

create function public.unpublish_list(p_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  update public.food_lists l
     set visibility = 'private', publication_state = 'draft', published_at = null, is_editorial = false, updated_at = now()
   where l.id = p_list_id and l.owner_id = v_uid;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object('listId', p_list_id, 'state', 'draft');
end;
$$;

create function public.delete_list(p_list_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  delete from public.food_lists l where l.id = p_list_id and l.owner_id = v_uid;
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object('deleted', true);
end;
$$;

create function public.my_lists()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return jsonb_build_object('lists', coalesce((
    select jsonb_agg(app.list_json(l, v_uid, false, 'none', '{}', false, true) order by l.updated_at desc)
      from public.food_lists l where l.owner_id = v_uid), '[]'::jsonb));
end;
$$;

-- One list. Other people's lists follow the reader's dietary rule: confirmed
-- matches by default, unknown only in the opt-in view, "contains" never. The
-- owner managing their own list (p_view = 'manage') sees every item they added.
create function public.list_view(
  p_list_id uuid, p_view text default 'matches', p_diet text default 'none', p_exclusions text[] default '{}',
  p_include_conditional boolean default false, p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.food_lists;
  v_all jsonb;
begin
  select * into v_row from public.food_lists l where l.id = p_list_id;
  if not found or not app.list_visible(v_uid, v_row, p_include_demo) then
    raise exception 'LIST_NOT_FOUND' using errcode = 'PT404';
  end if;
  if p_view = 'manage' then
    if v_row.owner_id is distinct from v_uid then raise exception 'LIST_NOT_FOUND' using errcode = 'PT404'; end if;
  else
    perform app.check_view(p_view);
  end if;
  v_all := app.list_items_json(v_row.id, p_diet, p_exclusions, p_include_conditional, p_include_demo or v_row.owner_id is not distinct from v_uid);
  return app.list_json(v_row, v_uid, false, p_diet, p_exclusions, p_include_conditional, p_include_demo)
    || jsonb_build_object(
      'items', coalesce((select jsonb_agg(x.item order by (x.item ->> 'position')::integer)
                           from jsonb_array_elements(v_all) as x(item)
                          where p_view = 'manage'
                             or app.social_diet_group(x.item -> 'target') = case when p_view = 'matches' then 'match' else 'unsure' end), '[]'::jsonb),
      'needsConfirmationCount', (select count(*) from jsonb_array_elements(v_all) as x(item) where app.social_diet_group(x.item -> 'target') = 'unsure'));
end;
$$;

-- Editorial collections are lists made by the team and always labelled as such.
create function public.set_list_editorial(p_list_id uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  if not (app.has_role('publisher') or app.has_role('admin')) then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  update public.food_lists l set is_editorial = coalesce(p_on, false), updated_at = now()
   where l.id = p_list_id and l.owner_id = v_uid and l.visibility = 'public';
  if not found then raise exception 'LIST_NOT_FOUND' using errcode = 'PT404'; end if;
  perform app.audit('list.editorial_' || case when p_on then 'on' else 'off' end, 'list', p_list_id, null);
  return jsonb_build_object('listId', p_list_id, 'isEditorial', coalesce(p_on, false));
end;
$$;

create function public.editorial_collections(p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  return jsonb_build_object('collections', coalesce((
    select jsonb_agg(app.list_json(l, v_uid, false, 'none', '{}', false, p_include_demo) order by l.published_at desc)
      from public.food_lists l
     where l.is_editorial and app.list_visible(v_uid, l, p_include_demo) and l.publication_state = 'visible'), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Feeds and recommendations. Following and Friends are separate queries.
-- ---------------------------------------------------------------------------
create function public.social_feed(
  p_feed text, p_view text default 'matches', p_diet text default 'none', p_exclusions text[] default '{}',
  p_include_conditional boolean default false, p_before timestamptz default null, p_limit integer default 20,
  p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_items jsonb;
  v_unsure integer;
begin
  perform app.check_view(p_view);
  if p_feed = 'following' then
    with ok as (
      select f.followed_id as id from public.follows f
       where f.follower_id = v_uid and app.profile_ok(v_uid, f.followed_id, p_include_demo)
    ), cand as (
      select 'review'::text as type, r.published_at as at,
             app.review_json(r, v_uid, p_diet, p_exclusions, p_include_conditional, p_include_demo) as j
        from public.reviews r join ok on ok.id = r.author_id
       where r.audience = 'public' and r.publication_state = 'visible'
      union all
      select 'list', l.published_at, app.list_json(l, v_uid, false, p_diet, p_exclusions, p_include_conditional, p_include_demo)
        from public.food_lists l join ok on ok.id = l.owner_id
       where l.visibility = 'public' and l.publication_state = 'visible'
      union all
      select 'ranking', rp.published_at, app.public_ranking_json(rp.owner_id, v_uid, p_include_demo)
        from public.ranking_publications rp join ok on ok.id = rp.owner_id
       where rp.publication_state = 'visible' and rp.withdrawn_at is null
    ), g as (
      select c.*, case when c.type = 'review' then app.social_diet_group(c.j -> 'target') else 'match' end as grp from cand c
    )
    select coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'at', x.at, 'item', x.j) order by x.at desc)
                       from (select g.type, g.at, g.j from g
                              where g.grp = case when p_view = 'matches' then 'match' else 'unsure' end
                                and (p_before is null or g.at < p_before)
                              order by g.at desc limit v_limit) x), '[]'::jsonb),
           (select count(*) from g where g.grp = 'unsure')
      into v_items, v_unsure;
  elsif p_feed = 'friends' then
    with ok as (
      select o.id from public.friendships f
       cross join lateral (select case when f.requester_id = v_uid then f.recipient_id else f.requester_id end as id) o
       where f.state = 'accepted' and v_uid in (f.requester_id, f.recipient_id)
         and app.profile_ok(v_uid, o.id, p_include_demo)
    ), cand as (
      select 'review'::text as type, r.published_at as at,
             app.review_json(r, v_uid, p_diet, p_exclusions, p_include_conditional, p_include_demo) as j
        from public.reviews r join ok on ok.id = r.author_id
       where r.audience in ('friends', 'public') and r.publication_state = 'visible'
    ), g as (select c.*, app.social_diet_group(c.j -> 'target') as grp from cand c)
    select coalesce((select jsonb_agg(jsonb_build_object('type', x.type, 'at', x.at, 'item', x.j) order by x.at desc)
                       from (select g.type, g.at, g.j from g
                              where g.grp = case when p_view = 'matches' then 'match' else 'unsure' end
                                and (p_before is null or g.at < p_before)
                              order by g.at desc limit v_limit) x), '[]'::jsonb),
           (select count(*) from g where g.grp = 'unsure')
      into v_items, v_unsure;
  else
    raise exception 'INVALID_FEED' using errcode = 'PT422';
  end if;
  return jsonb_build_object(
    'feed', p_feed, 'items', v_items, 'needsConfirmationCount', v_unsure,
    'nextBefore', case when jsonb_array_length(v_items) = v_limit then v_items -> (v_limit - 1) -> 'at' end);
end;
$$;

-- Places and dishes that people the member follows rated 4 or 5, each with the
-- plain reason (who rated it, and how). No hidden scoring.
create function public.social_recommendations(
  p_view text default 'matches', p_diet text default 'none', p_exclusions text[] default '{}',
  p_include_conditional boolean default false, p_include_demo boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_result jsonb;
begin
  perform app.check_view(p_view);
  with ok as (
    select f.followed_id as id from public.follows f
     where f.follower_id = v_uid and app.profile_ok(v_uid, f.followed_id, p_include_demo)
  ), picks as (
    select r.venue_id, r.food_item_id, count(*) as n, max(r.published_at) as latest,
           jsonb_agg(jsonb_build_object('person', app.person_json(r.author_id), 'rating', r.rating) order by r.rating desc, r.published_at desc) as reasons
      from public.reviews r join ok on ok.id = r.author_id
     where r.audience = 'public' and r.publication_state = 'visible' and r.rating >= 4
       and not exists (select 1 from public.reviews mine
                        where mine.author_id = v_uid and (mine.venue_id = r.venue_id or mine.food_item_id = r.food_item_id))
     group by r.venue_id, r.food_item_id
  ), shaped as (
    select p.*, app.social_target(p.venue_id, p.food_item_id, p_diet, p_exclusions, p_include_conditional, p_include_demo) as target from picks p
  ), g as (select s.*, app.social_diet_group(s.target) as grp from shaped s)
  select jsonb_build_object(
    'venues', coalesce((select jsonb_agg(jsonb_build_object('target', x.target, 'reasons', x.reasons, 'count', x.n) order by x.n desc, x.latest desc)
                          from (select * from g where g.venue_id is not null and g.grp = 'match' and p_view = 'matches'
                                 order by g.n desc, g.latest desc limit 12) x), '[]'::jsonb),
    'dishes', coalesce((select jsonb_agg(jsonb_build_object('target', x.target, 'reasons', x.reasons, 'count', x.n) order by x.n desc, x.latest desc)
                          from (select * from g where g.food_item_id is not null
                                  and g.grp = case when p_view = 'matches' then 'match' else 'unsure' end
                                 order by g.n desc, g.latest desc limit 12) x), '[]'::jsonb),
    'needsConfirmationCount', (select count(*) from g where g.grp = 'unsure'),
    'followingCount', (select count(*) from ok))
    into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Reports and moderation
-- ---------------------------------------------------------------------------
-- What a moderator sees of one item: its text and author. Nothing private.
create function app.moderation_target(p_type text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case p_type
    when 'review' then (
      select jsonb_build_object('type', 'review', 'id', r.id, 'author', app.person_json(r.author_id), 'audience', r.audience,
                                'state', r.publication_state, 'rating', r.rating, 'body', r.body, 'at', r.updated_at,
                                'target', app.social_target(r.venue_id, r.food_item_id, 'none', '{}', false, true),
                                'firstPost', app.public_post_state(r.author_id) = 'pending')
        from public.reviews r where r.id = p_id and r.publication_state <> 'draft')
    when 'list' then (
      select jsonb_build_object('type', 'list', 'id', l.id, 'author', app.person_json(l.owner_id), 'audience', l.visibility,
                                'state', l.publication_state, 'title', l.title, 'body', l.description, 'at', l.updated_at,
                                'items', app.list_items_json(l.id, 'none', '{}', false, true),
                                'firstPost', app.public_post_state(l.owner_id) = 'pending')
        from public.food_lists l where l.id = p_id and l.publication_state <> 'draft')
    when 'ranking' then (
      select jsonb_build_object('type', 'ranking', 'id', rp.id, 'author', app.person_json(rp.owner_id), 'audience', 'public',
                                'state', rp.publication_state, 'at', rp.published_at,
                                'entries', app.ranking_entries_json(rp.snapshot, true),
                                'firstPost', app.public_post_state(rp.owner_id) = 'pending')
        from public.ranking_publications rp where rp.id = p_id and rp.withdrawn_at is null)
    when 'profile' then (
      select jsonb_build_object('type', 'profile', 'id', p.user_id, 'author', app.person_json(p.user_id), 'audience', 'public',
                                'state', case when s.profile_hidden_at is null then 'visible' else 'removed' end,
                                'title', p.display_name, 'body', p.bio, 'at', p.updated_at, 'firstPost', false)
        from public.profiles_public p left join public.member_standing s on s.user_id = p.user_id
       where p.user_id = p_id and p.handle is not null)
  end;
$$;

create function public.report_content(p_type text, p_id uuid, p_handle text, p_reason text, p_details text default null, p_include_demo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_id uuid := p_id;
  v_owner uuid;
  v_ok boolean := false;
begin
  if p_reason is null or p_reason not in ('spam', 'harassment', 'false_information', 'unsafe_dietary_claim', 'other') then
    raise exception 'INVALID_REASON' using errcode = 'PT422';
  end if;
  if p_type = 'review' then
    select r.author_id, app.review_visible(v_uid, r, p_include_demo) into v_owner, v_ok from public.reviews r where r.id = v_id;
  elsif p_type = 'list' then
    select l.owner_id, app.list_visible(v_uid, l, p_include_demo) into v_owner, v_ok from public.food_lists l where l.id = v_id;
  elsif p_type = 'ranking' then
    select rp.owner_id, rp.publication_state = 'visible' and rp.withdrawn_at is null and app.profile_ok(v_uid, rp.owner_id, p_include_demo)
      into v_owner, v_ok from public.ranking_publications rp where rp.id = v_id;
  elsif p_type = 'profile' then
    v_id := app.user_by_handle(p_handle);
    v_owner := v_id;
    v_ok := v_id is not null and app.profile_ok(v_uid, v_id, p_include_demo);
  else
    raise exception 'INVALID_TARGET' using errcode = 'PT422';
  end if;
  if v_owner is null or not coalesce(v_ok, false) or v_owner = v_uid then
    raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404';
  end if;
  perform app.social_rate(v_uid, 'report', 10, interval '1 day');
  insert into public.reports (reporter_id, target_type, target_id, reason, details)
  values (v_uid, p_type, v_id, p_reason, app.clean_text(p_details, 500))
  on conflict (reporter_id, target_type, target_id) where state = 'open' do nothing;
  return jsonb_build_object('reported', true);
end;
$$;

create function public.moderation_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_member();
  if not app.is_moderator() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  return jsonb_build_object(
    'pending', coalesce((
      select jsonb_agg(app.moderation_target(q.type, q.id) order by q.at)
        from (select 'review' as type, r.id, r.updated_at as at from public.reviews r where r.publication_state = 'pending'
              union all
              select 'list', l.id, l.updated_at from public.food_lists l where l.publication_state = 'pending'
              union all
              select 'ranking', rp.id, rp.published_at from public.ranking_publications rp
               where rp.publication_state = 'pending' and rp.withdrawn_at is null) q), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('reportId', x.id, 'reason', x.reason, 'details', x.details, 'at', x.created_at,
                                          'sameTargetCount', x.n, 'target', app.moderation_target(x.target_type, x.target_id)) order by x.created_at)
        from (select distinct on (rep.target_type, rep.target_id) rep.*,
                     count(*) over (partition by rep.target_type, rep.target_id) as n
                from public.reports rep where rep.state = 'open'
               order by rep.target_type, rep.target_id, rep.created_at) x), '[]'::jsonb),
    'removed', coalesce((
      select jsonb_agg(app.moderation_target(q.type, q.id) order by q.at desc)
        from (select 'review' as type, r.id, r.updated_at as at from public.reviews r where r.publication_state = 'removed'
              union all
              select 'list', l.id, l.updated_at from public.food_lists l where l.publication_state = 'removed'
              union all
              select 'ranking', rp.id, rp.published_at from public.ranking_publications rp
               where rp.publication_state = 'removed' and rp.withdrawn_at is null
              union all
              select 'profile', s.user_id, s.profile_hidden_at from public.member_standing s where s.profile_hidden_at is not null
              order by 3 desc limit 30) q), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'type', a.entity_type, 'reason', a.reason, 'at', a.occurred_at) order by a.occurred_at desc)
        from (select * from public.audit_events a where a.action like 'moderation.%' order by a.occurred_at desc limit 30) a), '[]'::jsonb));
end;
$$;

-- One moderator decision. Approving one post never publishes the author's other
-- waiting posts: each is approved by itself. Every decision is written to the
-- audit trail. A moderator cannot decide on their own content.
create function public.moderate(p_type text, p_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_reason text := app.clean_text(p_reason, 300);
  v_owner uuid;
  v_state text;
  v_audience text;
  v_new text;
begin
  if not app.is_moderator() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  if p_action is null or p_action not in ('approve', 'remove', 'restore') then
    raise exception 'INVALID_ACTION' using errcode = 'PT422';
  end if;
  if p_action = 'remove' and v_reason is null then
    raise exception 'REASON_REQUIRED' using errcode = 'PT422';
  end if;

  if p_type = 'review' then
    select r.author_id, r.publication_state, r.audience into v_owner, v_state, v_audience from public.reviews r where r.id = p_id for update;
  elsif p_type = 'list' then
    select l.owner_id, l.publication_state, l.visibility into v_owner, v_state, v_audience from public.food_lists l where l.id = p_id for update;
  elsif p_type = 'ranking' then
    select rp.owner_id, rp.publication_state, 'public' into v_owner, v_state, v_audience
      from public.ranking_publications rp where rp.id = p_id and rp.withdrawn_at is null for update;
  elsif p_type = 'profile' then
    select p.user_id, case when s.profile_hidden_at is null then 'visible' else 'removed' end, 'public' into v_owner, v_state, v_audience
      from public.profiles_public p left join public.member_standing s on s.user_id = p.user_id where p.user_id = p_id;
  else
    raise exception 'INVALID_TARGET' using errcode = 'PT422';
  end if;
  if v_owner is null or v_state = 'draft' then raise exception 'TARGET_NOT_FOUND' using errcode = 'PT404'; end if;
  if v_owner = v_uid then raise exception 'OWN_CONTENT' using errcode = 'PT403'; end if;

  if (p_action = 'approve' and v_state <> 'pending')
     or (p_action = 'remove' and v_state = 'removed')
     or (p_action = 'restore' and v_state <> 'removed') then
    raise exception 'WRONG_STATE' using errcode = 'PT409';
  end if;
  v_new := case when p_action = 'remove' then 'removed' else 'visible' end;

  if p_type = 'review' then
    update public.reviews r
       set publication_state = case when v_new = 'visible' and r.audience = 'private' then 'draft' else v_new end,
           needs_review = (v_new = 'removed'),
           published_at = case when v_new = 'visible' and r.audience <> 'private' then now() end
     where r.id = p_id;
  elsif p_type = 'list' then
    update public.food_lists l
       set publication_state = case when v_new = 'visible' and l.visibility = 'private' then 'draft' else v_new end,
           needs_review = (v_new = 'removed'),
           is_editorial = l.is_editorial and v_new = 'visible',
           published_at = case when v_new = 'visible' and l.visibility = 'public' then now() end
     where l.id = p_id;
  elsif p_type = 'ranking' then
    update public.ranking_publications rp
       set publication_state = v_new, published_at = case when v_new = 'visible' then now() else rp.published_at end
     where rp.id = p_id;
  else
    insert into public.member_standing (user_id, profile_hidden_at) values (v_owner, case when v_new = 'removed' then now() end)
    on conflict (user_id) do update set profile_hidden_at = excluded.profile_hidden_at;
  end if;

  -- Only a moderator's approval of a PUBLIC post lifts the first-post check.
  if p_action = 'approve' and v_audience = 'public' and p_type <> 'profile' then
    insert into public.member_standing (user_id, first_public_approved_at) values (v_owner, now())
    on conflict (user_id) do update set first_public_approved_at = coalesce(public.member_standing.first_public_approved_at, excluded.first_public_approved_at);
  end if;
  if p_action = 'remove' then
    update public.reports rep set state = 'actioned', decided_at = now(), decided_by = v_uid
     where rep.target_type = p_type and rep.target_id = p_id and rep.state = 'open';
  end if;
  perform app.audit('moderation.' || p_action, p_type, p_id, v_reason);
  return jsonb_build_object('type', p_type, 'id', p_id, 'state', v_new);
end;
$$;

-- Closes the open reports about one item without removing it.
create function public.dismiss_reports(p_report_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_type text;
  v_target uuid;
begin
  if not app.is_moderator() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  select rep.target_type, rep.target_id into v_type, v_target from public.reports rep where rep.id = p_report_id and rep.state = 'open';
  if v_type is null then raise exception 'REPORT_NOT_FOUND' using errcode = 'PT404'; end if;
  update public.reports rep set state = 'dismissed', decided_at = now(), decided_by = v_uid
   where rep.target_type = v_type and rep.target_id = v_target and rep.state = 'open';
  perform app.audit('moderation.dismiss_report', v_type, v_target, app.clean_text(p_reason, 300));
  return jsonb_build_object('dismissed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 16. Correction review screen (PH-02). A decision records what a person
--     concluded; it never edits the catalog by itself (R-D06).
-- ---------------------------------------------------------------------------
create function public.corrections_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_member();
  if not app.is_catalog_editor() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  return jsonb_build_object(
    'open', coalesce((
      select jsonb_agg(jsonb_build_object(
               'correctionId', c.id, 'field', c.field, 'proposedValue', c.proposed_value, 'evidenceNote', c.evidence_note, 'at', c.created_at,
               'target', app.social_target(c.venue_id, c.food_item_id, 'none', '{}', false, true)) order by c.created_at)
        from public.corrections c where c.state = 'open'), '[]'::jsonb),
    'decided', coalesce((
      select jsonb_agg(jsonb_build_object(
               'correctionId', c.id, 'field', c.field, 'proposedValue', c.proposed_value, 'state', c.state,
               'decisionNote', c.decision_note, 'at', c.decided_at,
               'target', app.social_target(c.venue_id, c.food_item_id, 'none', '{}', false, true)) order by c.decided_at desc)
        from (select * from public.corrections c where c.state <> 'open' order by c.decided_at desc limit 20) c), '[]'::jsonb));
end;
$$;

create function public.decide_correction(p_correction_id uuid, p_state text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  if not app.is_catalog_editor() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  if p_state is null or p_state not in ('accepted', 'rejected', 'duplicate') then
    raise exception 'INVALID_ACTION' using errcode = 'PT422';
  end if;
  update public.corrections c
     set state = p_state, decided_by = v_uid, decided_at = now(), decision_note = app.clean_text(p_note, 1000)
   where c.id = p_correction_id and c.state = 'open';
  if not found then raise exception 'CORRECTION_NOT_FOUND' using errcode = 'PT404'; end if;
  perform app.audit('correction.' || p_state, 'correction', p_correction_id, app.clean_text(p_note, 300));
  return jsonb_build_object('correctionId', p_correction_id, 'state', p_state);
end;
$$;

-- ---------------------------------------------------------------------------
-- 17. Data export now includes the member's social data.
-- ---------------------------------------------------------------------------
alter function public.export_my_data() rename to export_core;
alter function public.export_core() set schema app;

create function public.export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_member();
begin
  return app.export_core() || jsonb_build_object('social', jsonb_build_object(
    'profile', (select jsonb_build_object('handle', p.handle, 'displayName', p.display_name, 'bio', p.bio, 'tasteTags', to_jsonb(p.taste_tags),
                                          'discoverable', p.discoverable, 'showTastes', p.show_tastes, 'showDiet', p.show_diet)
                  from public.profiles_public p where p.user_id = v_uid),
    'following', coalesce((select jsonb_agg(p.handle order by f.created_at)
                             from public.follows f join public.profiles_public p on p.user_id = f.followed_id where f.follower_id = v_uid), '[]'::jsonb),
    'friends', coalesce((select jsonb_agg(p.handle order by f.accepted_at)
                           from public.friendships f
                           join public.profiles_public p on p.user_id = case when f.requester_id = v_uid then f.recipient_id else f.requester_id end
                          where f.state = 'accepted' and v_uid in (f.requester_id, f.recipient_id)), '[]'::jsonb),
    'blocked', coalesce((select jsonb_agg(p.handle order by b.created_at)
                           from public.blocks b join public.profiles_public p on p.user_id = b.blocked_id where b.blocker_id = v_uid), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object(
                             'reviewId', r.id, 'about', coalesce(v.name, fr.name), 'kind', case when r.venue_id is not null then 'restaurant' else 'dish' end,
                             'rating', r.rating, 'text', r.body, 'visitDate', r.visit_date, 'audience', r.audience,
                             'state', r.publication_state, 'createdAt', r.created_at, 'updatedAt', r.updated_at) order by r.created_at)
                           from public.reviews r
                           left join public.venues v on v.id = r.venue_id
                           left join public.food_items fi on fi.id = r.food_item_id
                           left join public.food_revisions fr on fr.id = fi.current_revision_id
                          where r.author_id = v_uid), '[]'::jsonb),
    'ranking', coalesce((select jsonb_agg(jsonb_build_object('position', e.position, 'restaurant', v.name) order by e.position)
                           from public.ranking_entries e join public.venues v on v.id = e.venue_id where e.owner_id = v_uid), '[]'::jsonb),
    'lists', coalesce((select jsonb_agg(jsonb_build_object(
                           'listId', l.id, 'title', l.title, 'description', l.description, 'visibility', l.visibility, 'state', l.publication_state,
                           'items', (select coalesce(jsonb_agg(jsonb_build_object('position', i.position, 'name', coalesce(v.name, fr.name), 'note', i.note) order by i.position), '[]'::jsonb)
                                       from public.food_list_items i
                                       left join public.venues v on v.id = i.venue_id
                                       left join public.food_items fi on fi.id = i.food_item_id
                                       left join public.food_revisions fr on fr.id = fi.current_revision_id
                                      where i.list_id = l.id)) order by l.created_at)
                         from public.food_lists l where l.owner_id = v_uid), '[]'::jsonb),
    'reportsFiled', coalesce((select jsonb_agg(jsonb_build_object('about', rep.target_type, 'reason', rep.reason, 'state', rep.state, 'at', rep.created_at) order by rep.created_at)
                                from public.reports rep where rep.reporter_id = v_uid), '[]'::jsonb)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 18. Who may call what. Helpers in schema app are never callable over HTTP.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app from public, anon, authenticated;
grant execute on function app.has_role(text), app.can_read_food_item(uuid), app.can_read_revision(uuid),
  app.is_catalog_editor(), app.is_valid_timezone(text), app.is_public_draft_revision(uuid) to anon, authenticated;

do $$
declare
  f regprocedure;
  -- Readable by anyone: only approved public content comes back for a guest.
  v_open text[] := array['profile_view', 'target_reviews', 'list_view', 'editorial_collections'];
  v_member text[] := array[
    'my_profile', 'save_my_profile', 'find_people', 'suggested_people', 'follow_user', 'unfollow_user', 'my_connections',
    'request_friend', 'respond_friend', 'remove_friend', 'block_user', 'unblock_user',
    'save_review', 'set_review_audience', 'delete_review', 'my_reviews',
    'my_ranking', 'set_ranking', 'publish_ranking', 'withdraw_ranking',
    'save_list', 'set_list_items', 'add_to_list', 'publish_list', 'unpublish_list', 'delete_list', 'my_lists', 'set_list_editorial',
    'social_feed', 'social_recommendations', 'report_content', 'moderation_queue', 'moderate', 'dismiss_reports',
    'corrections_queue', 'decide_correction', 'export_my_data'];
begin
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (v_open || v_member) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (v_open) loop
    execute format('grant execute on function %s to anon', f);
  end loop;
end $$;
