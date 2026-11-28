-- Founder identity review in the website (owner 17 Nov 02:17 UTC: "Build /places/review so I can
-- inspect restaurant identities, map locations, original source evidence and exceptions directly
-- through the website. Support individual Verify, Reject and Needs More Evidence decisions, review
-- notes, progress tracking and immutable decision history." … "no automatic verification on my
-- behalf"). Plan: docs/32 section 8, docs/33.
--
-- The private import schema stays closed: the local build copies each queued place's evidence into
-- identity_review_items, and the local assess step reads the founder's decisions back. No public
-- function reads catalog_import.
--
--   * Only a person with the publisher role can open the queue or record a decision; one place per
--     decision, no bulk action exists.
--   * Decisions are append-only. The latest decision for a place counts; earlier ones stay as history.
--   * "Verify" marks that one listing's identity verified. It never publishes it and never touches
--     menu, dietary or nutrition status. "Reject" and "Needs more evidence" withdraw it from the
--     preview (kept, never deleted).
--   * A representative sample is reviewed through the same decisions; passing a sample changes no
--     other place.

create table public.identity_review_items (
  candidate_id  uuid primary key, -- catalog_import.place_candidates.id
  name          text not null check (length(name) between 1 and 300),
  street        text,
  postcode      text,
  area          text,
  lat           double precision not null,
  lon           double precision not null,
  queues        text[] not null check (cardinality(queues) >= 1),
  sample_seed   text,
  evidence      jsonb not null check (jsonb_typeof(evidence) = 'object'),
  active        boolean not null default true,
  sort_key      text not null,
  built_at      timestamptz not null default now()
);
create index identity_review_items_queues on public.identity_review_items using gin (queues);
alter table public.identity_review_items enable row level security;
revoke all on public.identity_review_items from public, anon, authenticated;

create table public.identity_reviews (
  id             bigint generated always as identity primary key,
  candidate_id   uuid not null references public.identity_review_items (candidate_id),
  decision       text not null check (decision in ('verify_identity', 'reject', 'needs_more_evidence')),
  reason         text check (reason in ('not_public', 'closed', 'duplicate', 'wrong_place', 'not_restaurant', 'other')),
  note           text check (length(note) <= 1000),
  queue          text not null check (length(queue) between 1 and 60),
  sample_seed    text,
  decided_by     uuid not null references auth.users (id),
  decided_at     timestamptz not null default now(),
  check ((decision = 'reject') = (reason is not null))
);
create index identity_reviews_candidate on public.identity_reviews (candidate_id, decided_at desc, id desc);
alter table public.identity_reviews enable row level security;
revoke all on public.identity_reviews from public, anon, authenticated;

create function app.guard_identity_review()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Identity decisions are permanent' using errcode = 'PT403'; end if;
  if not exists (select 1 from public.role_assignments r where r.user_id = new.decided_by and r.role = 'publisher') then
    raise exception 'Only the founder (publisher role) decides identity' using errcode = 'PT403';
  end if;
  return new;
end $$;
revoke all on function app.guard_identity_review() from public, anon, authenticated;
create trigger identity_reviews_guard before insert or update or delete on public.identity_reviews
  for each row execute function app.guard_identity_review();

create function app.require_founder()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if not app.has_role('publisher') then raise exception 'FOUNDER_ONLY' using errcode = 'PT403'; end if;
end $$;
revoke all on function app.require_founder() from public, anon, authenticated;

-- Latest decision per place.
create function app.latest_identity_review(p_candidate uuid)
returns public.identity_reviews language sql stable security definer set search_path = '' as $$
  select r.* from public.identity_reviews r where r.candidate_id = p_candidate order by r.decided_at desc, r.id desc limit 1;
$$;
revoke all on function app.latest_identity_review(uuid) from public, anon, authenticated;

-- Queues, counts and progress.
create function public.identity_review_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_founder();
  with items as (
    select i.*, (app.latest_identity_review(i.candidate_id)).decision as decision
      from public.identity_review_items i where i.active
  ), q as (
    select unnest(i.queues) as queue, i.decision from items i
  ), seeds as (
    select i.sample_seed from items i where i.sample_seed is not null limit 1
  )
  select jsonb_build_object(
    'queues', coalesce((select jsonb_agg(jsonb_build_object('queue', x.queue, 'total', x.total, 'decided', x.decided) order by case when x.queue = 'sample' then 0 else 1 end, x.total desc, x.queue)
                          from (select queue, count(*) total, count(decision) decided from q group by queue) x), '[]'::jsonb),
    'sample', (select jsonb_build_object('seed', s.sample_seed,
                 'total', (select count(*) from items where 'sample' = any(queues)),
                 'checked', (select count(decision) from items where 'sample' = any(queues)),
                 'correct', (select count(*) from items where 'sample' = any(queues) and decision = 'verify_identity'),
                 'problems', (select count(*) from items where 'sample' = any(queues) and decision in ('reject', 'needs_more_evidence')))
               from seeds s),
    'decisions', jsonb_build_object(
      'verified', (select count(*) from items where decision = 'verify_identity'),
      'rejected', (select count(*) from items where decision = 'reject'),
      'needsMoreEvidence', (select count(*) from items where decision = 'needs_more_evidence'))
  ) into v;
  return v;
end $$;

-- One queue, 25 at a time, undecided first.
create function public.identity_review_list(p_queue text, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_founder();
  if p_queue is null or length(p_queue) > 60 then raise exception 'INVALID_QUEUE' using errcode = 'PT422'; end if;
  if p_offset < 0 or p_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  with items as (
    select i.*, d.decision, d.decided_at
      from public.identity_review_items i
      left join lateral (select r.decision, r.decided_at from public.identity_reviews r where r.candidate_id = i.candidate_id order by r.decided_at desc, r.id desc limit 1) d on true
     where i.active and p_queue = any(i.queues)
  ), ordered as (
    select it.*, row_number() over (order by (it.decision is not null), it.sort_key, it.candidate_id) rn from items it
  )
  select jsonb_build_object(
    'queue', p_queue,
    'total', (select count(*) from items),
    'decided', (select count(decision) from items),
    'items', coalesce((select jsonb_agg(jsonb_build_object('candidateId', o.candidate_id, 'name', o.name, 'street', o.street, 'postcode', o.postcode,
                 'area', o.area, 'queues', to_jsonb(o.queues), 'decision', o.decision) order by o.rn)
               from ordered o where o.rn > p_offset and o.rn <= p_offset + 25), '[]'::jsonb),
    'nextOffset', case when (select count(*) from items) > p_offset + 25 then p_offset + 25 end
  ) into v;
  return v;
end $$;

-- One place with its evidence, its full decision history and the next undecided place in the queue.
create function public.identity_review_item(p_candidate uuid, p_queue text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; i public.identity_review_items;
begin
  perform app.require_founder();
  select * into i from public.identity_review_items where candidate_id = p_candidate;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  select jsonb_build_object(
    'candidateId', i.candidate_id, 'name', i.name, 'street', i.street, 'postcode', i.postcode, 'area', i.area,
    'lat', round(i.lat::numeric, 6), 'lon', round(i.lon::numeric, 6), 'queues', to_jsonb(i.queues), 'active', i.active,
    'evidence', i.evidence,
    'history', coalesce((select jsonb_agg(jsonb_build_object('decision', r.decision, 'reason', r.reason, 'note', r.note, 'queue', r.queue,
                  'by', app.staff_label(r.decided_by), 'at', r.decided_at) order by r.decided_at desc, r.id desc)
                from public.identity_reviews r where r.candidate_id = i.candidate_id), '[]'::jsonb),
    'listing', (select jsonb_build_object('identityStatus', l.identity_status, 'menuStatus', l.menu_status, 'visibility', l.visibility)
                  from public.place_listings l where l.candidate_id = i.candidate_id),
    'next', (select n.candidate_id from public.identity_review_items n
              where n.active and n.candidate_id <> i.candidate_id and coalesce(p_queue, i.queues[1]) = any(n.queues)
                and not exists (select 1 from public.identity_reviews r where r.candidate_id = n.candidate_id)
              order by n.sort_key, n.candidate_id limit 1)
  ) into v;
  return v;
end $$;

-- One decision about one place, by the founder. Never publishes; never touches menu status.
create function public.record_identity_review(p_candidate uuid, p_decision text, p_reason text default null, p_note text default null, p_queue text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare i public.identity_review_items; v_id bigint; v_queue text;
begin
  perform app.require_founder();
  select * into i from public.identity_review_items where candidate_id = p_candidate and active;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_decision not in ('verify_identity', 'reject', 'needs_more_evidence') then raise exception 'INVALID_DECISION' using errcode = 'PT422'; end if;
  if (p_decision = 'reject') <> (p_reason is not null) then raise exception 'REASON_REQUIRED' using errcode = 'PT422'; end if;
  if length(coalesce(p_note, '')) > 1000 then raise exception 'NOTE_TOO_LONG' using errcode = 'PT422'; end if;
  v_queue := coalesce(nullif(p_queue, ''), i.queues[1]);
  if not (v_queue = any(i.queues)) then raise exception 'INVALID_QUEUE' using errcode = 'PT422'; end if;
  insert into public.identity_reviews (candidate_id, decision, reason, note, queue, sample_seed, decided_by)
  values (p_candidate, p_decision, p_reason, nullif(btrim(coalesce(p_note, '')), ''), v_queue,
          case when 'sample' = any(i.queues) then i.sample_seed end, auth.uid())
  returning id into v_id;
  -- Apply to the private preview listing, if there is one. Public listings are never touched here.
  if p_decision = 'verify_identity' then
    update public.place_listings set identity_status = 'verified', visibility = case when visibility = 'withdrawn' then 'preview' else visibility end
     where candidate_id = p_candidate and visibility <> 'public';
  else
    update public.place_listings set visibility = 'withdrawn' where candidate_id = p_candidate and visibility = 'preview';
  end if;
  return jsonb_build_object('id', v_id, 'decision', p_decision);
end $$;

revoke all on function public.identity_review_summary(), public.identity_review_list(text, integer), public.identity_review_item(uuid, text),
  public.record_identity_review(uuid, text, text, text, text) from public, anon;
grant execute on function public.identity_review_summary(), public.identity_review_list(text, integer), public.identity_review_item(uuid, text),
  public.record_identity_review(uuid, text, text, text, text) to authenticated;
