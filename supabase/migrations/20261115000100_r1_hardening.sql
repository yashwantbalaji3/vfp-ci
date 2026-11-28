-- R1 hardening (plans/2026-11-14-integration-readiness-audit.md, docs/14 PH-01 and PH-03).
-- Nothing here adds a product feature. It closes four gaps found in the audit:
--   1. Anyone could call the request counter directly (PH-01 test 1).
--   2. Nothing removed old private leftovers unless a member happened to act (PH-03).
--   3. Signed-out and signed-in roles held more table privileges than any rule allowed.
--   4. New tables would have started with those same wide privileges.
-- Rollback: see the end of this file.

-- ---------------------------------------------------------------------------
-- 1. Only the application server can record a rate-limit hit.
--    The server sends a secret (RATE_LIMIT_KEY) with every hit. The database keeps
--    only a one-way SHA-256 digest of that secret, so reading this table does not
--    reveal it. No privileged database key is used for ordinary requests (CLAUDE.md).
--    Two digests may exist at once so the secret can be rotated without downtime:
--    register the new one, deploy the server with it, and the old one drops off at
--    the next rotation.
-- ---------------------------------------------------------------------------
create table app.server_keys (
  purpose  text not null check (purpose in ('rate_limit')),
  digest   bytea not null check (octet_length(digest) = 32),
  added_at timestamptz not null default now(),
  primary key (purpose, digest)
);
alter table app.server_keys enable row level security;
alter table app.server_keys force row level security;
revoke all on app.server_keys from public, anon, authenticated;

-- Run by a database administrator only (never over HTTP). Takes the digest, not the
-- secret, so the secret never appears in a statement log.
create function app.register_server_key(p_purpose text, p_digest_hex text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_digest_hex !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_DIGEST' using errcode = 'PT422';
  end if;
  insert into app.server_keys (purpose, digest) values (p_purpose, decode(p_digest_hex, 'hex'))
    on conflict (purpose, digest) do update set added_at = now();
  -- Keep the newest two for this purpose: the current secret and the one before it.
  delete from app.server_keys k
   where k.purpose = p_purpose
     and k.digest not in (select s.digest from app.server_keys s where s.purpose = p_purpose order by s.added_at desc, s.digest limit 2);
end;
$$;

drop function public.rate_limit_hit(text, integer, integer);

create function public.rate_limit_hit(p_proof text, p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  -- Same refusal whether the proof is missing, wrong, or no key has been registered:
  -- an unconfigured database refuses every hit, so the app fails closed.
  if p_proof is null or length(p_proof) < 32 or length(p_proof) > 200 or not exists (
       select 1 from app.server_keys k
        where k.purpose = 'rate_limit' and k.digest = sha256(convert_to(p_proof, 'UTF8'))) then
    raise exception 'NOT_ALLOWED' using errcode = 'PT403';
  end if;
  if p_bucket !~ '^[a-z0-9_:-]{8,120}$' or p_limit < 1 or p_limit > 10000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'INVALID_RATE_LIMIT' using errcode = 'PT422';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_windows as w (bucket, window_start) values (p_bucket, v_window)
    on conflict (bucket, window_start) do update set hits = w.hits + 1
    returning hits into v_hits;
  return v_hits <= p_limit;
end;
$$;
revoke all on function public.rate_limit_hit(text, text, integer, integer) from public;
grant execute on function public.rate_limit_hit(text, text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Scheduled clean-up (PH-03 and the other leftovers).
--    One function, run every 15 minutes by the database's own scheduler, so nothing
--    depends on a member coming back. It only ever removes things that are already
--    past their stated life:
--      * diary entries the member removed more than 15 minutes ago (the undo window),
--        with their snapshots;
--      * expired "do not repeat this request" records;
--      * account-deletion markers whose backup period has ended;
--      * social action counters and request counters older than two days;
--      * its own run records older than 90 days.
--    p_now exists so a test can move the clock.
-- ---------------------------------------------------------------------------
create table app.maintenance_runs (
  id      bigint generated always as identity primary key,
  ran_at  timestamptz not null default now(),
  removed jsonb not null
);
alter table app.maintenance_runs enable row level security;
alter table app.maintenance_runs force row level security;
revoke all on app.maintenance_runs from public, anon, authenticated;

create function app.run_maintenance(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_diary integer;
  v_idem integer;
  v_tomb integer;
  v_social integer;
  v_rate integer;
  v_result jsonb;
begin
  delete from public.diary_entries where deleted_at < p_now - interval '15 minutes';
  get diagnostics v_diary = row_count;
  delete from public.idempotency_records where expires_at < p_now;
  get diagnostics v_idem = row_count;
  delete from public.deletion_tombstones where completed_at is not null and backup_expiry < p_now;
  get diagnostics v_tomb = row_count;
  delete from public.social_action_log where at < p_now - interval '2 days';
  get diagnostics v_social = row_count;
  delete from public.rate_limit_windows where window_start < p_now - interval '2 days';
  get diagnostics v_rate = row_count;
  delete from app.maintenance_runs where ran_at < p_now - interval '90 days';
  -- Counts only: never an owner, an entry or a bucket.
  v_result := jsonb_build_object(
    'diaryEntries', v_diary, 'idempotencyRecords', v_idem, 'deletionMarkers', v_tomb,
    'socialActions', v_social, 'rateWindows', v_rate);
  insert into app.maintenance_runs (ran_at, removed) values (p_now, v_result);
  return v_result;
end;
$$;

-- Administrator and scheduler only. (Named one by one: a blanket revoke on schema app
-- would also take away the helper functions that row rules rely on.)
revoke execute on function app.run_maintenance(timestamptz) from public, anon, authenticated;
revoke execute on function app.register_server_key(text, text) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('vfp-maintenance', '*/15 * * * *', 'select app.run_maintenance()');
  else
    raise notice 'pg_cron is not available here: app.run_maintenance() must be scheduled another way before hosting.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Table privileges follow the rules, nothing more.
--    Row rules (RLS) already decided what each role could see. But the roles also
--    held blanket privileges (including TRUNCATE, which row rules do not cover) on
--    31 older tables. Remove everything, then give back exactly what a row rule
--    exists for. A signed-out caller ends with read-only access to public catalog
--    tables and no privilege at all on any private table.
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
  p record;
  r text;
  v_privs text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') loop
    execute format('revoke all on public.%I from anon, authenticated', t.relname);
  end loop;
  for p in select tablename, cmd, roles from pg_policies where schemaname = 'public' loop
    v_privs := case p.cmd when 'ALL' then 'select, insert, update, delete' else lower(p.cmd) end;
    foreach r in array p.roles loop
      if r in ('anon', 'authenticated') then
        execute format('grant %s on public.%I to %I', v_privs, p.tablename, r);
      end if;
    end loop;
  end loop;
end;
$$;

-- 4. Tables created later start closed; each must be opened on purpose.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. A missing profile or list must answer with a real 404 (audit defect AUD-D3).
--    The pages stream their frame first, which fixes the status at 200, so the
--    request proxy asks this question before the page starts. It uses the same
--    visibility helpers as the pages, so "does not exist", "private", "pending",
--    "removed" and "blocked" all give the same answer and cannot be told apart.
-- ---------------------------------------------------------------------------
create function public.social_page_exists(p_kind text, p_ref text, p_include_demo boolean default false)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
    when 'profile' then coalesce((
      select app.profile_ok((select auth.uid()), u.id, p_include_demo)
        from (select app.user_by_handle(left(p_ref, 60)) as id) u where u.id is not null), false)
    when 'list' then case
      when p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then exists (
        select 1 from public.food_lists l
         where l.id = p_ref::uuid and app.list_visible((select auth.uid()), l, p_include_demo))
      else false end
    else false
  end;
$$;
revoke execute on function public.social_page_exists(text, text, boolean) from public, anon, authenticated;
grant execute on function public.social_page_exists(text, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Saved items say when they no longer fit the member's dietary filter (docs/14:
--    "Saved content stays visible with a mismatch warning after preference change;
--    it is not silently deleted or recommended again"). The saved list now carries the
--    same eligibility answer every other surface uses (app.eligibility), so the wording
--    cannot drift. Nothing is removed from the list; the member decides.
-- ---------------------------------------------------------------------------
drop function public.my_saves(boolean);
create function public.my_saves(p_include_demo boolean default false, p_diet text default 'none', p_exclusions text[] default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN' using errcode = 'PT401'; end if;
  return jsonb_build_object(
    'foods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'foodItemId', fi.id, 'revisionId', r.id, 'kind', fi.kind,
        'name', r.name, 'brand', r.brand, 'isDemo', fi.is_demo,
        'venue', (select jsonb_build_object('id', v.id, 'name', v.name, 'neighborhood', v.neighborhood)
                    from public.dishes d join public.venues v on v.id = d.venue_id where d.food_item_id = fi.id),
        'protein', app.protein_facts(r.id, false),
        -- Strict reading: a dish that fits only with a change is reported as 'conditional', never as a plain match.
        'eligibility', app.eligibility(r.id, coalesce(p_diet, 'none'), coalesce(p_exclusions, '{}'), false)) order by s.created_at desc, s.id)
      from public.saves s
      join public.food_items fi on fi.id = s.food_item_id and fi.visibility = 'public' and fi.status = 'published'
                               and (p_include_demo or not fi.is_demo)
      join public.food_revisions r on r.id = fi.current_revision_id and r.published_at is not null
      where s.owner_id = v_uid), '[]'::jsonb),
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object(
        'saveId', s.id, 'savedAt', s.created_at, 'id', v.id, 'name', v.name, 'neighborhood', v.neighborhood,
        'locality', v.locality, 'cuisines', to_jsonb(v.cuisines), 'priceBand', v.price_band, 'isDemo', v.is_demo)
        order by s.created_at desc, s.id)
      from public.saves s
      join public.venues v on v.id = s.venue_id and v.status in ('published', 'temporarily_closed')
                          and (p_include_demo or not v.is_demo)
      where s.owner_id = v_uid), '[]'::jsonb),
    'total', (select count(*) from public.saves s where s.owner_id = v_uid));
end;
$$;
revoke execute on function public.my_saves(boolean, text, text[]) from public, anon, authenticated;
grant execute on function public.my_saves(boolean, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Search works out each dish's dietary answer and protein facts ONCE (scale test, R1).
--    The search function computed them in one step and used them in several later steps.
--    The database was free to fold those steps together and repeat the calculation for
--    every use, which the scale test (2,000 dishes) showed it did: a filtered search took
--    about 1.4 seconds. Marking that one step "materialized" makes it run once per dish.
--    Nothing about the rule or the results changes; the full suite and the dietary matrix
--    test (tests/db/r1-dietary-matrix.test.ts) confirm the answers are identical.
--    The function text is changed in place so that this file cannot drift from the
--    original definition; it stops with an error if the expected text is not there.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.search_catalog(jsonb)'::regprocedure);
  v_new text := replace(v_def, '), facts as (', '), facts as materialized (');
begin
  if v_new = v_def then
    raise exception 'search_catalog: the step to mark as materialized was not found';
  end if;
  execute v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rollback (local or a disposable copy only; never run against data without approval):
--   search_catalog: re-run 20261113000600_m2_discovery.sql's definition (removes the word "materialized").
--   drop function public.my_saves(boolean, text, text[]);  -- then re-create my_saves(boolean) from 20261113000600_m2_discovery.sql
--   drop function public.social_page_exists(text, text, boolean);
--   select cron.unschedule('vfp-maintenance');
--   drop function app.run_maintenance(timestamptz); drop table app.maintenance_runs;
--   drop function public.rate_limit_hit(text, text, integer, integer);
--   -- then re-create rate_limit_hit(text, integer, integer) from 20261113000600_m2_discovery.sql
--   drop function app.register_server_key(text, text); drop table app.server_keys;
--   The privilege changes are not reversed: they remove access no rule allowed.
-- ---------------------------------------------------------------------------
