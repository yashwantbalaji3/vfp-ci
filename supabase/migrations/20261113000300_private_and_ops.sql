-- M1 · Private member data and operational tables.
-- Requirement IDs: R-002, R-004, R-F05, R-F06, R-G01, R-G02, R-D08 (preferences), R-007 (groundwork).
-- Spec: docs/06, 07, 11, 12. Social tables (follows, friendships, reviews, rankings, lists)
-- are M5 scope and intentionally not created here.

-- ---------------------------------------------------------------------------
-- Profiles and preferences (owner-only in M1; public profile reads arrive with M5)
-- ---------------------------------------------------------------------------
create table public.profiles_public (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  handle       text unique check (handle is null or handle ~ '^[a-z0-9_]{3,30}$'),
  display_name text check (display_name is null or length(display_name) between 1 and 80),
  discoverable boolean not null default false,
  created_at   timestamptz not null default now()
);

create function app.is_valid_timezone(p_tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz);
$$;
grant execute on function app.is_valid_timezone(text) to anon, authenticated;

create table public.user_preferences (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  diet                text not null default 'none' check (diet in ('none', 'vegetarian', 'vegan')),
  timezone            text not null default 'America/New_York',
  week_start          smallint not null default 1 check (week_start in (1, 7)),
  hide_numbers        boolean not null default false,
  adult_attested_at   timestamptz,
  eligibility_version integer not null default 1,
  updated_at          timestamptz not null default now(),
  check (app.is_valid_timezone(timezone))
);

-- Explicit exclusions win over broad diet labels (doc 18, R-D08, R-C07).
create table public.ingredient_exclusions (
  owner_id          uuid not null references auth.users (id) on delete cascade,
  ingredient_family text not null references public.ingredient_families (code),
  policy            text not null default 'exclude' check (policy = 'exclude'),
  updated_at        timestamptz not null default now(),
  primary key (owner_id, ingredient_family)
);

-- Any change to diet or exclusions bumps eligibility_version so cached
-- recommendations and filter results become invalid (R-C07).
create function app.bump_eligibility_on_preferences()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.diet is distinct from old.diet then
    new.eligibility_version := old.eligibility_version + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger user_preferences_eligibility before update on public.user_preferences
  for each row execute function app.bump_eligibility_on_preferences();

create function app.bump_eligibility_on_exclusions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'DELETE' then v_owner := old.owner_id; else v_owner := new.owner_id; end if;
  update public.user_preferences
     set eligibility_version = eligibility_version + 1
   where user_id = v_owner;
  return null;
end;
$$;
create trigger ingredient_exclusions_eligibility after insert or update or delete on public.ingredient_exclusions
  for each row execute function app.bump_eligibility_on_exclusions();

-- ---------------------------------------------------------------------------
-- Private diary with immutable snapshots (R-F04, R-F06)
-- ---------------------------------------------------------------------------
create table public.diary_entries (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users (id) on delete cascade,
  food_item_id        uuid references public.food_items (id) on delete set null,
  context             text not null check (context in ('home', 'restaurant', 'packaged')),
  meal_slot           text not null check (length(meal_slot) between 1 and 40),
  consumed_at         timestamptz,
  local_date          date not null,
  entry_timezone      text not null check (app.is_valid_timezone(entry_timezone)),
  current_snapshot_id uuid,
  version             integer not null default 1,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  unique (id, owner_id)
);
create index diary_entries_owner_date_idx on public.diary_entries (owner_id, local_date) where deleted_at is null;

create table public.diary_snapshots (
  id                uuid primary key default gen_random_uuid(),
  entry_id          uuid not null references public.diary_entries (id) on delete cascade,
  revision_no       integer not null check (revision_no > 0),
  food_revision_id  uuid references public.food_revisions (id) on delete set null,
  display_name      text not null,
  selected_portion  jsonb not null,
  quantity          numeric not null check (quantity > 0),
  resolved_mass_g   numeric check (resolved_mass_g is null or resolved_mass_g > 0),
  nutrients         jsonb not null,
  evidence_snapshot jsonb not null,
  created_at        timestamptz not null default now(),
  unique (entry_id, revision_no),
  unique (id, entry_id),
  check (jsonb_typeof(nutrients) = 'object'),
  check (jsonb_typeof(evidence_snapshot) = 'object')
);

alter table public.diary_entries
  add constraint diary_entries_current_snapshot_fk
  foreign key (current_snapshot_id, id) references public.diary_snapshots (id, entry_id)
  deferrable initially deferred;

-- Snapshots never change. food_revision_id may only be cleared (custom food deleted).
create function app.guard_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'food_revision_id') <> (to_jsonb(old) - 'food_revision_id')
     or (new.food_revision_id is not null and new.food_revision_id is distinct from old.food_revision_id) then
    raise exception 'Diary snapshots are immutable' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger diary_snapshots_immutable before update on public.diary_snapshots
  for each row execute function app.guard_snapshot();

create table public.daily_log_status (
  owner_id   uuid not null references auth.users (id) on delete cascade,
  local_date date not null,
  status     text not null check (status in ('unspecified', 'partial', 'complete')),
  primary key (owner_id, local_date)
);

-- ---------------------------------------------------------------------------
-- Goals with half-open effective date ranges (R-G01, R-G02)
-- ---------------------------------------------------------------------------
create table public.goal_versions (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  metric         text not null check (metric in ('protein_g_per_day', 'cook_sessions_per_week')),
  target         numeric not null,
  effective_from date not null,
  effective_to   date,
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (
    (metric = 'protein_g_per_day' and target > 0 and target <= 1000) or
    (metric = 'cook_sessions_per_week' and target = trunc(target) and target between 1 and 100)
  ),
  constraint goal_versions_no_overlap exclude using gist (
    owner_id with =, metric with =, daterange(effective_from, effective_to, '[)') with &&
  )
);

-- ---------------------------------------------------------------------------
-- Saves, plans, cook sessions (schema only in M1; workflows arrive in M2–M4)
-- ---------------------------------------------------------------------------
create table public.saves (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  food_item_id uuid references public.food_items (id) on delete cascade,
  venue_id     uuid references public.venues (id) on delete cascade,
  created_at   timestamptz not null default now(),
  check (num_nonnulls(food_item_id, venue_id) = 1)
);
create unique index saves_owner_food_uq on public.saves (owner_id, food_item_id) where food_item_id is not null;
create unique index saves_owner_venue_uq on public.saves (owner_id, venue_id) where venue_id is not null;

create table public.meal_plans (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  planned_date     date not null,
  food_revision_id uuid not null references public.food_revisions (id),
  planned_servings numeric not null check (planned_servings > 0 and planned_servings <= 100)
);

create table public.cook_sessions (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  recipe_revision_id uuid not null references public.recipe_revisions (food_revision_id),
  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  local_date         date not null,
  served_count       numeric check (served_count is null or served_count > 0),
  version            integer not null default 1
);

-- ---------------------------------------------------------------------------
-- Operational tables (no member access; used by definer functions and workers)
-- ---------------------------------------------------------------------------
create table public.idempotency_records (
  owner_id     uuid not null references auth.users (id) on delete cascade,
  operation    text not null,
  key          uuid not null,
  request_hash text not null,
  result_id    uuid,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '24 hours',
  primary key (owner_id, operation, key)
);

create table public.outbox_jobs (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('cache_invalidate', 'freshness_expiry', 'export', 'account_cleanup', 'retention_purge', 'media_processing', 'provider_import')),
  object_id       uuid,
  dedupe_key      text not null unique,
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  state           text not null default 'pending' check (state in ('pending', 'running', 'succeeded', 'dead_letter')),
  created_at      timestamptz not null default now()
);

create table public.deletion_tombstones (
  subject_ref   text primary key,
  requested_at  timestamptz not null,
  completed_at  timestamptz,
  backup_expiry timestamptz
);

create table public.assets (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid references auth.users (id) on delete cascade,
  storage_path     text not null unique,
  visibility       text not null default 'private' check (visibility in ('private', 'public')),
  rights_record_id uuid references public.source_records (id),
  content_type     text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size        integer not null check (byte_size > 0 and byte_size <= 5242880),
  moderation_state text not null default 'pending' check (moderation_state in ('pending', 'approved', 'rejected')),
  alt_text         text check (alt_text is null or length(alt_text) <= 500),
  created_at       timestamptz not null default now(),
  -- Public assets need documented rights and are never owned by a member.
  check (visibility = 'private' or (owner_id is null and rights_record_id is not null))
);

-- ---------------------------------------------------------------------------
-- Storage buckets: private member uploads and curator catalog media.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('private-uploads', 'private-uploads', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('catalog-media', 'catalog-media', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Members can only touch objects under a folder named with their own user id.
create policy private_uploads_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_uploads_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy private_uploads_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'private-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Catalog media: anyone may read; only catalog editors may write.
create policy catalog_media_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'catalog-media');
create policy catalog_media_editor_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'catalog-media' and app.is_catalog_editor());
