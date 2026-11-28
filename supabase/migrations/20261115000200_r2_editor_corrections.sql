-- R2 · Editor and corrections workflow (local only, synthetic data only).
-- Roadmap: plans/2026-11-14-integration-readiness-audit.md, section R2.
-- Decisions: docs/17 D-CORR-1 and D-R2-*. Tests: docs/14 "R2 evidence map".
--
-- The rule this file exists to enforce (owner, 15 November 2026):
--   Accepting a correction never changes published dietary or nutrition
--   information. Every change is a new revision with a source, entered by one
--   person, checked by a different person, passed through publication checks,
--   and written to the audit trail.

-- ---------------------------------------------------------------------------
-- 0. Small helpers and the "practice mode" switch
-- ---------------------------------------------------------------------------
alter table app.platform_switches drop constraint platform_switches_name_check;
alter table app.platform_switches add constraint platform_switches_name_check
  check (name in ('social_public', 'real_catalog_entry'));
-- While this is off (the default, and the only setting R2 uses) everything an
-- editor enters is marked as demo data. Turning it on is an R3 decision.
insert into app.platform_switches (name, enabled) values ('real_catalog_entry', false);

create function app.entry_is_demo()
returns boolean language sql stable security definer set search_path = '' as $$
  select not coalesce((select w.enabled from app.platform_switches w where w.name = 'real_catalog_entry'), false);
$$;

create function app.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_role('curator') or app.has_role('publisher') or app.has_role('moderator') or app.has_role('admin');
$$;

-- How one member of staff is named to another. Never an email address.
create function app.staff_label(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_user is null then null
              else coalesce((select '@' || p.handle from public.profiles_public p where p.user_id = p_user and p.handle is not null),
                            'editor ' || left(p_user::text, 8)) end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Account suspension (moderators). A suspended member cannot post, and
--    their public content is hidden and leaves the averages.
-- ---------------------------------------------------------------------------
alter table public.member_standing
  add column suspended_at timestamptz,
  add column suspended_reason text check (suspended_reason is null or length(suspended_reason) <= 300);

create function app.is_suspended(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.member_standing s where s.user_id = p_user and s.suspended_at is not null);
$$;

create or replace function app.profile_ok(p_viewer uuid, p_target uuid, p_include_demo boolean)
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
                and s.suspended_at is null
                and (p_include_demo or not coalesce(s.is_demo, false))
                and not app.blocked_between(p_viewer, p_target))));
$$;

create or replace function app.rating_summary(p_venue uuid, p_food uuid, p_include_demo boolean)
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
     and s.suspended_at is null
     and (p_include_demo or not coalesce(s.is_demo, false));
$$;

create or replace function app.require_profile()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v uuid := app.require_member();
begin
  if app.is_suspended(v) then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = 'PT403';
  end if;
  if not exists (select 1 from public.profiles_public p where p.user_id = v and p.handle is not null) then
    raise exception 'PROFILE_REQUIRED' using errcode = 'PT409';
  end if;
  return v;
end;
$$;

create or replace function app.social_rate(p_user uuid, p_action text, p_max integer, p_window interval)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if app.is_suspended(p_user) then
    raise exception 'ACCOUNT_SUSPENDED' using errcode = 'PT403';
  end if;
  delete from public.social_action_log l where l.user_id = p_user and l.at < now() - interval '2 days';
  if (select count(*) from public.social_action_log l
       where l.user_id = p_user and l.action = p_action and l.at > now() - p_window) >= p_max then
    raise exception 'RATE_LIMITED' using errcode = 'PT429';
  end if;
  insert into public.social_action_log (user_id, action) values (p_user, p_action);
end;
$$;

create function public.set_member_suspension(p_handle text, p_suspend boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v_target uuid;
  v_reason text := app.clean_text(p_reason, 300);
  v_was boolean;
begin
  if not app.is_moderator() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  select p.user_id into v_target from public.profiles_public p where p.handle = lower(btrim(coalesce(p_handle, '')));
  if v_target is null then raise exception 'MEMBER_NOT_FOUND' using errcode = 'PT404'; end if;
  if v_target = v_uid then raise exception 'OWN_ACCOUNT' using errcode = 'PT403'; end if;
  -- Staff accounts can be suspended only by an admin.
  if exists (select 1 from public.role_assignments ra where ra.user_id = v_target) and not app.has_role('admin') then
    raise exception 'STAFF_ACCOUNT' using errcode = 'PT403';
  end if;
  if p_suspend is null then raise exception 'INVALID_ACTION' using errcode = 'PT422'; end if;
  if p_suspend and v_reason is null then raise exception 'REASON_REQUIRED' using errcode = 'PT422'; end if;
  v_was := app.is_suspended(v_target);
  if v_was = p_suspend then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  insert into public.member_standing (user_id, suspended_at, suspended_reason)
  values (v_target, case when p_suspend then now() end, case when p_suspend then v_reason end)
  on conflict (user_id) do update set suspended_at = excluded.suspended_at, suspended_reason = excluded.suspended_reason;
  perform app.audit(case when p_suspend then 'moderation.suspend' else 'moderation.reinstate' end, 'member', v_target, v_reason);
  return jsonb_build_object('handle', lower(btrim(p_handle)), 'suspended', p_suspend);
end;
$$;

-- What a moderator needs to judge one member: counts and past decisions about
-- their public content. Nothing from the diary, goals, cooking, plans, saves,
-- own foods or preferences, and no email address.
create function public.member_history(p_handle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  p public.profiles_public;
  s public.member_standing;
begin
  perform app.require_member();
  if not app.is_moderator() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  select * into p from public.profiles_public x where x.handle = lower(btrim(coalesce(p_handle, '')));
  if p.user_id is null then raise exception 'MEMBER_NOT_FOUND' using errcode = 'PT404'; end if;
  v_target := p.user_id;
  select * into s from public.member_standing x where x.user_id = v_target;
  return jsonb_build_object(
    'handle', p.handle, 'displayName', p.display_name, 'isDemo', coalesce(s.is_demo, false),
    'suspendedAt', s.suspended_at, 'suspendedReason', s.suspended_reason,
    'profileHiddenAt', s.profile_hidden_at, 'firstPublicApprovedAt', s.first_public_approved_at,
    'isStaff', exists (select 1 from public.role_assignments ra where ra.user_id = v_target),
    'counts', jsonb_build_object(
      'reviewsVisible', (select count(*) from public.reviews r where r.author_id = v_target and r.publication_state = 'visible' and r.audience = 'public'),
      'reviewsPending', (select count(*) from public.reviews r where r.author_id = v_target and r.publication_state = 'pending'),
      'reviewsRemoved', (select count(*) from public.reviews r where r.author_id = v_target and r.publication_state = 'removed'),
      'listsPublic', (select count(*) from public.food_lists l where l.owner_id = v_target and l.publication_state = 'visible' and l.visibility = 'public'),
      'listsRemoved', (select count(*) from public.food_lists l where l.owner_id = v_target and l.publication_state = 'removed'),
      'reportsAgainstOpen', (select count(*) from public.reports rep where rep.state = 'open' and app.report_owner(rep.target_type, rep.target_id) = v_target),
      'reportsAgainstActioned', (select count(*) from public.reports rep where rep.state = 'actioned' and app.report_owner(rep.target_type, rep.target_id) = v_target),
      'reportsAgainstDismissed', (select count(*) from public.reports rep where rep.state = 'dismissed' and app.report_owner(rep.target_type, rep.target_id) = v_target),
      'reportsMade', (select count(*) from public.reports rep where rep.reporter_id = v_target)),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'type', a.entity_type, 'reason', a.reason, 'at', a.occurred_at,
                                          'by', app.staff_label(a.actor_id)) order by a.occurred_at desc)
        from (select a.* from public.audit_events a
               where a.action like 'moderation.%'
                 and ((a.entity_type in ('member', 'profile') and a.entity_id = v_target)
                   or (a.entity_type = 'review' and a.entity_id in (select r.id from public.reviews r where r.author_id = v_target))
                   or (a.entity_type = 'list' and a.entity_id in (select l.id from public.food_lists l where l.owner_id = v_target))
                   or (a.entity_type = 'ranking' and a.entity_id in (select rp.id from public.ranking_publications rp where rp.owner_id = v_target)))
               order by a.occurred_at desc limit 50) a), '[]'::jsonb));
end;
$$;

create function app.report_owner(p_type text, p_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select case p_type
    when 'review' then (select r.author_id from public.reviews r where r.id = p_id)
    when 'list' then (select l.owner_id from public.food_lists l where l.id = p_id)
    when 'ranking' then (select rp.owner_id from public.ranking_publications rp where rp.id = p_id)
    when 'profile' then p_id end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Freshness: how old a checked record may be before it is labelled.
--    Ages are the proposed defaults of docs/08 (decision D-R2-FRESH).
-- ---------------------------------------------------------------------------
create table app.freshness_rules (
  subject     text primary key check (subject in ('dish', 'venue', 'packaged', 'ingredient', 'recipe')),
  review_days integer not null check (review_days > 0),
  expire_days integer check (expire_days is null or expire_days >= review_days)
);
alter table app.freshness_rules enable row level security;
alter table app.freshness_rules force row level security;
revoke all on app.freshness_rules from public, anon, authenticated;
insert into app.freshness_rules (subject, review_days, expire_days) values
  ('dish', 30, 60), ('venue', 30, 60), ('packaged', 180, 360), ('ingredient', 365, null), ('recipe', 365, null);

create function app.freshness_json(p_subject text, p_checked timestamptz, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checkedAt', p_checked,
    'state', case when p_checked is null then 'out_of_date'
                  when f.expire_days is not null and p_checked + make_interval(days => f.expire_days) <= p_now then 'out_of_date'
                  when p_checked + make_interval(days => f.review_days) <= p_now then 'due'
                  else 'current' end)
    from app.freshness_rules f where f.subject = p_subject;
$$;

-- ---------------------------------------------------------------------------
-- 3. Catalog changes and "needs review" flags
-- ---------------------------------------------------------------------------
create table public.catalog_changes (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('food', 'venue')),
  is_new            boolean not null default false,
  food_item_id      uuid references public.food_items (id) on delete cascade,
  venue_id          uuid references public.venues (id) on delete cascade,
  base_revision_id  uuid references public.food_revisions (id) on delete set null,
  draft_revision_id uuid references public.food_revisions (id) on delete set null,
  correction_id     uuid references public.corrections (id) on delete set null,
  state             text not null default 'draft' check (state in ('draft', 'submitted', 'published', 'rejected', 'withdrawn')),
  summary           text check (summary is null or length(summary) between 3 and 500),
  source_record_id  uuid references public.source_records (id),
  payload           jsonb not null default '{}'::jsonb,
  draft_snapshot    jsonb,
  touches_evidence  boolean,
  author_id         uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  reviewer_id       uuid references auth.users (id) on delete set null,
  reviewed_at       timestamptz,
  review_note       text check (review_note is null or length(review_note) <= 500),
  check ((kind = 'food' and venue_id is null) or (kind = 'venue' and food_item_id is null)),
  -- The person who checks is never the person who entered.
  check (reviewer_id is null or author_id is null or reviewer_id <> author_id)
);
create unique index catalog_changes_one_open_food on public.catalog_changes (food_item_id)
  where food_item_id is not null and state in ('draft', 'submitted');
create unique index catalog_changes_one_open_venue on public.catalog_changes (venue_id)
  where venue_id is not null and state in ('draft', 'submitted');
create index catalog_changes_state_idx on public.catalog_changes (state, created_at);
create index catalog_changes_correction_idx on public.catalog_changes (correction_id) where correction_id is not null;
alter table public.catalog_changes enable row level security;
alter table public.catalog_changes force row level security;
revoke all on public.catalog_changes from public, anon, authenticated;

create table public.review_flags (
  id                  uuid primary key default gen_random_uuid(),
  food_item_id        uuid not null references public.food_items (id) on delete cascade,
  flagged_revision_id uuid not null references public.food_revisions (id) on delete cascade,
  reason              text not null check (length(reason) between 3 and 500),
  correction_id       uuid references public.corrections (id) on delete set null,
  raised_by           uuid references auth.users (id) on delete set null,
  raised_at           timestamptz not null default now(),
  resolved_change_id  uuid references public.catalog_changes (id) on delete set null,
  resolved_at         timestamptz
);
create unique index review_flags_one_open on public.review_flags (food_item_id) where resolved_at is null;
create index review_flags_revision_idx on public.review_flags (flagged_revision_id) where resolved_at is null;
alter table public.review_flags enable row level security;
alter table public.review_flags force row level security;
revoke all on public.review_flags from public, anon, authenticated;

alter table public.corrections add column applied_change_id uuid references public.catalog_changes (id) on delete set null;

-- A flagged record stops qualifying for every dietary filter at once: the
-- result becomes "needs confirmation" until a checked revision replaces it.
do $$
declare
  v_def text := pg_catalog.pg_get_functiondef('app.eligibility(uuid, text, text[], boolean)'::regprocedure);
  v_anchor text := E'  if p_diet <> ''none'' then\n    select * into c from public.dietary_claims';
  v_new text;
begin
  v_new := replace(v_def, v_anchor,
    E'  if (p_diet <> ''none'' or cardinality(coalesce(p_exclusions, ''{}'')) > 0)\n'
    || E'     and exists (select 1 from public.review_flags rf where rf.flagged_revision_id = p_revision_id and rf.resolved_at is null) then\n'
    || E'    v_rank := greatest(v_rank, 2); v_reasons := v_reasons || jsonb_build_object(''code'', ''needs_review'');\n'
    || E'  end if;\n\n' || v_anchor);
  if v_new = v_def then raise exception 'R2: could not extend app.eligibility'; end if;
  execute v_new;
end $$;

-- Freshness and review marks for a set of public records. Only published
-- public records answer; anything else is simply absent.
create function public.freshness_marks(p_food_item_ids uuid[] default '{}', p_venue_ids uuid[] default '{}', p_include_demo boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'foods', coalesce((
      select jsonb_object_agg(fi.id, app.freshness_json(case when fi.kind in ('dish', 'packaged', 'ingredient', 'recipe') then fi.kind else 'dish' end, r.published_at)
               || jsonb_build_object('underReview', exists (select 1 from public.review_flags rf where rf.flagged_revision_id = r.id and rf.resolved_at is null)))
        from public.food_items fi join public.food_revisions r on r.id = fi.current_revision_id
       where fi.id = any ((coalesce(p_food_item_ids, '{}'))[1:300]) and fi.visibility = 'public' and fi.status = 'published'
         and (p_include_demo or not fi.is_demo)), '{}'::jsonb),
    'venues', coalesce((
      select jsonb_object_agg(v.id, app.freshness_json('venue', v.reviewed_at))
        from public.venues v
       where v.id = any ((coalesce(p_venue_ids, '{}'))[1:300]) and v.status in ('published', 'temporarily_closed', 'closed')
         and (p_include_demo or not v.is_demo)), '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 4. Publication checks, and the second-person rule on the publish function
-- ---------------------------------------------------------------------------
create function app.publish_gate(p_revision_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r public.food_revisions;
  fi public.food_items;
  v_failures text[] := '{}';
  f record;
begin
  select * into r from public.food_revisions where id = p_revision_id;
  select * into fi from public.food_items where id = r.food_item_id;

  -- 1. Rights: every cited source record is cleared and its license permits display.
  if exists (
    select 1 from (
      select source_record_id from public.nutrient_values where revision_id = r.id
      union all select source_record_id from public.dietary_claims where revision_id = r.id
      union all select source_record_id from public.allergen_statements where revision_id = r.id
      union all select source_record_id from public.ingredient_family_statements where revision_id = r.id
      union all select source_record_id from public.portions where revision_id = r.id
      union all select rights_record_id from public.recipe_revisions where food_revision_id = r.id
    ) cited
    join public.source_records sr on sr.id = cited.source_record_id
    join public.sources s on s.id = sr.source_id
    left join public.licenses l on l.id = s.license_id
    where sr.rights_status <> 'cleared' or l.id is null or not ('display' = any (l.permitted_uses))
       or (l.expiry is not null and l.expiry < current_date)
  ) then
    v_failures := array_append(v_failures, 'rights_not_cleared');
  end if;

  -- 2. Dietary claims need a freshness due date and no unresolved conflict.
  if exists (select 1 from public.dietary_claims where revision_id = r.id and (expires_at is null or conflict_state = 'disputed')) then
    v_failures := array_append(v_failures, 'dietary_claim_not_publishable');
  end if;

  -- 3. Mass-basis gram nutrients cannot exceed the basis mass (e.g. >100 g protein per 100 g).
  if r.basis_kind = 'mass' and exists (
    select 1 from public.nutrient_values nv join public.nutrient_definitions nd on nd.code = nv.nutrient_code
    where nv.revision_id = r.id and nd.canonical_unit = 'g' and nv.value > r.basis_amount
  ) then
    v_failures := array_append(v_failures, 'impossible_nutrient_value');
  end if;

  -- 4. Recipes need rights evidence and a recorded trial cook.
  if fi.kind = 'recipe' and not exists (
    select 1 from public.recipe_revisions rr where rr.food_revision_id = r.id
      and rr.rights_record_id is not null and rr.trial_cooked_at is not null
  ) then
    v_failures := array_append(v_failures, 'recipe_not_reviewed');
  end if;

  -- 5. (R2) A "suitable" claim cannot stand beside a stated forbidden ingredient.
  for f in select c.diet, fam.code
             from public.dietary_claims c
             join public.ingredient_families fam on (c.diet = 'vegan' and fam.non_vegan) or (c.diet = 'vegetarian' and fam.non_vegetarian)
            where c.revision_id = r.id and c.outcome = 'compatible' loop
    if app.family_presence(r.id, f.code) = 'present' then
      v_failures := array_append(v_failures, 'claim_contradicts_ingredients');
      exit;
    end if;
  end loop;

  -- 6. (R2) A recipe has at least one ingredient and one step.
  if fi.kind = 'recipe' and (
       not exists (select 1 from public.recipe_ingredients ri where ri.recipe_revision_id = r.id)
       or not exists (select 1 from public.recipe_steps rs where rs.recipe_revision_id = r.id)) then
    v_failures := array_append(v_failures, 'recipe_incomplete');
  end if;
  return v_failures;
end;
$$;

create or replace function public.publish_food_revision(p_revision_id uuid, p_expected_item_version integer, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.food_revisions;
  fi public.food_items;
  ch public.catalog_changes;
  v_failures text[];
begin
  if not app.has_role('publisher') then
    raise exception 'FORBIDDEN' using errcode = 'PT403';
  end if;
  select * into r from public.food_revisions where id = p_revision_id for update;
  if not found then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  select * into fi from public.food_items where id = r.food_item_id for update;
  if fi.visibility <> 'public' then
    raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404';
  end if;
  if r.published_at is not null then
    raise exception 'ALREADY_PUBLISHED' using errcode = 'PT409';
  end if;
  if fi.version <> p_expected_item_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;
  -- (R2) Nothing is published on one person's word: the revision must have been
  -- entered and submitted by someone else.
  select * into ch from public.catalog_changes c where c.draft_revision_id = r.id and c.state = 'submitted';
  if ch.id is null or ch.author_id is null or ch.author_id = auth.uid() then
    raise exception 'SECOND_PERSON_REQUIRED' using errcode = 'PT403';
  end if;

  v_failures := app.publish_gate(r.id);
  if cardinality(v_failures) > 0 then
    raise exception 'PUBLISH_GATE_FAILED' using errcode = 'PT422', detail = array_to_string(v_failures, ',');
  end if;

  update public.food_revisions set published_at = now() where id = r.id;
  update public.food_items
     set current_revision_id = r.id, status = 'published', version = version + 1
   where id = fi.id;
  perform app.audit('publish_food_revision', 'food_revision', r.id, p_reason);
  insert into public.outbox_jobs (kind, object_id, dedupe_key)
  values ('cache_invalidate', fi.id, 'publish:' || r.id::text)
  on conflict (dedupe_key) do nothing;

  return jsonb_build_object('foodItemId', fi.id, 'revisionId', r.id, 'itemVersion', fi.version + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Editor helpers
-- ---------------------------------------------------------------------------
create function app.require_editor()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := app.require_member();
begin
  if not app.is_catalog_editor() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  return v;
end;
$$;

-- The license attached to what an editor records: facts only, in the editor's
-- own words. It never covers copied menu text, descriptions or photographs.
insert into public.licenses (id, label, checked_at, permitted_uses, attribution)
values ('00000000-0000-4000-8000-00000000b002',
        'Facts recorded by an editor from a cited source; no text or images copied', now(),
        array['display', 'store', 'derive'], 'Editor record');

create function app.copy_revision_children(p_from uuid, p_to uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.portions select y.* from public.portions x,
    lateral jsonb_populate_record(null::public.portions, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'revision_id', p_to)) y
   where x.revision_id = p_from;
  insert into public.nutrient_values select y.* from public.nutrient_values x,
    lateral jsonb_populate_record(null::public.nutrient_values, to_jsonb(x) || jsonb_build_object('revision_id', p_to)) y
   where x.revision_id = p_from;
  insert into public.dietary_claims select y.* from public.dietary_claims x,
    lateral jsonb_populate_record(null::public.dietary_claims, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'revision_id', p_to)) y
   where x.revision_id = p_from;
  insert into public.allergen_statements select y.* from public.allergen_statements x,
    lateral jsonb_populate_record(null::public.allergen_statements, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'revision_id', p_to)) y
   where x.revision_id = p_from;
  insert into public.ingredient_family_statements select y.* from public.ingredient_family_statements x,
    lateral jsonb_populate_record(null::public.ingredient_family_statements, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'revision_id', p_to)) y
   where x.revision_id = p_from;
  insert into public.recipe_revisions select y.* from public.recipe_revisions x,
    lateral jsonb_populate_record(null::public.recipe_revisions, to_jsonb(x) || jsonb_build_object('food_revision_id', p_to)) y
   where x.food_revision_id = p_from;
  insert into public.recipe_ingredients select y.* from public.recipe_ingredients x,
    lateral jsonb_populate_record(null::public.recipe_ingredients, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'recipe_revision_id', p_to)) y
   where x.recipe_revision_id = p_from;
  insert into public.recipe_steps select y.* from public.recipe_steps x,
    lateral jsonb_populate_record(null::public.recipe_steps, to_jsonb(x) || jsonb_build_object('id', gen_random_uuid(), 'recipe_revision_id', p_to)) y
   where x.recipe_revision_id = p_from;
end;
$$;

-- Everything an editor compares between the published revision and a draft.
create function app.editor_evidence(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revisionId', r.id, 'revisionNo', r.revision_no, 'name', r.name, 'description', r.description,
    'basis', jsonb_build_object('kind', r.basis_kind, 'amount', r.basis_amount, 'unit', r.basis_unit),
    'publishedAt', r.published_at,
    'dietary', coalesce((select jsonb_agg(jsonb_build_object('diet', c.diet, 'outcome', c.outcome, 'evidenceTier', c.evidence_tier,
                 'modifications', c.modifications, 'checkedAt', c.checked_at, 'expiresAt', c.expires_at, 'conflictState', c.conflict_state,
                 'sourceRecordId', c.source_record_id) order by c.diet)
               from public.dietary_claims c where c.revision_id = r.id), '[]'::jsonb),
    'families', coalesce((select jsonb_agg(jsonb_build_object('family', s.family, 'presence', s.presence, 'detail', s.detail,
                 'checkedAt', s.checked_at, 'sourceRecordId', s.source_record_id) order by s.family)
               from public.ingredient_family_statements s where s.revision_id = r.id), '[]'::jsonb),
    'allergens', coalesce((select jsonb_agg(jsonb_build_object('allergen', a.allergen, 'presence', a.presence, 'crossContact', a.cross_contact,
                 'sourceRecordId', a.source_record_id) order by a.allergen)
               from public.allergen_statements a where a.revision_id = r.id), '[]'::jsonb),
    'nutrients', coalesce((select jsonb_agg(jsonb_build_object('code', nv.nutrient_code, 'value', nv.value, 'method', nv.method,
                 'missingReason', nv.missing_reason, 'assumptions', nv.assumptions, 'sourceRecordId', nv.source_record_id) order by nd.display_order)
               from public.nutrient_values nv join public.nutrient_definitions nd on nd.code = nv.nutrient_code
              where nv.revision_id = r.id), '[]'::jsonb),
    'recipe', (select jsonb_build_object('yieldServings', rr.yield_servings, 'prepMinutes', rr.prep_minutes, 'cookMinutes', rr.cook_minutes,
                 'trialCookedAt', rr.trial_cooked_at,
                 'ingredients', coalesce((select jsonb_agg(jsonb_build_object('foodItemId', ir.food_item_id, 'name', ir.name, 'quantity', ri.quantity,
                                  'unit', ri.unit, 'grams', ri.grams, 'optional', ri.optional, 'group', ri.substitution_group) order by ri.position)
                                from public.recipe_ingredients ri join public.food_revisions ir on ir.id = ri.ingredient_revision_id
                               where ri.recipe_revision_id = r.id), '[]'::jsonb),
                 'steps', coalesce((select jsonb_agg(jsonb_build_object('instruction', rs.instruction, 'timerSeconds', rs.timer_seconds, 'title', rs.title) order by rs.ordinal)
                            from public.recipe_steps rs where rs.recipe_revision_id = r.id), '[]'::jsonb))
               from public.recipe_revisions rr where rr.food_revision_id = r.id))
    from public.food_revisions r where r.id = p_revision_id;
$$;

-- The parts of the evidence a visitor's dietary and nutrition answers rest on.
create function app.evidence_core(p_revision_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'dietary', (select jsonb_agg(jsonb_build_array(c.diet, c.outcome, c.evidence_tier, c.modifications, c.conflict_state) order by c.diet)
                  from public.dietary_claims c where c.revision_id = p_revision_id),
    'families', (select jsonb_agg(jsonb_build_array(s.family, s.presence) order by s.family)
                   from public.ingredient_family_statements s where s.revision_id = p_revision_id),
    'allergens', (select jsonb_agg(jsonb_build_array(a.allergen, a.presence, a.cross_contact) order by a.allergen)
                    from public.allergen_statements a where a.revision_id = p_revision_id),
    'nutrients', (select jsonb_agg(jsonb_build_array(nv.nutrient_code, nv.value, nv.method, nv.missing_reason) order by nv.nutrient_code)
                    from public.nutrient_values nv where nv.revision_id = p_revision_id),
    'ingredients', (select jsonb_agg(jsonb_build_array(ri.ingredient_revision_id, ri.quantity, ri.unit, ri.grams, ri.optional, ri.substitution_group) order by ri.position)
                      from public.recipe_ingredients ri where ri.recipe_revision_id = p_revision_id));
$$;

create function app.change_json(ch public.catalog_changes, p_viewer uuid, p_full boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_name text;
  v_kind text;
  v_venue text;
begin
  if ch.kind = 'food' then
    select coalesce(dr.name, cr.name, ch.draft_snapshot ->> 'name'), fi.kind,
           (select vn.name from public.dishes d join public.venues vn on vn.id = d.venue_id where d.food_item_id = fi.id)
      into v_name, v_kind, v_venue
      from (select 1) one
      left join public.food_items fi on fi.id = ch.food_item_id
      left join public.food_revisions dr on dr.id = ch.draft_revision_id
      left join public.food_revisions cr on cr.id = fi.current_revision_id;
  else
    v_name := coalesce(ch.payload ->> 'name', (select vn.name from public.venues vn where vn.id = ch.venue_id));
    v_kind := 'venue';
  end if;
  v := jsonb_build_object(
    'changeId', ch.id, 'kind', ch.kind, 'isNew', ch.is_new, 'state', ch.state, 'summary', ch.summary,
    'target', jsonb_build_object('foodItemId', ch.food_item_id, 'venueId', ch.venue_id, 'name', v_name, 'kind', v_kind, 'venueName', v_venue),
    'author', app.staff_label(ch.author_id), 'authorIsMe', ch.author_id is not distinct from p_viewer,
    'reviewer', app.staff_label(ch.reviewer_id),
    'createdAt', ch.created_at, 'submittedAt', ch.submitted_at, 'reviewedAt', ch.reviewed_at, 'reviewNote', ch.review_note,
    'touchesEvidence', ch.touches_evidence, 'fromCorrection', ch.correction_id is not null,
    'canEdit', ch.state = 'draft' and ch.author_id is not distinct from p_viewer,
    'canReview', ch.state = 'submitted' and ch.author_id is distinct from p_viewer and app.has_role('publisher'));
  if not p_full then return v; end if;
  return v || jsonb_build_object(
    'correction', (select jsonb_build_object('correctionId', c.id, 'field', c.field, 'proposedValue', c.proposed_value,
                                              'evidenceNote', c.evidence_note, 'decisionNote', c.decision_note)
                     from public.corrections c where c.id = ch.correction_id),
    'source', (select jsonb_build_object('publisher', s.publisher, 'sourceType', s.source_type, 'url', s.canonical_url,
                                          'observedAt', sr.observed_at, 'summary', sr.evidence_summary, 'rightsStatus', sr.rights_status)
                 from public.source_records sr join public.sources s on s.id = sr.source_id where sr.id = ch.source_record_id),
    'base', case when ch.base_revision_id is not null then app.editor_evidence(ch.base_revision_id) end,
    'draft', case when ch.draft_revision_id is not null then app.editor_evidence(ch.draft_revision_id) else ch.draft_snapshot end,
    'payload', ch.payload,
    'currentVenue', (select jsonb_build_object('name', vn.name, 'neighborhood', vn.neighborhood, 'street', vn.street, 'locality', vn.locality,
                              'region', vn.region, 'postalCode', vn.postal_code, 'venueType', vn.venue_type, 'status', vn.status,
                              'reviewedAt', vn.reviewed_at)
                       from public.venues vn where vn.id = ch.venue_id),
    'gate', case when ch.kind = 'food' and ch.draft_revision_id is not null and ch.state in ('draft', 'submitted')
                 then to_jsonb(array_remove(app.publish_gate(ch.draft_revision_id), 'rights_not_cleared')) else '[]'::jsonb end,
    'isDemo', case when ch.kind = 'food' then (select fi.is_demo from public.food_items fi where fi.id = ch.food_item_id)
                   else coalesce((select vn.is_demo from public.venues vn where vn.id = ch.venue_id), app.entry_is_demo()) end,
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'at', a.occurred_at, 'by', app.staff_label(a.actor_id), 'note', a.reason) order by a.occurred_at)
                           from public.audit_events a where a.entity_type = 'catalog_change' and a.entity_id = ch.id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Editor functions (callable by signed-in staff; each checks the role)
-- ---------------------------------------------------------------------------

-- Start a change to a published food, optionally from an accepted correction.
create function public.editor_start_change(p_food_item_id uuid, p_correction_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  fi public.food_items;
  cur public.food_revisions;
  v_rev uuid := gen_random_uuid();
  v_id uuid;
begin
  select * into fi from public.food_items where id = p_food_item_id and visibility = 'public' and status = 'published' for update;
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  if p_correction_id is not null and not exists (
       select 1 from public.corrections c where c.id = p_correction_id and c.state = 'accepted'
          and c.food_item_id = p_food_item_id and c.applied_change_id is null) then
    raise exception 'CORRECTION_NOT_ACCEPTED' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.catalog_changes c where c.food_item_id = p_food_item_id and c.state in ('draft', 'submitted')) then
    raise exception 'CHANGE_ALREADY_OPEN' using errcode = 'PT409';
  end if;
  select * into cur from public.food_revisions where id = fi.current_revision_id;
  insert into public.food_revisions (id, food_item_id, revision_no, name, description, preparation_state, brand, gtin, basis_kind, basis_amount, basis_unit)
  values (v_rev, fi.id, (select max(revision_no) + 1 from public.food_revisions where food_item_id = fi.id),
          cur.name, cur.description, cur.preparation_state, cur.brand, cur.gtin, cur.basis_kind, cur.basis_amount, cur.basis_unit);
  perform app.copy_revision_children(cur.id, v_rev);
  insert into public.catalog_changes (kind, food_item_id, base_revision_id, draft_revision_id, correction_id, author_id)
  values ('food', fi.id, cur.id, v_rev, p_correction_id, v_uid) returning id into v_id;
  perform app.audit('catalog_change.started', 'catalog_change', v_id, case when p_correction_id is not null then 'from an accepted correction' end);
  return jsonb_build_object('changeId', v_id);
end;
$$;

-- Enter a new dish (at a published place) or a new recipe. Nothing is public
-- until a second person has checked and published it.
create function public.editor_new_food(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  v_kind text := p ->> 'kind';
  v_name text := app.clean_text(p ->> 'name', 200);
  v_venue uuid;
  v_item uuid := gen_random_uuid();
  v_rev uuid := gen_random_uuid();
  v_id uuid;
begin
  if v_kind is null or v_kind not in ('dish', 'recipe') then raise exception 'INVALID_KIND' using errcode = 'PT422'; end if;
  if v_name is null then raise exception 'NAME_REQUIRED' using errcode = 'PT422'; end if;
  if v_kind = 'dish' then
    begin
      v_venue := (p ->> 'venueId')::uuid;
    exception when others then
      raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404';
    end;
    if not exists (select 1 from public.venues v where v.id = v_venue and v.status in ('published', 'temporarily_closed')) then
      raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404';
    end if;
  end if;
  insert into public.food_items (id, kind, visibility, status, is_demo) values (v_item, v_kind, 'public', 'draft', app.entry_is_demo());
  insert into public.food_revisions (id, food_item_id, revision_no, name, description, preparation_state, basis_kind, basis_amount, basis_unit)
  values (v_rev, v_item, 1, v_name, app.clean_text(p ->> 'description', 4000), 'prepared', 'serving', 1, 'serving');
  -- One stated serving, so the entry can be logged in a diary as "1 serving". No weight is
  -- invented: grams stay empty until a source gives them.
  insert into public.portions (revision_id, label, amount, unit) values (v_rev, '1 serving', 1, 'serving');
  if v_kind = 'dish' then
    insert into public.dishes (food_item_id, venue_id, menu_section) values (v_item, v_venue, app.clean_text(p ->> 'menuSection', 120));
  else
    insert into public.recipe_revisions (food_revision_id, yield_servings) values (v_rev, 2);
  end if;
  insert into public.catalog_changes (kind, is_new, food_item_id, draft_revision_id, author_id)
  values ('food', true, v_item, v_rev, v_uid) returning id into v_id;
  perform app.audit('catalog_change.started', 'catalog_change', v_id, 'new ' || v_kind);
  return jsonb_build_object('changeId', v_id);
end;
$$;

-- Propose a new place, or a change to an existing one. The proposal is held
-- apart from the public record until a second person has checked it.
create function public.editor_start_venue_change(p_venue_id uuid default null, p_correction_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  v public.venues;
  v_id uuid;
begin
  if p_venue_id is not null then
    select * into v from public.venues where id = p_venue_id and status in ('published', 'temporarily_closed', 'closed');
    if not found then raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404'; end if;
    if exists (select 1 from public.catalog_changes c where c.venue_id = p_venue_id and c.state in ('draft', 'submitted')) then
      raise exception 'CHANGE_ALREADY_OPEN' using errcode = 'PT409';
    end if;
  end if;
  if p_correction_id is not null and (p_venue_id is null or not exists (
       select 1 from public.corrections c where c.id = p_correction_id and c.state = 'accepted'
          and c.venue_id = p_venue_id and c.applied_change_id is null)) then
    raise exception 'CORRECTION_NOT_ACCEPTED' using errcode = 'PT409';
  end if;
  insert into public.catalog_changes (kind, is_new, venue_id, correction_id, author_id, payload)
  values ('venue', p_venue_id is null, p_venue_id, p_correction_id, v_uid,
          case when p_venue_id is null then '{}'::jsonb else jsonb_build_object(
            'name', v.name, 'neighborhood', v.neighborhood, 'street', v.street, 'locality', v.locality, 'region', v.region,
            'postalCode', v.postal_code, 'venueType', v.venue_type, 'status', v.status) end)
  returning id into v_id;
  perform app.audit('catalog_change.started', 'catalog_change', v_id, case when p_venue_id is null then 'new place' end);
  return jsonb_build_object('changeId', v_id);
end;
$$;

-- Save the author's work on a draft. `p_patch` holds only the parts that changed.
create function public.editor_save_change(p_change_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  ch public.catalog_changes;
  fi public.food_items;
  v_src jsonb := p_patch -> 'source';
  v_source uuid;
  v_record uuid;
  v_expire integer;
  v_expires timestamptz;
  x jsonb;
  v_pos integer;
  v_ing uuid;
  v_text text;
  v_venue jsonb;
begin
  select * into ch from public.catalog_changes where id = p_change_id for update;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  if ch.author_id is distinct from v_uid then raise exception 'NOT_YOUR_DRAFT' using errcode = 'PT403'; end if;
  if ch.state <> 'draft' then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH' using errcode = 'PT422'; end if;

  begin
    if p_patch ? 'summary' then
      update public.catalog_changes set summary = app.clean_text(p_patch ->> 'summary', 500) where id = ch.id;
    end if;

    -- The source of this change: who says so, where it was seen, and when.
    if v_src is not null and jsonb_typeof(v_src) = 'object' then
      if app.clean_text(v_src ->> 'publisher', 200) is null or app.clean_text(v_src ->> 'summary', 2000) is null
         or (v_src ->> 'observedOn') is null then
        raise exception 'SOURCE_INCOMPLETE' using errcode = 'PT422';
      end if;
      if (v_src ->> 'observedOn')::date > current_date + 1 then raise exception 'SOURCE_INCOMPLETE' using errcode = 'PT422'; end if;
      if ch.source_record_id is null then
        insert into public.sources (publisher, source_type, canonical_url, license_id, access_scope, is_demo, retrieved_at)
        values (app.clean_text(v_src ->> 'publisher', 200), v_src ->> 'sourceType', nullif(btrim(coalesce(v_src ->> 'url', '')), ''),
                '00000000-0000-4000-8000-00000000b002', 'public', app.entry_is_demo(), now())
        returning id into v_source;
        insert into public.source_records (source_id, observed_at, evidence_summary, rights_status)
        values (v_source, (v_src ->> 'observedOn')::date, app.clean_text(v_src ->> 'summary', 2000), 'unreviewed')
        returning id into v_record;
        update public.catalog_changes set source_record_id = v_record where id = ch.id;
        ch.source_record_id := v_record;
      else
        update public.source_records set observed_at = (v_src ->> 'observedOn')::date, evidence_summary = app.clean_text(v_src ->> 'summary', 2000)
         where id = ch.source_record_id returning source_id into v_source;
        update public.sources set publisher = app.clean_text(v_src ->> 'publisher', 200), source_type = v_src ->> 'sourceType',
               canonical_url = nullif(btrim(coalesce(v_src ->> 'url', '')), '') where id = v_source;
      end if;
    end if;

    if ch.kind = 'venue' then
      v_venue := p_patch -> 'venue';
      if v_venue is not null and jsonb_typeof(v_venue) = 'object' then
        if app.clean_text(v_venue ->> 'name', 200) is null then raise exception 'NAME_REQUIRED' using errcode = 'PT422'; end if;
        if coalesce(v_venue ->> 'venueType', 'restaurant') not in ('restaurant', 'cafe', 'bakery', 'food_truck', 'market_stall', 'other')
           or coalesce(v_venue ->> 'status', 'published') not in ('published', 'temporarily_closed', 'closed') then
          raise exception 'INVALID_PATCH' using errcode = 'PT422';
        end if;
        if (v_venue ? 'lat' and (v_venue ->> 'lat') is not null and not ((v_venue ->> 'lat')::numeric between -90 and 90))
           or (v_venue ? 'lon' and (v_venue ->> 'lon') is not null and not ((v_venue ->> 'lon')::numeric between -180 and 180)) then
          raise exception 'INVALID_PATCH' using errcode = 'PT422';
        end if;
        update public.catalog_changes set payload = jsonb_build_object(
            'name', app.clean_text(v_venue ->> 'name', 200), 'neighborhood', app.clean_text(v_venue ->> 'neighborhood', 120),
            'street', app.clean_text(v_venue ->> 'street', 200), 'locality', app.clean_text(v_venue ->> 'locality', 120),
            'region', app.clean_text(v_venue ->> 'region', 60), 'postalCode', app.clean_text(v_venue ->> 'postalCode', 20),
            'venueType', coalesce(v_venue ->> 'venueType', 'restaurant'), 'status', coalesce(v_venue ->> 'status', 'published'),
            'lat', (v_venue ->> 'lat')::numeric, 'lon', (v_venue ->> 'lon')::numeric,
            'hours', app.clean_text(v_venue ->> 'hours', 500), 'statusNote', app.clean_text(v_venue ->> 'statusNote', 300))
         where id = ch.id;
      end if;
      return jsonb_build_object('changeId', ch.id, 'saved', true);
    end if;

    select * into fi from public.food_items where id = ch.food_item_id;
    select coalesce(f.expire_days, f.review_days) into v_expire from app.freshness_rules f
     where f.subject = case when fi.kind in ('dish', 'packaged', 'ingredient', 'recipe') then fi.kind else 'dish' end;
    v_expires := now() + make_interval(days => v_expire);

    if p_patch ? 'name' then
      if app.clean_text(p_patch ->> 'name', 200) is null then raise exception 'NAME_REQUIRED' using errcode = 'PT422'; end if;
      update public.food_revisions set name = app.clean_text(p_patch ->> 'name', 200) where id = ch.draft_revision_id;
    end if;
    if p_patch ? 'description' then
      update public.food_revisions set description = app.clean_text(p_patch ->> 'description', 4000) where id = ch.draft_revision_id;
    end if;

    -- Dietary, ingredient, allergen and nutrition statements always carry this change's source.
    if (p_patch ?| array['dietary', 'families', 'allergens', 'nutrients', 'recipe']) or coalesce((p_patch ->> 'reconfirm')::boolean, false) then
      if ch.source_record_id is null then raise exception 'SOURCE_REQUIRED' using errcode = 'PT422'; end if;
    end if;

    for x in select * from jsonb_array_elements(coalesce(p_patch -> 'dietary', '[]'::jsonb)) loop
      if coalesce((x ->> 'remove')::boolean, false) then
        delete from public.dietary_claims where revision_id = ch.draft_revision_id and diet = x ->> 'diet';
      else
        insert into public.dietary_claims (revision_id, diet, outcome, evidence_tier, source_record_id, modifications, checked_at, expires_at, conflict_state)
        values (ch.draft_revision_id, x ->> 'diet', x ->> 'outcome', coalesce(x ->> 'evidenceTier', 'documented'), ch.source_record_id,
                app.clean_text(x ->> 'modifications', 1000), now(), v_expires, 'none')
        on conflict (revision_id, diet) do update set outcome = excluded.outcome, evidence_tier = excluded.evidence_tier,
          source_record_id = excluded.source_record_id, modifications = excluded.modifications, checked_at = excluded.checked_at,
          expires_at = excluded.expires_at, conflict_state = 'none';
      end if;
    end loop;

    for x in select * from jsonb_array_elements(coalesce(p_patch -> 'families', '[]'::jsonb)) loop
      insert into public.ingredient_family_statements (revision_id, family, presence, source_record_id, detail, checked_at, expires_at)
      values (ch.draft_revision_id, x ->> 'family', x ->> 'presence',
              case when x ->> 'presence' = 'unknown' then null else ch.source_record_id end,
              app.clean_text(x ->> 'detail', 500), now(), v_expires)
      on conflict (revision_id, family) do update set presence = excluded.presence, source_record_id = excluded.source_record_id,
        detail = excluded.detail, checked_at = excluded.checked_at, expires_at = excluded.expires_at;
    end loop;

    for x in select * from jsonb_array_elements(coalesce(p_patch -> 'allergens', '[]'::jsonb)) loop
      insert into public.allergen_statements (revision_id, allergen, presence, cross_contact, source_record_id, checked_at)
      values (ch.draft_revision_id, x ->> 'allergen', x ->> 'presence', coalesce(x ->> 'crossContact', 'unknown'), ch.source_record_id, now())
      on conflict (revision_id, allergen) do update set presence = excluded.presence, cross_contact = excluded.cross_contact,
        source_record_id = excluded.source_record_id, checked_at = excluded.checked_at;
    end loop;

    -- Nutrition: a number always has a method and this source; "not known" stays empty, never zero.
    for x in select * from jsonb_array_elements(coalesce(p_patch -> 'nutrients', '[]'::jsonb)) loop
      if (x ->> 'value') is null or btrim(x ->> 'value') = '' then
        insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason, source_record_id)
        values (ch.draft_revision_id, x ->> 'code', null, 'unknown', coalesce(x ->> 'missingReason', 'not_provided'), null)
        on conflict (revision_id, nutrient_code) do update set value = null, lower_value = null, upper_value = null, method = 'unknown',
          missing_reason = excluded.missing_reason, source_record_id = null, assumptions = null;
      else
        if coalesce(x ->> 'method', '') not in ('published', 'calculated', 'estimated') then
          raise exception 'INVALID_PATCH' using errcode = 'PT422';
        end if;
        insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id, assumptions)
        values (ch.draft_revision_id, x ->> 'code', (x ->> 'value')::numeric, x ->> 'method', ch.source_record_id, app.clean_text(x ->> 'assumptions', 1000))
        on conflict (revision_id, nutrient_code) do update set value = excluded.value, lower_value = null, upper_value = null,
          method = excluded.method, missing_reason = null, source_record_id = excluded.source_record_id, assumptions = excluded.assumptions;
      end if;
    end loop;

    -- "I checked all of this again against the source": every statement gets today's date and this source.
    if coalesce((p_patch ->> 'reconfirm')::boolean, false) then
      update public.dietary_claims set source_record_id = ch.source_record_id, checked_at = now(), expires_at = v_expires, conflict_state = 'none'
       where revision_id = ch.draft_revision_id and evidence_tier <> 'unknown';
      update public.ingredient_family_statements set source_record_id = ch.source_record_id, checked_at = now(), expires_at = v_expires
       where revision_id = ch.draft_revision_id and presence <> 'unknown';
      update public.allergen_statements set source_record_id = ch.source_record_id, checked_at = now()
       where revision_id = ch.draft_revision_id and presence <> 'unknown';
    end if;

    x := p_patch -> 'recipe';
    if x is not null and jsonb_typeof(x) = 'object' then
      if fi.kind <> 'recipe' then raise exception 'INVALID_PATCH' using errcode = 'PT422'; end if;
      update public.recipe_revisions
         set yield_servings = coalesce((x ->> 'yieldServings')::numeric, yield_servings),
             prep_minutes = case when x ? 'prepMinutes' then (x ->> 'prepMinutes')::integer else prep_minutes end,
             cook_minutes = case when x ? 'cookMinutes' then (x ->> 'cookMinutes')::integer else cook_minutes end,
             trial_cooked_at = case when x ? 'trialCookedOn' then (x ->> 'trialCookedOn')::date else trial_cooked_at end,
             rights_record_id = ch.source_record_id
       where food_revision_id = ch.draft_revision_id;
      if x ? 'steps' then
        delete from public.recipe_steps where recipe_revision_id = ch.draft_revision_id;
        v_pos := 0;
        for v_text in select app.clean_text(s ->> 'instruction', 2000) from jsonb_array_elements(x -> 'steps') s loop
          if v_text is not null then
            v_pos := v_pos + 1;
            insert into public.recipe_steps (recipe_revision_id, ordinal, instruction) values (ch.draft_revision_id, v_pos, v_text);
          end if;
        end loop;
      end if;
      if x ? 'ingredients' then
        delete from public.recipe_ingredients where recipe_revision_id = ch.draft_revision_id;
        v_pos := 0;
        for x in select * from jsonb_array_elements(p_patch -> 'recipe' -> 'ingredients') loop
          select i.current_revision_id into v_ing from public.food_items i
           where i.id = (x ->> 'foodItemId')::uuid and i.visibility = 'public' and i.status = 'published' and i.kind in ('ingredient', 'packaged');
          if v_ing is null then raise exception 'INGREDIENT_NOT_FOUND' using errcode = 'PT422'; end if;
          v_pos := v_pos + 1;
          insert into public.recipe_ingredients (recipe_revision_id, ingredient_revision_id, position, quantity, unit, grams, optional, included_by_default)
          values (ch.draft_revision_id, v_ing, v_pos, (x ->> 'quantity')::numeric, coalesce(nullif(btrim(x ->> 'unit'), ''), 'g'),
                  (x ->> 'grams')::numeric, coalesce((x ->> 'optional')::boolean, false), true);
        end loop;
      end if;
    end if;

    -- Menu section and price are applied only when the change is published.
    x := p_patch -> 'dish';
    if x is not null and jsonb_typeof(x) = 'object' then
      if fi.kind <> 'dish' then raise exception 'INVALID_PATCH' using errcode = 'PT422'; end if;
      if (x ->> 'priceCents') is not null and ((x ->> 'priceCents')::integer <= 0 or ch.source_record_id is null) then
        raise exception 'SOURCE_REQUIRED' using errcode = 'PT422';
      end if;
      update public.catalog_changes set payload = payload || jsonb_build_object('dish', jsonb_build_object(
          'menuSection', app.clean_text(x ->> 'menuSection', 120), 'priceCents', (x ->> 'priceCents')::integer,
          'servingDescription', app.clean_text(x ->> 'servingDescription', 200))) where id = ch.id;
    end if;
  exception
    when check_violation or not_null_violation or foreign_key_violation or invalid_text_representation
      or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
      raise exception 'INVALID_PATCH' using errcode = 'PT422';
  end;
  return jsonb_build_object('changeId', ch.id, 'saved', true);
end;
$$;

create function public.editor_submit_change(p_change_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  ch public.catalog_changes;
begin
  select * into ch from public.catalog_changes where id = p_change_id for update;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  if ch.author_id is distinct from v_uid then raise exception 'NOT_YOUR_DRAFT' using errcode = 'PT403'; end if;
  if ch.state <> 'draft' then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  if ch.summary is null then raise exception 'SUMMARY_REQUIRED' using errcode = 'PT422'; end if;
  if ch.source_record_id is null then raise exception 'SOURCE_REQUIRED' using errcode = 'PT422'; end if;
  if ch.kind = 'venue' and (ch.payload ->> 'name') is null then raise exception 'NAME_REQUIRED' using errcode = 'PT422'; end if;
  update public.catalog_changes
     set state = 'submitted', submitted_at = now(),
         draft_snapshot = case when ch.kind = 'food' then app.editor_evidence(ch.draft_revision_id) end,
         touches_evidence = case when ch.kind = 'food'
           then ch.base_revision_id is null or app.evidence_core(ch.base_revision_id) is distinct from app.evidence_core(ch.draft_revision_id) end
   where id = ch.id;
  perform app.audit('catalog_change.submitted', 'catalog_change', ch.id, ch.summary);
  return jsonb_build_object('changeId', ch.id, 'state', 'submitted');
end;
$$;

-- Removes an unpublished draft so nothing half-finished is left in the catalog.
create function app.discard_draft(ch public.catalog_changes)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if ch.kind <> 'food' or ch.draft_revision_id is null then return; end if;
  update public.catalog_changes set draft_snapshot = coalesce(draft_snapshot, app.editor_evidence(ch.draft_revision_id)) where id = ch.id;
  if ch.is_new then
    -- The change row is kept as the record; its link to the unpublished item is cleared first.
    update public.catalog_changes set food_item_id = null, draft_revision_id = null where id = ch.id;
    delete from public.food_items where id = ch.food_item_id and current_revision_id is null;
  else
    delete from public.food_revisions where id = ch.draft_revision_id and published_at is null;
  end if;
end;
$$;

create function public.editor_withdraw_change(p_change_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  ch public.catalog_changes;
begin
  select * into ch from public.catalog_changes where id = p_change_id for update;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  if ch.author_id is distinct from v_uid then raise exception 'NOT_YOUR_DRAFT' using errcode = 'PT403'; end if;
  if ch.state not in ('draft', 'submitted') then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  update public.catalog_changes set state = 'withdrawn' where id = ch.id;
  perform app.discard_draft(ch);
  perform app.audit('catalog_change.withdrawn', 'catalog_change', ch.id, null);
  return jsonb_build_object('changeId', ch.id, 'state', 'withdrawn');
end;
$$;

-- The second person's decision. Approving publishes; nothing else does.
create function public.editor_review_change(
  p_change_id uuid, p_decision text, p_note text default null,
  p_source_checked boolean default false, p_rights_ok boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  ch public.catalog_changes;
  fi public.food_items;
  v_note text := app.clean_text(p_note, 500);
  v_dish jsonb;
  v_venue uuid;
  v_market public.markets;
  p jsonb;
begin
  if not app.has_role('publisher') then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  select * into ch from public.catalog_changes where id = p_change_id for update;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  if ch.state <> 'submitted' then raise exception 'WRONG_STATE' using errcode = 'PT409'; end if;
  if ch.author_id is null or ch.author_id = v_uid then raise exception 'SECOND_PERSON_REQUIRED' using errcode = 'PT403'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'INVALID_ACTION' using errcode = 'PT422'; end if;

  if p_decision = 'reject' then
    if v_note is null then raise exception 'REASON_REQUIRED' using errcode = 'PT422'; end if;
    update public.catalog_changes set state = 'rejected', reviewer_id = v_uid, reviewed_at = now(), review_note = v_note where id = ch.id;
    perform app.discard_draft(ch);
    perform app.audit('catalog_change.rejected', 'catalog_change', ch.id, v_note);
    return jsonb_build_object('changeId', ch.id, 'state', 'rejected');
  end if;

  -- The checker confirms two things in person: the source says what the entry says,
  -- and nothing was copied that we have no right to show.
  if not coalesce(p_source_checked, false) or not coalesce(p_rights_ok, false) then
    raise exception 'CHECKS_REQUIRED' using errcode = 'PT422';
  end if;
  update public.source_records set rights_status = 'cleared' where id = ch.source_record_id;

  if ch.kind = 'food' then
    select * into fi from public.food_items where id = ch.food_item_id;
    perform public.publish_food_revision(ch.draft_revision_id, fi.version, v_note);
    v_dish := ch.payload -> 'dish';
    if v_dish is not null then
      update public.dishes set menu_section = coalesce(v_dish ->> 'menuSection', menu_section) where food_item_id = fi.id;
      if (v_dish ->> 'priceCents') is not null then
        insert into public.dish_prices (dish_id, amount_minor, serving_description, checked_at, source_record_id)
        values (fi.id, (v_dish ->> 'priceCents')::integer, v_dish ->> 'servingDescription', now(), ch.source_record_id);
      end if;
    end if;
    update public.review_flags set resolved_at = now(), resolved_change_id = ch.id where food_item_id = fi.id and resolved_at is null;
  else
    p := ch.payload;
    if ch.venue_id is null then
      select * into v_market from public.markets m where m.slug = 'boston';
      insert into public.venues (market_id, slug, name, neighborhood, street, locality, region, postal_code, location, timezone, venue_type, status, is_demo, reviewed_at)
      values (v_market.id,
              left(trim(both '-' from regexp_replace(lower(p ->> 'name'), '[^a-z0-9]+', '-', 'g')), 100) || '-' || left(ch.id::text, 8),
              p ->> 'name', p ->> 'neighborhood', p ->> 'street', p ->> 'locality', p ->> 'region', p ->> 'postalCode',
              case when (p ->> 'lat') is not null and (p ->> 'lon') is not null
                   then extensions.st_setsrid(extensions.st_makepoint((p ->> 'lon')::double precision, (p ->> 'lat')::double precision), 4326)::extensions.geography end,
              v_market.default_timezone, p ->> 'venueType', p ->> 'status', app.entry_is_demo(), now())
      returning id into v_venue;
    else
      v_venue := ch.venue_id;
      update public.venues v
         set name = p ->> 'name', neighborhood = p ->> 'neighborhood', street = p ->> 'street', locality = p ->> 'locality',
             region = p ->> 'region', postal_code = p ->> 'postalCode', venue_type = p ->> 'venueType', status = p ->> 'status',
             location = case when (p ->> 'lat') is not null and (p ->> 'lon') is not null
                   then extensions.st_setsrid(extensions.st_makepoint((p ->> 'lon')::double precision, (p ->> 'lat')::double precision), 4326)::extensions.geography
                   else v.location end,
             reviewed_at = now()
       where v.id = v_venue;
    end if;
    if (p ->> 'hours') is not null then
      insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at, expires_at)
      values (v_venue, 'hours', jsonb_build_object('text', p ->> 'hours'), ch.source_record_id, now(), now() + interval '60 days');
    end if;
    if (p ->> 'statusNote') is not null then
      insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at, expires_at)
      values (v_venue, 'status_note', jsonb_build_object('text', p ->> 'statusNote'), ch.source_record_id, now(), now() + interval '60 days');
    end if;
    update public.catalog_changes set venue_id = v_venue where id = ch.id;
  end if;

  update public.catalog_changes
     set state = 'published', reviewer_id = v_uid, reviewed_at = now(), review_note = v_note,
         draft_snapshot = case when ch.kind = 'food' then app.editor_evidence(ch.draft_revision_id) end
   where id = ch.id;
  if ch.correction_id is not null then
    update public.corrections set applied_change_id = ch.id where id = ch.correction_id;
  end if;
  perform app.audit('catalog_change.published', 'catalog_change', ch.id, v_note);
  return jsonb_build_object('changeId', ch.id, 'state', 'published', 'venueId', v_venue, 'foodItemId', ch.food_item_id);
end;
$$;

-- "Needs review": one editor may pull a record out of every dietary filter at
-- once when evidence conflicts. It only ever makes the answer more cautious.
create function public.editor_flag_needs_review(p_food_item_id uuid, p_reason text, p_correction_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  fi public.food_items;
  v_reason text := app.clean_text(p_reason, 500);
  v_id uuid;
begin
  if v_reason is null or length(v_reason) < 3 then raise exception 'REASON_REQUIRED' using errcode = 'PT422'; end if;
  select * into fi from public.food_items where id = p_food_item_id and visibility = 'public' and status = 'published';
  if not found then raise exception 'FOOD_NOT_FOUND' using errcode = 'PT404'; end if;
  if exists (select 1 from public.review_flags rf where rf.food_item_id = fi.id and rf.resolved_at is null) then
    raise exception 'ALREADY_FLAGGED' using errcode = 'PT409';
  end if;
  insert into public.review_flags (food_item_id, flagged_revision_id, reason, correction_id, raised_by)
  values (fi.id, fi.current_revision_id, v_reason, p_correction_id, v_uid) returning id into v_id;
  perform app.audit('catalog.flag_needs_review', 'food_item', fi.id, left(v_reason, 300));
  insert into public.outbox_jobs (kind, object_id, dedupe_key) values ('cache_invalidate', fi.id, 'flag:' || v_id::text)
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('flagId', v_id, 'foodItemId', fi.id);
end;
$$;

create function public.editor_change(p_change_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  ch public.catalog_changes;
begin
  select * into ch from public.catalog_changes where id = p_change_id;
  if not found then raise exception 'CHANGE_NOT_FOUND' using errcode = 'PT404'; end if;
  return app.change_json(ch, v_uid, true);
end;
$$;

-- The editors' desk: what is waiting, for whom.
create function public.editor_desk()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := app.require_editor();
begin
  return jsonb_build_object(
    'practiceMode', app.entry_is_demo(),
    'canPublish', app.has_role('publisher'),
    'myDrafts', coalesce((select jsonb_agg(app.change_json(c, v_uid, false) order by c.created_at desc)
                            from public.catalog_changes c where c.state = 'draft' and c.author_id = v_uid), '[]'::jsonb),
    'awaitingCheck', coalesce((select jsonb_agg(app.change_json(c, v_uid, false) order by c.submitted_at)
                                 from public.catalog_changes c where c.state = 'submitted'), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(app.change_json(c, v_uid, false) order by coalesce(c.reviewed_at, c.created_at) desc)
                          from (select * from public.catalog_changes c where c.state in ('published', 'rejected', 'withdrawn')
                                 order by coalesce(c.reviewed_at, c.created_at) desc limit 20) c), '[]'::jsonb),
    'acceptedCorrections', coalesce((
      select jsonb_agg(jsonb_build_object('correctionId', c.id, 'field', c.field, 'proposedValue', c.proposed_value, 'decidedAt', c.decided_at,
               'foodItemId', c.food_item_id, 'venueId', c.venue_id,
               'target', app.social_target(c.venue_id, c.food_item_id, 'none', '{}', false, true),
               'openChangeId', (select ch.id from public.catalog_changes ch where ch.correction_id = c.id and ch.state in ('draft', 'submitted') limit 1))
             order by c.decided_at)
        from public.corrections c where c.state = 'accepted' and c.applied_change_id is null), '[]'::jsonb),
    'flags', coalesce((
      select jsonb_agg(jsonb_build_object('flagId', rf.id, 'foodItemId', rf.food_item_id, 'name', r.name, 'reason', rf.reason,
               'raisedAt', rf.raised_at, 'raisedBy', app.staff_label(rf.raised_by),
               'openChangeId', (select ch.id from public.catalog_changes ch where ch.food_item_id = rf.food_item_id and ch.state in ('draft', 'submitted') limit 1))
             order by rf.raised_at)
        from public.review_flags rf join public.food_revisions r on r.id = rf.flagged_revision_id where rf.resolved_at is null), '[]'::jsonb),
    'outOfDate', coalesce((
      select jsonb_agg(x.j order by x.checked nulls first)
        from (select jsonb_build_object('kind', fi.kind, 'foodItemId', fi.id, 'name', r.name)
                     || app.freshness_json(case when fi.kind in ('dish', 'packaged', 'ingredient', 'recipe') then fi.kind else 'dish' end, r.published_at) as j,
                     r.published_at as checked
                from public.food_items fi join public.food_revisions r on r.id = fi.current_revision_id
               where fi.visibility = 'public' and fi.status = 'published'
                 and app.freshness_json(case when fi.kind in ('dish', 'packaged', 'ingredient', 'recipe') then fi.kind else 'dish' end, r.published_at) ->> 'state' <> 'current'
              union all
              select jsonb_build_object('kind', 'venue', 'venueId', v.id, 'name', v.name) || app.freshness_json('venue', v.reviewed_at), v.reviewed_at
                from public.venues v
               where v.status in ('published', 'temporarily_closed') and app.freshness_json('venue', v.reviewed_at) ->> 'state' <> 'current'
               limit 60) x), '[]'::jsonb));
end;
$$;

-- Find a published record to change or flag.
create function public.editor_items(p_query text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  v_q text := app.clean_text(p_query, 80);
begin
  return jsonb_build_object(
    'foods', coalesce((
      select jsonb_agg(x.j order by x.name)
        from (select r.name, jsonb_build_object('foodItemId', fi.id, 'kind', fi.kind, 'name', r.name, 'isDemo', fi.is_demo,
                       'venueName', (select vn.name from public.dishes d join public.venues vn on vn.id = d.venue_id where d.food_item_id = fi.id),
                       'revisionNo', r.revision_no, 'publishedAt', r.published_at,
                       'flagged', exists (select 1 from public.review_flags rf where rf.food_item_id = fi.id and rf.resolved_at is null),
                       'openChangeId', (select ch.id from public.catalog_changes ch where ch.food_item_id = fi.id and ch.state in ('draft', 'submitted') limit 1)) as j
                from public.food_items fi join public.food_revisions r on r.id = fi.current_revision_id
               where fi.visibility = 'public' and fi.status = 'published'
                 and (v_q is null or r.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
               order by r.name limit 40) x), '[]'::jsonb),
    'venues', coalesce((
      select jsonb_agg(x.j order by x.name)
        from (select v.name, jsonb_build_object('venueId', v.id, 'name', v.name, 'neighborhood', v.neighborhood, 'status', v.status, 'isDemo', v.is_demo,
                       'reviewedAt', v.reviewed_at,
                       'openChangeId', (select ch.id from public.catalog_changes ch where ch.venue_id = v.id and ch.state in ('draft', 'submitted') limit 1)) as j
                from public.venues v
               where v.status in ('published', 'temporarily_closed', 'closed')
                 and (v_q is null or v.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
               order by v.name limit 40) x), '[]'::jsonb),
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object('foodItemId', fi.id, 'name', r.name) order by r.name)
        from public.food_items fi join public.food_revisions r on r.id = fi.current_revision_id
       where fi.visibility = 'public' and fi.status = 'published' and fi.kind in ('ingredient', 'packaged')), '[]'::jsonb));
end;
$$;

-- Counts for the staff banner. Each person sees only the queues their roles open.
create function public.staff_alerts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_member();
  v jsonb := '{}'::jsonb;
begin
  if not app.is_staff() then raise exception 'FORBIDDEN' using errcode = 'PT403'; end if;
  if app.is_moderator() then
    v := v || jsonb_build_object(
      'pendingPosts', (select count(*) from public.reviews r where r.publication_state = 'pending')
                    + (select count(*) from public.food_lists l where l.publication_state = 'pending')
                    + (select count(*) from public.ranking_publications rp where rp.publication_state = 'pending' and rp.withdrawn_at is null),
      'openReports', (select count(*) from public.reports rep where rep.state = 'open'),
      'repeatedReports', (select count(*) from (select 1 from public.reports rep where rep.state = 'open'
                                                 group by rep.target_type, rep.target_id having count(*) >= 3) q),
      'suspendedMembers', (select count(*) from public.member_standing s where s.suspended_at is not null));
  end if;
  if app.is_catalog_editor() then
    v := v || jsonb_build_object(
      'openCorrections', (select count(*) from public.corrections c where c.state = 'open'),
      'acceptedNotApplied', (select count(*) from public.corrections c where c.state = 'accepted' and c.applied_change_id is null),
      'awaitingCheck', (select count(*) from public.catalog_changes c where c.state = 'submitted' and c.author_id is distinct from v_uid),
      'myDrafts', (select count(*) from public.catalog_changes c where c.state = 'draft' and c.author_id = v_uid),
      'needsReview', (select count(*) from public.review_flags rf where rf.resolved_at is null));
  end if;
  return v || jsonb_build_object('isModerator', app.is_moderator(), 'isEditor', app.is_catalog_editor(), 'canPublish', app.has_role('publisher'));
end;
$$;

-- The corrections queue now also shows what became of each accepted correction.
create or replace function public.corrections_queue()
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
               'decisionNote', c.decision_note, 'at', c.decided_at, 'foodItemId', c.food_item_id, 'venueId', c.venue_id,
               'appliedChangeId', c.applied_change_id,
               'openChangeId', (select ch.id from public.catalog_changes ch where ch.correction_id = c.id and ch.state in ('draft', 'submitted') limit 1),
               'target', app.social_target(c.venue_id, c.food_item_id, 'none', '{}', false, true)) order by c.decided_at desc)
        from (select * from public.corrections c where c.state <> 'open' order by c.decided_at desc limit 30) c), '[]'::jsonb));
end;
$$;

-- A member's own corrections and what became of them (PH-02 test 3).
create function public.my_corrections()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('correctionId', c.id, 'field', c.field, 'proposedValue', c.proposed_value,
           'state', c.state, 'sentAt', c.created_at, 'decidedAt', c.decided_at,
           'applied', c.applied_change_id is not null,
           'target', app.social_target(c.venue_id, c.food_item_id, 'none', '{}', false, true)) order by c.created_at desc), '[]'::jsonb)
    from public.corrections c where c.reporter_id = auth.uid() and auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- 7. Who may call what
-- ---------------------------------------------------------------------------
do $$
declare
  f regprocedure;
  v_member text[] := array[
    'set_member_suspension', 'member_history', 'editor_start_change', 'editor_new_food', 'editor_start_venue_change',
    'editor_save_change', 'editor_submit_change', 'editor_withdraw_change', 'editor_review_change',
    'editor_flag_needs_review', 'editor_change', 'editor_desk', 'editor_items', 'staff_alerts', 'corrections_queue',
    'my_corrections', 'publish_food_revision'];
begin
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (v_member) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  execute 'revoke execute on function public.freshness_marks(uuid[], uuid[], boolean) from public';
  execute 'grant execute on function public.freshness_marks(uuid[], uuid[], boolean) to anon, authenticated';
  -- Helpers in the app schema are for these functions only.
  for f in select p.oid::regprocedure from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = any (array['entry_is_demo', 'staff_label', 'report_owner', 'freshness_json', 'publish_gate',
              'require_editor', 'copy_revision_children', 'editor_evidence', 'evidence_core', 'change_json', 'discard_draft', 'is_suspended', 'is_staff']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Rollback (local): `pnpm exec supabase db reset` after reverting this file.
-- On a database that cannot be reset: drop the functions created here, restore
-- the earlier bodies of app.profile_ok, app.rating_summary, app.require_profile,
-- app.social_rate, app.eligibility, public.publish_food_revision and
-- public.corrections_queue from their earlier migrations, drop
-- public.review_flags, public.catalog_changes, app.freshness_rules and the
-- added columns (corrections.applied_change_id, member_standing.suspended_*).
