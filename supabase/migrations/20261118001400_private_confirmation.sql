-- Private confirmation of Tier B facts (owner approval 18 Nov 2026 19:19 UTC, "APPROVAL 1").
--
--   * A new registry status, 'private_pilot' (kind 'owner_decision'), marks a site whose terms are
--     absent or silent and which the owner let us read for facts only, privately. It is never
--     'cleared': nothing from it can be verified for publication, prepared for publication or shown.
--   * The founder may confirm that a fact from such a site matches its source ("transcription
--     confirmed"). That is a separate record; the fact itself stays 'submitted', so every existing
--     publication guard keeps refusing it.
--   * Every fact now reports six separate statuses: extracted, transcription confirmed, dietary
--     verified, nutrition verified, reuse eligible (source cleared) and publication approved.
--     Confirming a transcription never sets any of the last four.

-- 1. The registry status, in both registries.
alter table staging.source_access drop constraint source_access_kind_check;
alter table staging.source_access drop constraint source_access_status_check;
alter table staging.source_access add constraint source_access_kind_check
  check (kind in ('terms_review', 'written_permission', 'licence', 'api_terms', 'owner_decision'));
alter table staging.source_access add constraint source_access_status_check
  check (status in ('permits', 'prohibits', 'unclear', 'unreadable', 'private_pilot'));
alter table staging.source_access add constraint source_access_owner_decision_check
  check ((kind = 'owner_decision') = (status = 'private_pilot'));

alter table menu_ingest.access_permissions drop constraint access_permissions_kind_check;
alter table menu_ingest.access_permissions drop constraint access_permissions_status_check;
alter table menu_ingest.access_permissions add constraint access_permissions_kind_check
  check (kind in ('terms_review', 'written_permission', 'licence', 'api_terms', 'owner_decision'));
alter table menu_ingest.access_permissions add constraint access_permissions_status_check
  check (status in ('permits', 'prohibits', 'unclear', 'unreadable', 'private_pilot'));
alter table menu_ingest.access_permissions add constraint access_permissions_owner_decision_check
  check ((kind = 'owner_decision') = (status = 'private_pilot'));

-- The latest entry still wins, so a later reading that finds a prohibition makes the site prohibited.
create or replace function staging.source_access_state(p_url text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when x.status is null then 'pending'
              when x.status = 'prohibits' then 'prohibited'
              when x.status = 'private_pilot' then 'private_pilot'
              when x.status = 'permits' and (x.expires_at is null or x.expires_at > now())
                   and not (x.kind = 'terms_review' and x.reviewed_at < now() - interval '180 days') then 'cleared'
              else 'pending' end
    from (select 1) one
    left join lateral (select a.* from staging.source_access a where a.host = staging.url_host(p_url)
                        order by a.reviewed_at desc, a.id desc limit 1) x on true;
$$;

-- The pipeline view names the new status; it is not 'may_fetch', so the pipeline does not fetch it.
create or replace view menu_ingest.source_status with (security_invoker = true) as
  select s.id, s.host, s.start_url, s.scope, s.excluded_by,
         (select count(*) from menu_ingest.source_places p where p.source_id = s.id)::int as places,
         c.decision, c.checked_at, c.rule, c.note,
         p.kind as permission_kind, p.status as permission_status, p.reviewed_at as permission_reviewed_at,
         p.permitted_uses, p.evidence as permission_evidence,
         case when s.excluded_by is not null then 'excluded'
              when p.status = 'prohibits' then 'terms_block'
              when p.status = 'permits' and (p.expires_at is null or p.expires_at > now())
                   and p.kind in ('written_permission', 'licence') and coalesce(c.decision, '') <> 'allowed' then 'may_import'
              when c.decision is null then 'not_checked'
              when c.decision <> 'allowed' then 'blocked'
              when p.status is null then 'terms_needed'
              when p.status = 'private_pilot' then 'private_pilot'
              when p.status in ('unclear', 'unreadable') then 'terms_unclear'
              when p.expires_at is not null and p.expires_at <= now() then 'terms_needed'
              when p.kind = 'terms_review' and p.reviewed_at < now() - interval '180 days' then 'terms_needed'
              else 'may_fetch' end as state
    from menu_ingest.sources s
    left join lateral (select * from menu_ingest.access_checks a where a.source_id = s.id
                        order by a.checked_at desc, a.id desc limit 1) c on true
    left join lateral (select * from menu_ingest.access_permissions x where x.source_id = s.id
                        order by x.reviewed_at desc, x.id desc limit 1) p on true;
revoke all on menu_ingest.source_status from public, anon, authenticated;

-- 2. Transcription confirmations: append-only, one per fact, never by the person who entered it.
create table staging.fact_confirmations (
  id            bigint generated always as identity primary key,
  fact_id       uuid not null references staging.facts (id),
  level         text not null check (level in ('transcription')),
  confirmed_by  uuid not null,
  confirmed_at  timestamptz not null default now(),
  note          text check (length(note) <= 500),
  unique (fact_id, level)
);
alter table staging.fact_confirmations enable row level security;
alter table staging.fact_confirmations force row level security;
revoke all on staging.fact_confirmations from public, anon, authenticated;

create function staging.guard_confirmations_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'STAGING_HISTORY_IS_APPEND_ONLY' using errcode = 'PT409';
end;
$$;
create trigger fact_confirmations_append_only before update or delete on staging.fact_confirmations
  for each row execute function staging.guard_confirmations_append_only();
revoke all on function staging.guard_confirmations_append_only() from public, anon, authenticated;

alter table staging.events drop constraint events_action_check;
alter table staging.events add constraint events_action_check
  check (action in ('add_place', 'add_dish', 'add_source_page', 'submit_fact', 'verify_fact', 'reject_fact', 'replace_fact',
                    'set_place_status', 'prepare_publication', 'link_catalog', 'unlink_catalog', 'request_correction',
                    'confirm_transcription'));

create function staging.confirm_transcription(p_actor uuid, p_fact uuid, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v staging.facts;
  v_url text;
begin
  perform staging.require_role(p_actor, 'publisher');
  select * into v from staging.facts where id = p_fact for update;
  if v.id is null then raise exception 'STAGING_NOT_FOUND' using errcode = 'PT404'; end if;
  if v.entered_by = p_actor then raise exception 'STAGING_SAME_PERSON' using errcode = 'PT403'; end if;
  if v.status <> 'submitted' or exists (select 1 from staging.fact_confirmations c where c.fact_id = p_fact) then
    raise exception 'STAGING_ALREADY_REVIEWED' using errcode = 'PT409';
  end if;
  select url into v_url from staging.source_pages where id = v.source_page_id;
  -- Only a private-pilot source: a cleared source is verified the usual way; anything else is held.
  if staging.source_access_state(v_url) <> 'private_pilot' then
    raise exception 'STAGING_NOT_PRIVATE_PILOT' using errcode = 'PT422';
  end if;
  insert into staging.fact_confirmations (fact_id, level, confirmed_by, note) values (p_fact, 'transcription', p_actor, p_note);
  insert into staging.events (actor_id, action, place_id, fact_id, detail)
    values (p_actor, 'confirm_transcription', v.place_id, p_fact, jsonb_build_object('note', p_note));
  return 'transcription_confirmed';
end;
$$;
revoke all on function staging.confirm_transcription(uuid, uuid, text) from public, anon, authenticated;

-- 3. The founder's screens report the six statuses and offer the right kind of confirmation.
create or replace function public.menu_review_fact_json(f staging.facts, p_me uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select staging.source_access_state((select p.url from staging.source_pages p where p.id = f.source_page_id)) as access,
           exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id and c.level = 'transcription') as transcribed
  )
  select jsonb_build_object(
    'factId', f.id, 'kind', f.kind, 'subject', f.subject, 'value', f.value, 'unknown', f.is_unknown,
    'unknownReason', f.unknown_reason, 'status', f.status, 'confidence', f.confidence,
    'sourceId', f.source_page_id, 'checkedOn', f.checked_on, 'access', s.access,
    -- What "Everything matches the source" does for this fact: verify (cleared source), confirm the
    -- transcription only (private pilot), or nothing.
    'confirmAs', case when f.status <> 'submitted' or f.entered_by = p_me then null
                      when s.access = 'cleared' then 'verify'
                      when s.access = 'private_pilot' and not s.transcribed then 'transcription' end,
    'canConfirm', f.status = 'submitted' and f.entered_by <> p_me
                  and (s.access = 'cleared' or (s.access = 'private_pilot' and not s.transcribed)),
    'canReject', f.status = 'submitted' and f.entered_by <> p_me,
    'statuses', jsonb_build_object(
      'extracted', true,
      'transcriptionConfirmed', s.transcribed or f.status = 'verified',
      'dietaryVerified', f.status = 'verified' and f.kind in ('dietary_status', 'allergen_statement'),
      'nutritionVerified', f.status = 'verified' and f.kind in ('published_nutrition', 'serving_size'),
      'reuseEligible', s.access = 'cleared',
      'publicationApproved', exists (select 1 from staging.publication_changes pc join public.catalog_changes cc on cc.id = pc.change_id
                                      where f.id = any (pc.fact_ids) and cc.state = 'published')))
  from s;
$$;
revoke all on function public.menu_review_fact_json(staging.facts, uuid) from public, anon, authenticated;

create or replace function public.menu_review_places()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_founder();
  return coalesce((
    select jsonb_agg(x order by (x ->> 'ready')::int desc, x ->> 'label')
      from (
        select jsonb_build_object(
                 'placeId', p.id, 'label', p.label, 'area', p.area, 'city', p.city,
                 'dishes', (select count(*) from staging.dishes d where d.place_id = p.id),
                 'ready', count(f.id) filter (where f.status = 'submitted' and f.entered_by <> auth.uid()
                            and (staging.source_access_state(s.url) = 'cleared'
                                 or (staging.source_access_state(s.url) = 'private_pilot' and c.id is null))),
                 'held', count(f.id) filter (where f.status = 'submitted' and staging.source_access_state(s.url) not in ('cleared', 'private_pilot')),
                 'transcribed', count(f.id) filter (where f.status = 'submitted' and c.id is not null),
                 'privatePilot', bool_or(staging.source_access_state(s.url) = 'private_pilot'),
                 'confirmed', count(f.id) filter (where f.status = 'verified'),
                 'rejected', count(f.id) filter (where f.status = 'rejected')) x
          from staging.places p
          left join staging.facts f on f.place_id = p.id
          left join staging.source_pages s on s.id = f.source_page_id
          left join staging.fact_confirmations c on c.fact_id = f.id and c.level = 'transcription'
         group by p.id) q), '[]'::jsonb);
end;
$$;

-- Decisions now include "confirm_transcription". All or nothing, as before.
create or replace function public.menu_review_decide(p_decisions jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := auth.uid();
  x jsonb;
  v_verified int := 0;
  v_rejected int := 0;
  v_transcribed int := 0;
begin
  perform app.require_founder();
  if p_decisions is null or jsonb_typeof(p_decisions) is distinct from 'array' then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  if jsonb_array_length(p_decisions) not between 1 and 300 then
    raise exception 'INVALID_BODY' using errcode = 'PT422';
  end if;
  for x in select * from jsonb_array_elements(p_decisions) loop
    if jsonb_typeof(x) <> 'object' or coalesce(x ->> 'decision', '') not in ('verify', 'reject', 'confirm_transcription')
       or x ->> 'factId' is null or length(coalesce(x ->> 'note', '')) > 500 then
      raise exception 'INVALID_BODY' using errcode = 'PT422';
    end if;
    if x ->> 'decision' = 'confirm_transcription' then
      perform staging.confirm_transcription(v_me, (x ->> 'factId')::uuid, nullif(trim(x ->> 'note'), ''));
      v_transcribed := v_transcribed + 1;
    else
      perform staging.review_fact(v_me, (x ->> 'factId')::uuid, x ->> 'decision', nullif(trim(x ->> 'note'), ''));
      if x ->> 'decision' = 'verify' then v_verified := v_verified + 1; else v_rejected := v_rejected + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('verified', v_verified, 'rejected', v_rejected, 'transcribed', v_transcribed);
exception
  when invalid_text_representation then raise exception 'INVALID_BODY' using errcode = 'PT422';
end;
$$;

-- Rollback: drop staging.confirm_transcription, the fact_confirmations table and its trigger function;
-- re-run menu_review_fact_json, menu_review_places and menu_review_decide from 20261118001200 (and the
-- decide fix in that file); restore source_access_state from 20261117001200 and the source_status view
-- from 20261117001100; restore both registries' kind/status constraints and events_action_check, after
-- deleting any 'owner_decision' rows. Nothing else changes.
