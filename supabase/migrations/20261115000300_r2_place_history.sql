-- R2 fix-up (owner instruction 2026-11-15 05:21 UTC, within approval A-R2).
--
-- 1. Places get an immutable before-and-after history. Every published change to a
--    place writes one row to public.venue_revisions holding the values before and
--    after (name, address, coordinates, kind, status, hours, note), the person who
--    entered it, the different person who checked it, a frozen copy of the source
--    evidence, and the time it was published. Nobody can change or delete a row,
--    not even the database owner; only removing the place itself takes its history
--    with it.
-- 2. Decided catalog changes are frozen the same way.
-- 3. Editors can no longer write catalog tables directly through the Data API.
--    Since R2 every catalog edit goes through the checked functions; the older
--    direct-write rules let one curator alone change a published place's hours,
--    a dish's place or price, a source's wording or rights status, a correction's
--    outcome, or someone else's submitted draft. They are removed.
-- 4. A place change starts from the current coordinates, hours and note, so the
--    editor sees the pin and hours that are published now.
-- 5. A place page shows only the latest checked value of each fact; older facts
--    stay stored as evidence.
--
-- Local, demo data only. No hosted database exists.

-- ---------------------------------------------------------------------------
-- 1. Place history
-- ---------------------------------------------------------------------------

-- What a place looks like now, in the shape stored in its history.
create function app.venue_snapshot(p_venue_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'name', v.name, 'neighborhood', v.neighborhood, 'street', v.street, 'locality', v.locality, 'region', v.region,
    'postalCode', v.postal_code, 'venueType', v.venue_type, 'status', v.status,
    'lat', case when v.location is not null then round(extensions.st_y(v.location::extensions.geometry)::numeric, 6) end,
    'lon', case when v.location is not null then round(extensions.st_x(v.location::extensions.geometry)::numeric, 6) end,
    'hours', (select f.typed_value ->> 'text' from public.venue_facts f where f.venue_id = v.id and f.field = 'hours' order by f.checked_at desc, f.id limit 1),
    'statusNote', (select f.typed_value ->> 'text' from public.venue_facts f where f.venue_id = v.id and f.field = 'status_note' order by f.checked_at desc, f.id limit 1),
    'reviewedAt', v.reviewed_at)
  from public.venues v where v.id = p_venue_id;
$$;

create table public.venue_revisions (
  id               uuid primary key default gen_random_uuid(),
  venue_id         uuid not null references public.venues (id) on delete cascade,
  revision_no      integer not null check (revision_no >= 1),
  change_id        uuid not null unique references public.catalog_changes (id) on delete cascade,
  before_values    jsonb,
  after_values     jsonb not null,
  source_record_id uuid not null references public.source_records (id),
  source_snapshot  jsonb not null,
  author_id        uuid references auth.users (id) on delete set null,
  reviewer_id      uuid references auth.users (id) on delete set null,
  submitted_at     timestamptz,
  published_at     timestamptz not null default now(),
  is_demo          boolean not null,
  unique (venue_id, revision_no),
  check (author_id is null or reviewer_id is null or author_id <> reviewer_id)
);
alter table public.venue_revisions enable row level security;
alter table public.venue_revisions force row level security;
revoke all on public.venue_revisions from public, anon, authenticated;

-- History is append-only. The only changes allowed are the ones the database makes
-- itself when an account is deleted (the person's id becomes empty, D-M5-DELETE),
-- and removal together with the place it describes.
create function app.guard_venue_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.venues v where v.id = old.venue_id)
       and exists (select 1 from public.catalog_changes c where c.id = old.change_id) then
      raise exception 'HISTORY_IS_PERMANENT' using errcode = 'PT403';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id or new.venue_id is distinct from old.venue_id or new.revision_no is distinct from old.revision_no
     or new.change_id is distinct from old.change_id or new.before_values is distinct from old.before_values
     or new.after_values is distinct from old.after_values or new.source_record_id is distinct from old.source_record_id
     or new.source_snapshot is distinct from old.source_snapshot or new.submitted_at is distinct from old.submitted_at
     or new.published_at is distinct from old.published_at or new.is_demo is distinct from old.is_demo
     or (new.author_id is distinct from old.author_id and new.author_id is not null)
     or (new.reviewer_id is distinct from old.reviewer_id and new.reviewer_id is not null) then
    raise exception 'HISTORY_IS_PERMANENT' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger venue_revisions_permanent before update or delete on public.venue_revisions
  for each row execute function app.guard_venue_revision();

-- ---------------------------------------------------------------------------
-- 2. A decided change is frozen
-- ---------------------------------------------------------------------------
-- Once a change is published, sent back or withdrawn, its record stays as it was.
-- Allowed afterwards: links that the database clears when the thing they point to
-- is removed (an account, an unpublished draft, a correction), and the one-time copy
-- of a discarded draft's contents. It can be deleted only when the record it is
-- about no longer exists.
create function app.guard_catalog_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.state in ('published', 'rejected', 'withdrawn')
       and (exists (select 1 from public.food_items fi where fi.id = old.food_item_id)
            or exists (select 1 from public.venues v where v.id = old.venue_id)) then
      raise exception 'HISTORY_IS_PERMANENT' using errcode = 'PT403';
    end if;
    return old;
  end if;
  if old.state not in ('published', 'rejected', 'withdrawn') then
    return new;
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind or new.is_new is distinct from old.is_new
     or new.state is distinct from old.state or new.summary is distinct from old.summary
     or new.source_record_id is distinct from old.source_record_id or new.payload is distinct from old.payload
     or new.touches_evidence is distinct from old.touches_evidence or new.created_at is distinct from old.created_at
     or new.submitted_at is distinct from old.submitted_at or new.reviewed_at is distinct from old.reviewed_at
     or new.review_note is distinct from old.review_note
     or (new.draft_snapshot is distinct from old.draft_snapshot and old.draft_snapshot is not null)
     or (new.food_item_id is distinct from old.food_item_id and new.food_item_id is not null)
     or (new.venue_id is distinct from old.venue_id and new.venue_id is not null)
     or (new.base_revision_id is distinct from old.base_revision_id and new.base_revision_id is not null)
     or (new.draft_revision_id is distinct from old.draft_revision_id and new.draft_revision_id is not null)
     or (new.correction_id is distinct from old.correction_id and new.correction_id is not null)
     or (new.author_id is distinct from old.author_id and new.author_id is not null)
     or (new.reviewer_id is distinct from old.reviewer_id and new.reviewer_id is not null) then
    raise exception 'HISTORY_IS_PERMANENT' using errcode = 'PT403';
  end if;
  return new;
end;
$$;
create trigger catalog_changes_frozen before update or delete on public.catalog_changes
  for each row execute function app.guard_catalog_change();

-- ---------------------------------------------------------------------------
-- 3. No direct catalog writes through the Data API
-- ---------------------------------------------------------------------------
drop policy venue_facts_editor_write on public.venue_facts;
drop policy dishes_editor_write on public.dishes;
drop policy dish_prices_editor_write on public.dish_prices;
drop policy sources_editor_write on public.sources;
drop policy source_records_editor_write on public.source_records;
drop policy corrections_editor_update on public.corrections;
drop policy venues_editor_insert on public.venues;
drop policy venues_editor_update on public.venues;
drop policy food_items_editor_insert on public.food_items;
drop policy food_items_editor_update on public.food_items;
drop policy food_revisions_editor_insert on public.food_revisions;
drop policy food_revisions_editor_update on public.food_revisions;
drop policy portions_editor_write on public.portions;
drop policy dietary_claims_editor_write on public.dietary_claims;
drop policy ingredient_family_statements_editor_write on public.ingredient_family_statements;
drop policy allergen_statements_editor_write on public.allergen_statements;
drop policy nutrient_values_editor_write on public.nutrient_values;
drop policy recipe_revisions_editor_write on public.recipe_revisions;
drop policy recipe_ingredients_editor_write on public.recipe_ingredients;
drop policy recipe_steps_editor_write on public.recipe_steps;
-- Privileges follow the rules (D-R1-PRIV): with no write rule left, no write privilege.
revoke insert, update, delete on public.venue_facts, public.dishes, public.dish_prices, public.sources, public.source_records,
  public.venues, public.food_items, public.food_revisions, public.portions, public.dietary_claims,
  public.ingredient_family_statements, public.allergen_statements, public.nutrient_values, public.recipe_revisions,
  public.recipe_ingredients, public.recipe_steps from authenticated;
revoke update on public.corrections from authenticated;

-- ---------------------------------------------------------------------------
-- 4. Start a place change from what is published now
-- ---------------------------------------------------------------------------
create or replace function public.editor_start_venue_change(p_venue_id uuid default null, p_correction_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.require_editor();
  v public.venues;
  v_id uuid;
  v_now jsonb;
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
  if p_venue_id is not null then
    v_now := app.venue_snapshot(p_venue_id) - 'reviewedAt';
  end if;
  insert into public.catalog_changes (kind, is_new, venue_id, correction_id, author_id, payload)
  values ('venue', p_venue_id is null, p_venue_id, p_correction_id, v_uid, coalesce(v_now, '{}'::jsonb))
  returning id into v_id;
  perform app.audit('catalog_change.started', 'catalog_change', v_id, case when p_venue_id is null then 'new place' end);
  return jsonb_build_object('changeId', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Second-person check: unchanged rules, now also writing the place history
-- ---------------------------------------------------------------------------
create or replace function public.editor_review_change(
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
  v_before jsonb;
  v_after jsonb;
  v_hours text;
  v_note_text text;
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
    perform app.discard_draft(ch);
    update public.catalog_changes set state = 'rejected', reviewer_id = v_uid, reviewed_at = now(), review_note = v_note where id = ch.id;
    perform app.audit('catalog_change.rejected', 'catalog_change', ch.id, v_note);
    return jsonb_build_object('changeId', ch.id, 'state', 'rejected');
  end if;

  if not coalesce(p_source_checked, false) or not coalesce(p_rights_ok, false) then
    raise exception 'CHECKS_REQUIRED' using errcode = 'PT422';
  end if;
  if ch.source_record_id is null then raise exception 'SOURCE_REQUIRED' using errcode = 'PT422'; end if;
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
    if app.clean_text(p ->> 'name', 200) is null then raise exception 'NAME_REQUIRED' using errcode = 'PT422'; end if;
    if ch.venue_id is null then
      select * into v_market from public.markets m where m.slug = 'boston';
      insert into public.venues (market_id, slug, name, neighborhood, street, locality, region, postal_code, location, timezone, venue_type, status, is_demo, reviewed_at)
      values (v_market.id,
              left(trim(both '-' from regexp_replace(lower(p ->> 'name'), '[^a-z0-9]+', '-', 'g')), 100) || '-' || left(ch.id::text, 8),
              p ->> 'name', p ->> 'neighborhood', p ->> 'street', p ->> 'locality', p ->> 'region', p ->> 'postalCode',
              case when (p ->> 'lat') is not null and (p ->> 'lon') is not null
                   then extensions.st_setsrid(extensions.st_makepoint((p ->> 'lon')::double precision, (p ->> 'lat')::double precision), 4326)::extensions.geography end,
              v_market.default_timezone, coalesce(p ->> 'venueType', 'restaurant'), coalesce(p ->> 'status', 'published'), app.entry_is_demo(), now())
      returning id into v_venue;
    else
      v_venue := ch.venue_id;
      -- The values published until now, kept before anything is changed.
      v_before := app.venue_snapshot(v_venue);
      update public.venues v
         set name = p ->> 'name', neighborhood = p ->> 'neighborhood', street = p ->> 'street', locality = p ->> 'locality',
             region = p ->> 'region', postal_code = p ->> 'postalCode', venue_type = coalesce(p ->> 'venueType', v.venue_type),
             status = coalesce(p ->> 'status', v.status),
             location = case when (p ->> 'lat') is not null and (p ->> 'lon') is not null
                   then extensions.st_setsrid(extensions.st_makepoint((p ->> 'lon')::double precision, (p ->> 'lat')::double precision), 4326)::extensions.geography
                   else v.location end,
             reviewed_at = now()
       where v.id = v_venue;
    end if;
    -- Hours and note: a new checked fact only when the value changed; otherwise the
    -- existing fact counts as re-checked through this change's history row.
    v_hours := app.clean_text(p ->> 'hours', 500);
    if v_hours is not null and v_hours is distinct from (v_before ->> 'hours') then
      insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at, expires_at)
      values (v_venue, 'hours', jsonb_build_object('text', v_hours), ch.source_record_id, clock_timestamp(), clock_timestamp() + interval '60 days');
    end if;
    v_note_text := app.clean_text(p ->> 'statusNote', 300);
    if v_note_text is not null and v_note_text is distinct from (v_before ->> 'statusNote') then
      insert into public.venue_facts (venue_id, field, typed_value, source_record_id, checked_at, expires_at)
      values (v_venue, 'status_note', jsonb_build_object('text', v_note_text), ch.source_record_id, clock_timestamp(), clock_timestamp() + interval '60 days');
    end if;
    update public.catalog_changes set venue_id = v_venue where id = ch.id;
    v_after := app.venue_snapshot(v_venue);
    insert into public.venue_revisions (venue_id, revision_no, change_id, before_values, after_values, source_record_id, source_snapshot,
                                        author_id, reviewer_id, submitted_at, published_at, is_demo)
    values (v_venue,
            coalesce((select max(r.revision_no) from public.venue_revisions r where r.venue_id = v_venue), 0) + 1,
            ch.id, v_before, v_after, ch.source_record_id,
            (select jsonb_build_object('publisher', s.publisher, 'sourceType', s.source_type, 'url', s.canonical_url,
                                       'observedAt', sr.observed_at, 'summary', sr.evidence_summary, 'rightsStatus', sr.rights_status)
               from public.source_records sr join public.sources s on s.id = sr.source_id where sr.id = ch.source_record_id),
            ch.author_id, v_uid, ch.submitted_at, now(),
            (select v.is_demo from public.venues v where v.id = v_venue));
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

-- Withdrawing: the draft is discarded before the change is closed, so the closed
-- record is never touched again.
create or replace function public.editor_withdraw_change(p_change_id uuid)
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
  perform app.discard_draft(ch);
  update public.catalog_changes set state = 'withdrawn' where id = ch.id;
  perform app.audit('catalog_change.withdrawn', 'catalog_change', ch.id, null);
  return jsonb_build_object('changeId', ch.id, 'state', 'withdrawn');
end;
$$;

-- The full history of a place, for editors: every published change with the values
-- before and after, who entered it, who checked it, the source as it was, and when.
create function public.venue_history(p_venue_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_editor();
  if not exists (select 1 from public.venues v where v.id = p_venue_id) then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404';
  end if;
  return jsonb_build_object(
    'current', app.venue_snapshot(p_venue_id),
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'revisionId', r.id, 'revisionNo', r.revision_no, 'changeId', r.change_id,
               'before', r.before_values, 'after', r.after_values, 'source', r.source_snapshot,
               'author', app.staff_label(r.author_id), 'reviewer', app.staff_label(r.reviewer_id),
               'submittedAt', r.submitted_at, 'publishedAt', r.published_at) order by r.revision_no desc)
        from public.venue_revisions r where r.venue_id = p_venue_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. A place page shows the latest checked value of each fact
-- ---------------------------------------------------------------------------
create or replace function public.venue_detail(p_venue_id uuid, p_include_demo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.venues;
begin
  select * into v from public.venues
   where id = p_venue_id and status in ('published', 'temporarily_closed', 'closed') and (p_include_demo or not is_demo);
  if not found then raise exception 'VENUE_NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object(
    'id', v.id, 'slug', v.slug, 'name', v.name, 'neighborhood', v.neighborhood, 'street', v.street, 'locality', v.locality,
    'region', v.region, 'postalCode', v.postal_code, 'venueType', v.venue_type, 'status', v.status, 'isDemo', v.is_demo,
    'cuisines', to_jsonb(v.cuisines), 'priceBand', v.price_band, 'reviewedAt', v.reviewed_at,
    -- Coordinates are public venue facts, used only to build an external directions link (R-D05).
    'lat', case when v.location is not null then extensions.st_y(v.location::extensions.geometry) end,
    'lon', case when v.location is not null then extensions.st_x(v.location::extensions.geometry) end,
    'market', (select m.slug from public.markets m where m.id = v.market_id),
    'facts', coalesce((select jsonb_agg(jsonb_build_object('field', f.field, 'value', f.typed_value, 'checkedAt', f.checked_at,
                    'expired', (f.expires_at is not null and f.expires_at <= now()), 'source', app.source_summary(f.source_record_id)) order by f.field)
                 from (select distinct on (x.field) x.* from public.venue_facts x where x.venue_id = v.id order by x.field, x.checked_at desc, x.id) f), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Who may call what
-- ---------------------------------------------------------------------------
revoke execute on function public.venue_history(uuid) from public, anon;
grant execute on function public.venue_history(uuid) to authenticated;
revoke execute on function app.venue_snapshot(uuid) from public, anon, authenticated;
revoke execute on function app.guard_venue_revision() from public, anon, authenticated;
revoke execute on function app.guard_catalog_change() from public, anon, authenticated;

-- Rollback (local): `pnpm exec supabase db reset` after removing this file.
-- On a database that cannot be reset: drop public.venue_history, the two triggers and
-- their functions, app.venue_snapshot and public.venue_revisions; restore
-- editor_start_venue_change, editor_review_change, editor_withdraw_change and
-- venue_detail from their earlier migrations; recreate the dropped editor write
-- policies and privileges from 20261113000400_rls.sql if they are wanted back.
