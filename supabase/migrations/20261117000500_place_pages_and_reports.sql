-- Real place pages, a private Map/List view of real places, and "Report a problem" (owner 17 Nov
-- 03:17 UTC, priorities 2-4). Design: docs/36. Identity only: nothing here can describe a menu, a
-- diet or a nutrient, and nothing here makes a place public.
--
--   * place_directory gains a map mode (up to 500 pins, minimal fields), a map rectangle, a radius
--     around a point (sent in a request body, rounded, never stored), and per-listing labels:
--     identity basis (founder-verified / sample-checked batch / two datasets) and an open-report flag.
--   * place_detail returns one listing by slug under exactly the same visibility rules.
--   * place_reports: a signed-in member can report a wrong address, a duplicate, a closure or a place
--     that is not open to the public. Reports never change a listing by themselves; the founder sees
--     them in the review area and resolves each one.

-- The label for how a listing's identity is known.
create function app.identity_basis(p_identity text, p_batch uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when p_identity = 'verified' then 'verified'
    when p_batch is not null and coalesce((select a.decision = 'approve' and a.decided_at > now() - interval '90 days'
                                             from public.batch_approvals a where a.batch_id = p_batch order by a.decided_at desc, a.id desc limit 1), false)
      then 'batch_sampled'
    else 'corroborated' end;
$$;
revoke all on function app.identity_basis(text, uuid) from public, anon, authenticated;

create table public.place_reports (
  id            bigint generated always as identity primary key,
  listing_id    uuid not null references public.place_listings (id),
  reason        text not null check (reason in ('wrong_address', 'duplicate', 'closed', 'not_public', 'other')),
  note          text check (length(note) <= 500),
  reported_by   uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  resolution    text check (resolution in ('fixed', 'no_change', 'already_known')),
  resolution_note text check (length(resolution_note) <= 500),
  resolved_by   uuid references auth.users (id),
  resolved_at   timestamptz,
  check ((resolution is null) = (resolved_at is null) and (resolution is null) = (resolved_by is null))
);
create index place_reports_open on public.place_reports (listing_id) where resolved_at is null;
create index place_reports_reporter on public.place_reports (reported_by, created_at desc);
alter table public.place_reports enable row level security;
revoke all on public.place_reports from public, anon, authenticated;

-- A report is written once and resolved once, by the founder; it is never deleted by anyone but the
-- account deletion that removes the reporter.
create function app.guard_place_report()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.resolved_at is not null then raise exception 'A report is resolved once' using errcode = 'PT403'; end if;
    if (new.listing_id, new.reason, new.note, new.reported_by, new.created_at) is distinct from (old.listing_id, old.reason, old.note, old.reported_by, old.created_at) then
      raise exception 'Only the resolution can be recorded' using errcode = 'PT403';
    end if;
    if not exists (select 1 from public.role_assignments r where r.user_id = new.resolved_by and r.role = 'publisher') then
      raise exception 'Only the founder resolves a report' using errcode = 'PT403';
    end if;
  end if;
  return new;
end $$;
revoke all on function app.guard_place_report() from public, anon, authenticated;
create trigger place_reports_guard before update on public.place_reports
  for each row execute function app.guard_place_report();

-- Can this caller see this listing? The same rule as the directory.
create function app.place_visible(l public.place_listings, p_preview boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select (l.visibility = 'public' and app.listing_may_be_public(l.candidate_id, l.identity_status, l.publication_batch))
      or (coalesce(p_preview, false) and l.visibility = 'preview' and (app.has_role('publisher') or app.has_role('admin')));
$$;
revoke all on function app.place_visible(public.place_listings, boolean) from public, anon, authenticated;

drop function public.place_directory(jsonb);
create function public.place_directory(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_market text := coalesce(p->>'market', 'boston');
  v_preview boolean := coalesce((p->>'preview')::boolean, false) and (app.has_role('publisher') or app.has_role('admin'));
  v_map boolean := coalesce(p->>'mode', 'list') = 'map';
  v_q text := nullif(btrim(coalesce(p->>'q', '')), '');
  v_area text := nullif(btrim(coalesce(p->>'area', '')), '');
  v_lat double precision := round(((p->>'lat')::numeric), 3);
  v_lon double precision := round(((p->>'lon')::numeric), 3);
  v_radius integer := (p->>'radiusM')::integer;
  v_w double precision := (p->>'west')::double precision;
  v_s double precision := (p->>'south')::double precision;
  v_e double precision := (p->>'east')::double precision;
  v_n double precision := (p->>'north')::double precision;
  v_limit integer := coalesce((p->>'limit')::integer, case when coalesce(p->>'mode', 'list') = 'map' then 500 else 24 end);
  v_offset integer := coalesce((p->>'offset')::integer, 0);
  v_result jsonb;
begin
  if length(coalesce(v_q, '')) > 120 or length(coalesce(v_area, '')) > 120 then raise exception 'QUERY_TOO_LONG' using errcode = 'PT422'; end if;
  if v_limit < 1 or v_limit > (case when v_map then 500 else 50 end) then raise exception 'INVALID_LIMIT' using errcode = 'PT422'; end if;
  if v_offset < 0 or v_offset > 5000 then raise exception 'INVALID_CURSOR' using errcode = 'PT422'; end if;
  if (v_lat is null) <> (v_lon is null) then raise exception 'INVALID_POINT' using errcode = 'PT422'; end if;
  if v_radius is not null and (v_lat is null or v_radius not between 100 and 50000) then raise exception 'INVALID_RADIUS' using errcode = 'PT422'; end if;
  if num_nulls(v_w, v_s, v_e, v_n) not in (0, 4) or (v_w is not null and (v_w >= v_e or v_s >= v_n or v_e - v_w > 2 or v_n - v_s > 2)) then
    raise exception 'INVALID_BOX' using errcode = 'PT422';
  end if;

  with seen as (
    select l.* from public.place_listings l
     where l.market_slug = v_market and app.place_visible(l, v_preview)
  ), hit as (
    select s.*,
           case when v_lat is not null then 2 * 6371000 * asin(sqrt(power(sin(radians(s.lat - v_lat) / 2), 2)
             + cos(radians(v_lat)) * cos(radians(s.lat)) * power(sin(radians(s.lon - v_lon) / 2), 2))) end as distance_m
      from seen s
     where (v_q is null or s.name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%' or s.street ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%')
       and (v_area is null or s.area = v_area)
       and (v_w is null or (s.lon between v_w and v_e and s.lat between v_s and v_n))
  ), near as (
    select h.* from hit h where v_radius is null or h.distance_m <= v_radius
  ), ordered as (
    select h.*, row_number() over (order by h.distance_m asc nulls last, h.name, h.id) as rn from near h
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(case when v_map then jsonb_build_object(
        'id', o.id, 'slug', o.slug, 'name', o.name, 'street', o.street, 'category', o.category, 'area', o.area,
        'lat', round(o.lat::numeric, 5), 'lon', round(o.lon::numeric, 5),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'identityBasis', app.identity_basis(o.identity_status, o.publication_batch))
      else jsonb_build_object(
        'id', o.id, 'slug', o.slug, 'name', o.name, 'street', o.street, 'locality', o.locality, 'postcode', o.postcode,
        'area', o.area, 'category', o.category, 'lat', round(o.lat::numeric, 5), 'lon', round(o.lon::numeric, 5),
        'distanceM', case when o.distance_m is not null then round(o.distance_m::numeric) end,
        'identityStatus', o.identity_status, 'identityBasis', app.identity_basis(o.identity_status, o.publication_batch),
        'menuStatus', o.menu_status, 'visibility', o.visibility,
        'reported', exists (select 1 from public.place_reports r where r.listing_id = o.id and r.resolved_at is null),
        'sources', (select coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'attribution', s->>'attribution')), '[]'::jsonb) from jsonb_array_elements(o.sources) s)
      ) end order by o.rn) from ordered o where o.rn > v_offset and o.rn <= v_offset + v_limit), '[]'::jsonb),
    'total', (select count(*) from near),
    'nextOffset', case when (select count(*) from near) > v_offset + v_limit then v_offset + v_limit end,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('area', a.area, 'count', a.n) order by a.n desc, a.area)
                         from (select s.area, count(*) n from seen s where s.area is not null group by s.area) a), '[]'::jsonb),
    'preview', v_preview
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.place_directory(jsonb) from public;
grant execute on function public.place_directory(jsonb) to anon, authenticated;

-- One real place, by its slug, under the directory's visibility rule. Identity only.
create function public.place_detail(p_slug text, p_preview boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare l public.place_listings; v_batch jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9-]{2,120}$' then return null; end if;
  select * into l from public.place_listings where slug = p_slug;
  if not found or not app.place_visible(l, p_preview) then return null; end if;
  if l.publication_batch is not null and app.identity_basis(l.identity_status, l.publication_batch) = 'batch_sampled' then
    select jsonb_build_object('name', b.name, 'sampleSize', a.sample_size, 'problems', a.problems, 'upperBound', a.upper_bound, 'approvedAt', a.decided_at)
      into v_batch
      from public.publication_batches b
      join lateral (select * from public.batch_approvals x where x.batch_id = b.id order by x.decided_at desc, x.id desc limit 1) a on true
     where b.id = l.publication_batch;
  end if;
  return jsonb_build_object(
    'id', l.id, 'slug', l.slug, 'name', l.name, 'street', l.street, 'locality', l.locality, 'postcode', l.postcode, 'area', l.area,
    'category', l.category, 'lat', round(l.lat::numeric, 5), 'lon', round(l.lon::numeric, 5),
    'identityStatus', l.identity_status, 'identityBasis', app.identity_basis(l.identity_status, l.publication_batch),
    'menuStatus', l.menu_status, 'visibility', l.visibility, 'updatedAt', l.updated_at,
    'batch', v_batch,
    'reported', exists (select 1 from public.place_reports r where r.listing_id = l.id and r.resolved_at is null),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('title', s->>'title', 'attribution', s->>'attribution', 'release', s->>'release')), '[]'::jsonb) from jsonb_array_elements(l.sources) s)
  );
end $$;
revoke all on function public.place_detail(text, boolean) from public;
grant execute on function public.place_detail(text, boolean) to anon, authenticated;

-- A member reports a problem with a place they can see. Never changes the listing.
create function public.report_place_problem(p_listing uuid, p_reason text, p_note text default null, p_preview boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.place_listings; v_id bigint;
begin
  if auth.uid() is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  if p_reason is null or p_reason not in ('wrong_address', 'duplicate', 'closed', 'not_public', 'other') then raise exception 'INVALID_REASON' using errcode = 'PT422'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'NOTE_TOO_LONG' using errcode = 'PT422'; end if;
  if p_reason = 'other' and nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'NOTE_REQUIRED' using errcode = 'PT422'; end if;
  select * into l from public.place_listings where id = p_listing;
  if not found or not app.place_visible(l, p_preview) then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  if exists (select 1 from public.place_reports r where r.listing_id = p_listing and r.reported_by = auth.uid() and r.reason = p_reason and r.resolved_at is null) then
    raise exception 'ALREADY_REPORTED' using errcode = 'PT409';
  end if;
  if (select count(*) from public.place_reports r where r.reported_by = auth.uid() and r.created_at > now() - interval '1 day') >= 10 then
    raise exception 'TOO_MANY_REPORTS' using errcode = 'PT429';
  end if;
  insert into public.place_reports (listing_id, reason, note, reported_by)
  values (p_listing, p_reason, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;
revoke all on function public.report_place_problem(uuid, text, text, boolean) from public, anon;
grant execute on function public.report_place_problem(uuid, text, text, boolean) to authenticated;

-- The founder's list of reports, open first. The reporter is never named.
create function public.place_reports_queue(p_open_only boolean default true)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_founder();
  return jsonb_build_object(
    'open', (select count(*) from public.place_reports where resolved_at is null),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'reason', r.reason, 'note', r.note, 'createdAt', r.created_at,
        'resolution', r.resolution, 'resolutionNote', r.resolution_note, 'resolvedAt', r.resolved_at,
        'listing', jsonb_build_object('slug', l.slug, 'name', l.name, 'street', l.street, 'postcode', l.postcode, 'candidateId', l.candidate_id, 'visibility', l.visibility),
        'inReview', exists (select 1 from public.identity_review_items i where i.candidate_id = l.candidate_id and i.active)
      ) order by (r.resolved_at is not null), r.created_at desc)
      from (select * from public.place_reports x where not coalesce(p_open_only, true) or x.resolved_at is null order by x.created_at desc limit 200) r
      join public.place_listings l on l.id = r.listing_id), '[]'::jsonb));
end $$;

-- The founder resolves one report. Resolving never changes the listing: a wrong place is handled by
-- the founder's identity decision on it, in the review area.
create function public.resolve_place_report(p_report bigint, p_resolution text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.require_founder();
  if p_resolution not in ('fixed', 'no_change', 'already_known') then raise exception 'INVALID_RESOLUTION' using errcode = 'PT422'; end if;
  if length(coalesce(p_note, '')) > 500 then raise exception 'NOTE_TOO_LONG' using errcode = 'PT422'; end if;
  update public.place_reports set resolution = p_resolution, resolution_note = nullif(btrim(coalesce(p_note, '')), ''), resolved_by = auth.uid(), resolved_at = now()
   where id = p_report and resolved_at is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'PT404'; end if;
  return jsonb_build_object('id', p_report, 'resolution', p_resolution);
end $$;

revoke all on function public.place_reports_queue(boolean), public.resolve_place_report(bigint, text, text) from public, anon;
grant execute on function public.place_reports_queue(boolean), public.resolve_place_report(bigint, text, text) to authenticated;
