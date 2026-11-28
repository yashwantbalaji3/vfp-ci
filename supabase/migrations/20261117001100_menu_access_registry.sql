-- MENU-2b: the source-access registry (owner direction 17 Nov 2026 22:06 UTC, option A).
--
--   * Before any automated request, a source needs BOTH an allowing robots.txt check and a current
--     permission record that permits automated reading and our use: a terms-of-use review, a written
--     permission from the restaurant, a licence, or API terms. Anything uncertain fails closed.
--   * The registry keeps permission status, evidence (the quoted clause or the permission's
--     reference), the date checked, the permitted uses, who reviewed it, and an optional expiry.
--   * An authorized menu export (a file the restaurant gave us under written permission) is stored
--     like a snapshot, tied to that permission instead of a robots.txt check.
--   * Content that must not be kept can be removed: snapshots, reads and items for one source are
--     deleted together, and an audit row records what was removed (counts and fingerprints only).

create table menu_ingest.access_permissions (
  id              bigint generated always as identity primary key,
  source_id       uuid not null references menu_ingest.sources (id),
  kind            text not null check (kind in ('terms_review', 'written_permission', 'licence', 'api_terms')),
  status          text not null check (status in ('permits', 'prohibits', 'unclear', 'unreadable')),
  document_url    text check (document_url ~ '^https?://' and length(document_url) <= 2000),
  evidence        text not null check (length(evidence) between 3 and 2000),
  permitted_uses  text check (length(permitted_uses) <= 1000),
  reviewer        text not null check (length(reviewer) between 2 and 200),
  reviewed_at     timestamptz not null default now(),
  expires_at      timestamptz,
  recorded_at     timestamptz not null default now(),
  check (status <> 'permits' or permitted_uses is not null)
);
create index menu_ingest_access_permissions_source on menu_ingest.access_permissions (source_id, reviewed_at desc, id desc);

-- Removals: what was deleted, why, and on whose authority. Never the content itself.
create table menu_ingest.removals (
  id               bigint generated always as identity primary key,
  source_id        uuid not null references menu_ingest.sources (id),
  removed_at       timestamptz not null default now(),
  reason           text not null check (length(reason) between 3 and 1000),
  authority        text not null check (length(authority) between 3 and 500),
  snapshots        int not null check (snapshots >= 0),
  read_runs        int not null check (read_runs >= 0),
  items            int not null check (items >= 0),
  snapshot_sha256  text[] not null default '{}'
);

-- Authorized exports: a snapshot tied to a permission instead of a robots.txt check.
alter table menu_ingest.snapshots alter column access_check_id drop not null;
alter table menu_ingest.snapshots add column permission_id bigint references menu_ingest.access_permissions (id);
alter table menu_ingest.snapshots drop constraint snapshots_fetched_via_check;
alter table menu_ingest.snapshots add constraint snapshots_fetched_via_check check (fetched_via in ('cloud', 'local_import', 'authorized_export'));
alter table menu_ingest.snapshots add constraint snapshots_basis check (
  (fetched_via in ('cloud', 'local_import') and access_check_id is not null)
  or (fetched_via = 'authorized_export' and permission_id is not null));

-- History stays permanent, except for a removal run through remove_source_content() below.
create or replace function menu_ingest.guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('menu_ingest.removal', true) = 'on'
     and tg_table_name in ('snapshots', 'read_runs', 'items') then
    return old;
  end if;
  raise exception 'Menu source history is permanent' using errcode = 'P0001';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['access_permissions', 'removals'] loop
    execute format('alter table menu_ingest.%I enable row level security', t);
    execute format('alter table menu_ingest.%I force row level security', t);
    execute format('revoke all on menu_ingest.%I from public, anon, authenticated', t);
    execute format('create policy %I on menu_ingest.%I for all to postgres using (true) with check (true)', t || '_owner', t);
    execute format('create trigger %I before update or delete on menu_ingest.%I for each row execute function menu_ingest.guard_append_only()', t || '_append_only', t);
  end loop;
end;
$$;

/** Delete one source's saved pages, reads and items; record counts and fingerprints only. */
create function menu_ingest.remove_source_content(p_source uuid, p_reason text, p_authority text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_items int; v_runs int; v_snaps int; v_shas text[]; v_id bigint;
begin
  select count(*) into v_items from menu_ingest.items where source_id = p_source;
  select count(*) into v_runs from menu_ingest.read_runs r join menu_ingest.snapshots n on n.id = r.snapshot_id where n.source_id = p_source;
  select count(*), coalesce(array_agg(sha256 order by id), '{}') into v_snaps, v_shas from menu_ingest.snapshots where source_id = p_source;
  perform set_config('menu_ingest.removal', 'on', true);
  delete from menu_ingest.items where source_id = p_source
     or read_run_id in (select r.id from menu_ingest.read_runs r join menu_ingest.snapshots n on n.id = r.snapshot_id where n.source_id = p_source);
  delete from menu_ingest.read_runs where snapshot_id in (select id from menu_ingest.snapshots where source_id = p_source);
  delete from menu_ingest.snapshots where source_id = p_source;
  perform set_config('menu_ingest.removal', 'off', true);
  insert into menu_ingest.removals (source_id, reason, authority, snapshots, read_runs, items, snapshot_sha256)
  values (p_source, p_reason, p_authority, v_snaps, v_runs, v_items, v_shas) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function menu_ingest.remove_source_content(uuid, text, text) from public, anon, authenticated;

-- The latest robots.txt check and the latest permission record, side by side. Only "may_fetch"
-- may be fetched or read; "may_import" accepts authorized exports only.
drop view menu_ingest.source_status;
create view menu_ingest.source_status with (security_invoker = true) as
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
