-- Sample-reviewed batches of real places (owner 17 Nov 03:17 UTC: "I also approve Option B:
-- sample-reviewed batch publication as our intended approach, using the stricter statistical
-- acceptance rule proposed in PR #42. This is approval to implement and test the batch-review
-- mechanism, not approval to publish any real restaurant or activate the real-data switch.").
-- Design: docs/34, docs/35.
--
--   * A batch is a frozen list of preview places plus the representative sample drawn from it. The
--     local `catalog-preview.mjs batch` step writes it; nothing in the public schema reads
--     catalog_import.
--   * The sample's result is computed here from the founder's own identity decisions, never typed in.
--   * Gate 1: the founder approves a batch, only if its sample passes the stricter rule. The approval
--     is permanent history (append-only); it changes no place's identity status and publishes nothing.
--   * Gate 2: the separate `real_place_listings` switch, which no app account can turn on.
--   * A place may be public only when gate 2 is on AND (its identity is founder-verified OR its batch
--     has a current gate-1 approval and the founder has not rejected it or asked for more evidence).
--     This is checked when a listing is made public and again on every read.

create table public.publication_batches (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique check (name ~ '^[a-z0-9-]{3,60}$'),
  sample_seed   text not null check (length(sample_seed) between 1 and 100),
  fingerprint   text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  place_count   integer not null check (place_count > 0),
  frozen_at     timestamptz not null default now()
);
alter table public.publication_batches enable row level security;
revoke all on public.publication_batches from public, anon, authenticated;

create table public.publication_batch_places (
  batch_id      uuid not null references public.publication_batches (id),
  candidate_id  uuid not null,
  in_sample     boolean not null default false,
  primary key (batch_id, candidate_id)
);
create index publication_batch_places_candidate on public.publication_batch_places (candidate_id);
alter table public.publication_batch_places enable row level security;
revoke all on public.publication_batch_places from public, anon, authenticated;

-- A batch's membership is fixed once written; only a place can be added to the sample (an extension).
create function app.guard_batch_place()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Batch membership is permanent' using errcode = 'PT403'; end if;
  if tg_op = 'UPDATE' and ((new.batch_id, new.candidate_id) is distinct from (old.batch_id, old.candidate_id) or (old.in_sample and not new.in_sample)) then
    raise exception 'Batch membership is permanent' using errcode = 'PT403';
  end if;
  if exists (select 1 from public.batch_approvals a where a.batch_id = new.batch_id) then
    raise exception 'A batch with an approval decision cannot change its places or its sample' using errcode = 'PT403';
  end if;
  return new;
end $$;
revoke all on function app.guard_batch_place() from public, anon, authenticated;

create table public.batch_approvals (
  id            bigint generated always as identity primary key,
  batch_id      uuid not null references public.publication_batches (id),
  decision      text not null check (decision in ('approve', 'withdraw')),
  sample_size   integer not null,
  checked       integer not null,
  problems      integer not null,
  upper_bound   numeric(6, 4) not null,
  rule          text not null,
  note          text check (length(note) <= 1000),
  decided_by    uuid not null references auth.users (id),
  decided_at    timestamptz not null default now()
);
create index batch_approvals_batch on public.batch_approvals (batch_id, decided_at desc, id desc);
alter table public.batch_approvals enable row level security;
revoke all on public.batch_approvals from public, anon, authenticated;

create trigger publication_batch_places_guard before insert or update or delete on public.publication_batch_places
  for each row execute function app.guard_batch_place();

create function app.guard_batch_approval()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Batch decisions are permanent' using errcode = 'PT403'; end if;
  if not exists (select 1 from public.role_assignments r where r.user_id = new.decided_by and r.role = 'publisher') then
    raise exception 'Only the founder (publisher role) approves a batch' using errcode = 'PT403';
  end if;
  return new;
end $$;
revoke all on function app.guard_batch_approval() from public, anon, authenticated;
create trigger batch_approvals_guard before insert or update or delete on public.batch_approvals
  for each row execute function app.guard_batch_approval();

create function app.guard_batch()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (new.name, new.sample_seed, new.fingerprint, new.place_count, new.frozen_at) is distinct from (old.name, old.sample_seed, old.fingerprint, old.place_count, old.frozen_at) then
    raise exception 'A batch is frozen' using errcode = 'PT403';
  end if;
  return new;
end $$;
revoke all on function app.guard_batch() from public, anon, authenticated;
create trigger publication_batches_guard before update or delete on public.publication_batches
  for each row execute function app.guard_batch();

alter table public.place_listings add column publication_batch uuid references public.publication_batches (id);

-- One-sided 95% upper confidence bound on the true problem rate, given k problems in n checked
-- places (exact Clopper-Pearson, by bisection on the binomial distribution).
create function app.binomial_upper_95(k integer, n integer)
returns numeric language plpgsql immutable set search_path = '' as $$
declare lo double precision := 0; hi double precision := 1; p double precision; term double precision; cdf double precision;
begin
  if n is null or n <= 0 then return 1; end if;
  if k >= n then return 1; end if;
  for it in 1..60 loop
    p := (lo + hi) / 2;
    term := power(1 - p, n);
    cdf := term;
    for i in 0..k - 1 loop
      term := term * (n - i) / (i + 1) * p / (1 - p);
      cdf := cdf + term;
    end loop;
    if cdf > 0.05 then lo := p; else hi := p; end if;
  end loop;
  return round(lo::numeric, 4);
end $$;
revoke all on function app.binomial_upper_95(integer, integer) from public, anon, authenticated;

-- The approved acceptance rule (docs/34 §3): every sampled place checked, and
-- 0 problems in at least 61, or at most 2 problems in at least 120.
create function app.sample_passes(k integer, n integer, checked integer)
returns boolean language sql immutable set search_path = '' as $$
  select checked = n and n > 0 and ((n >= 61 and k = 0) or (n >= 120 and k <= 2));
$$;
revoke all on function app.sample_passes(integer, integer, integer) from public, anon, authenticated;

-- A batch's sample result, computed only from the founder's latest decision on each sampled place.
-- A problem is a "reject" or "needs more evidence" decision.
create function app.batch_status(p_batch uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.publication_batches; v_n integer; v_checked integer; v_k integer; v_appr public.batch_approvals; v_bound numeric;
begin
  select * into b from public.publication_batches where id = p_batch;
  if not found then return null; end if;
  select count(*), count(d.decision), count(*) filter (where d.decision in ('reject', 'needs_more_evidence'))
    into v_n, v_checked, v_k
    from public.publication_batch_places bp
    left join lateral (select r.decision from public.identity_reviews r where r.candidate_id = bp.candidate_id order by r.decided_at desc, r.id desc limit 1) d on true
   where bp.batch_id = p_batch and bp.in_sample;
  select * into v_appr from public.batch_approvals a where a.batch_id = p_batch order by a.decided_at desc, a.id desc limit 1;
  v_bound := app.binomial_upper_95(v_k, v_checked);
  return jsonb_build_object(
    'id', b.id, 'name', b.name, 'sampleSeed', b.sample_seed, 'places', b.place_count, 'frozenAt', b.frozen_at,
    'sampleSize', v_n, 'checked', v_checked, 'problems', v_k,
    'upperBound', v_bound,
    'passes', app.sample_passes(v_k, v_n, v_checked),
    'rule', 'All sampled places checked, and 0 problems in at least 61, or at most 2 problems in at least 120.',
    'approved', coalesce(v_appr.decision = 'approve' and v_appr.decided_at > now() - interval '90 days', false),
    'approvalExpired', coalesce(v_appr.decision = 'approve' and v_appr.decided_at <= now() - interval '90 days', false),
    'excluded', (select count(*) from public.publication_batch_places bp
                   where bp.batch_id = p_batch
                     and (select r.decision from public.identity_reviews r where r.candidate_id = bp.candidate_id order by r.decided_at desc, r.id desc limit 1) in ('reject', 'needs_more_evidence'))
  );
end $$;
revoke all on function app.batch_status(uuid) from public, anon, authenticated;

-- May this listing be shown to everyone? Re-checked on every public read, so withdrawing a batch
-- approval, rejecting a place or turning the switch off hides it at once.
create function app.listing_may_be_public(p_candidate uuid, p_identity text, p_batch uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_latest text;
begin
  if not coalesce((select w.enabled from app.platform_switches w where w.name = 'real_place_listings'), false) then return false; end if;
  v_latest := (select r.decision from public.identity_reviews r where r.candidate_id = p_candidate order by r.decided_at desc, r.id desc limit 1);
  if v_latest in ('reject', 'needs_more_evidence') then return false; end if;
  if p_identity = 'verified' then return true; end if;
  if p_batch is null or not exists (select 1 from public.publication_batch_places bp where bp.batch_id = p_batch and bp.candidate_id = p_candidate) then return false; end if;
  return coalesce((select a.decision = 'approve' and a.decided_at > now() - interval '90 days'
                     from public.batch_approvals a where a.batch_id = p_batch order by a.decided_at desc, a.id desc limit 1), false);
end $$;
revoke all on function app.listing_may_be_public(uuid, text, uuid) from public, anon, authenticated;

-- The listing guard now accepts a place from a currently approved batch as well as a founder-verified one.
create or replace function app.guard_place_listing()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.visibility = 'public' and (tg_op = 'INSERT' or old.visibility <> 'public') then
    if not coalesce((select w.enabled from app.platform_switches w where w.name = 'real_place_listings'), false) then
      raise exception 'Real place listings are locked' using errcode = 'PT403';
    end if;
    if not app.listing_may_be_public(new.candidate_id, new.identity_status, new.publication_batch) then
      raise exception 'Only a founder-verified place or a place in a currently approved batch can be made public' using errcode = 'PT403';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- The place directory re-checks, on every read, that a public listing may still be public.
create or replace function public.place_directory(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_market text := coalesce(p->>'market', 'boston');
  v_preview boolean := coalesce((p->>'preview')::boolean, false) and (app.has_role('publisher') or app.has_role('admin'));
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_area text := nullif(btrim(coalesce(p->>'area', '')), '');
  v_lat double precision := (p->>'lat')::double precision;
  v_lon double precision := (p->>'lon')::double precision;
  v_limit integer := coalesce((p->>'limit')::integer, 24);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 or length(coalesce(v_area, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > 50 then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  if (v_lat is null) <> (v_lon is null) then raise exception 'INVALID_POINT' using errcode = 'PT422'; end if;

  with seen as (
    select l.* from public.place_listings l
     where l.market_slug = v_market
       and ((l.visibility = 'public' and app.listing_may_be_public(l.candidate_id, l.identity_status, l.publication_batch)) or (v_preview and l.visibility = 'preview'))
  ), hit as (
    select s.*,
           case when v_lat is not null then 2 * 6371000 * asin(sqrt(power(sin(radians(s.lat - v_lat) / 2), 2)
             + cos(radians(v_lat)) * cos(radians(s.lat)) * power(sin(radians(s.lon - v_lon) / 2), 2))) end as distance_m
      from seen s
     where (v_q is null or s.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%' or s.street ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
       and (v_area is null or s.area = v_area)
  ), ordered as (
    select h.*, row_number() over (order by h.distance_m asc nulls last, h.name, h.id) as rn from hit h
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'slug', o.slug, 'name', o.name, 'street', o.street, 'locality', o.locality, 'postcode', o.postcode,
        'area', o.area, 'category', o.category, 'lat', round(o.lat::numeric, 5), 'lon', round(o.lon::numeric, 5),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'identityStatus', o.identity_status, 'menuStatus', o.menu_status, 'visibility', o.visibility,
        'sources', (select coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'attribution', s->>'attribution')), '[]'::jsonb) from jsonb_array_elements(o.sources) s)
      ) order by o.rn) from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (select count(*) from hit),
    'nextOffset', case when (select count(*) from hit) > v_offset + v_limit then v_offset + v_limit end,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('area', a.area, 'count', a.n) order by a.n desc, a.area)
                         from (select s.area, count(*) n from seen s where s.area is not null group by s.area) a), '[]'::jsonb),
    'preview', v_preview
  ) into v_result;
  return v_result;
end;
$$;

-- The founder's batch overview: every batch with its sample result and approval history.
create function public.batch_review_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return jsonb_build_object(
    'switchOn', coalesce((select w.enabled from app.platform_switches w where w.name = 'real_place_listings'), false),
    'batches', coalesce((select jsonb_agg(app.batch_status(b.id) || jsonb_build_object(
        'history', coalesce((select jsonb_agg(jsonb_build_object('decision', a.decision, 'sampleSize', a.sample_size, 'checked', a.checked, 'problems', a.problems,
                       'upperBound', a.upper_bound, 'note', a.note, 'by', app.staff_label(a.decided_by), 'at', a.decided_at) order by a.decided_at desc, a.id desc)
                     from public.batch_approvals a where a.batch_id = b.id), '[]'::jsonb)) order by b.frozen_at desc)
      from public.publication_batches b), '[]'::jsonb));
end $$;

-- Gate 1: one founder decision about one batch. "approve" needs a passing sample and the founder's
-- acknowledgement that it publishes nothing by itself. Never changes a place's identity status.
create function public.record_batch_approval(p_batch uuid, p_decision text, p_acknowledged boolean default false, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s jsonb; v_id bigint;
begin
  perform app.require_founder();
  if p_decision not in ('approve', 'withdraw') then raise exception 'INVALID_DECISION' using errcode = 'PT422'; end if;
  if length(coalesce(p_note, '')) > 1000 then raise exception 'NOTE_TOO_LONG' using errcode = 'PT422'; end if;
  s := app.batch_status(p_batch);
  if s is null then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if p_decision = 'approve' then
    if not (s->>'passes')::boolean then raise exception 'SAMPLE_NOT_PASSED' using errcode = 'PT409'; end if;
    if not coalesce(p_acknowledged, false) then raise exception 'ACKNOWLEDGEMENT_REQUIRED' using errcode = 'PT422'; end if;
    if (s->>'approved')::boolean then raise exception 'ALREADY_APPROVED' using errcode = 'PT409'; end if;
  elsif not (s->>'approved')::boolean then
    raise exception 'NOT_APPROVED' using errcode = 'PT409';
  end if;
  insert into public.batch_approvals (batch_id, decision, sample_size, checked, problems, upper_bound, rule, note, decided_by)
  values (p_batch, p_decision, (s->>'sampleSize')::integer, (s->>'checked')::integer, (s->>'problems')::integer, (s->>'upperBound')::numeric,
          s->>'rule', nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'decision', p_decision);
end $$;

revoke all on function public.batch_review_summary(), public.record_batch_approval(uuid, text, boolean, text) from public, anon;
grant execute on function public.batch_review_summary(), public.record_batch_approval(uuid, text, boolean, text) to authenticated;
