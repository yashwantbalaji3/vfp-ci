-- MENU-2 (PR 1 of the menu pipeline, docs/41): where each real place's official menu lives, and
-- whether we are allowed to read it.
--
-- Owner direction 17 Nov 2026 17:34 UTC: discover official menus through legally permitted sources,
-- respect website access restrictions and licensing, keep every unverified fact private, and never
-- let one blocked website stall the others.
--
--   * A closed schema, like catalog_import and staging: RLS forced, no grants, not in the Data API.
--     Nothing outside it reads it (tested).
--   * Only the restaurant's or chain's own website is a menu source. Delivery apps, review sites,
--     coupon sites, booking sites and link pages are excluded hosts and are recorded as excluded.
--   * Every robots.txt check is kept as dated, append-only history with the file's fingerprint and
--     the rule that decided it. A source may be fetched only while its latest check says "allowed".
--     Anything unreachable or unclear counts as not allowed.
--   * This stores no menu, dish, dietary, allergen or nutrition data. Those come in later PRs, still
--     private, still waiting for the founder's check.

create schema menu_ingest;
revoke all on schema menu_ingest from public, anon, authenticated;

create function menu_ingest.guard_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Menu source history is permanent' using errcode = 'P0001';
end;
$$;

-- Hosts that are never a restaurant's own menu. Matched on the host itself or any subdomain of it.
create table menu_ingest.excluded_hosts (
  host        text primary key check (host ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  reason      text not null check (length(reason) between 3 and 300),
  recorded_on date not null default current_date
);

insert into menu_ingest.excluded_hosts (host, reason) values
  ('grubhub.com', 'Delivery app, not the restaurant''s own page; its terms restrict reuse'),
  ('seamless.com', 'Delivery app, not the restaurant''s own page; its terms restrict reuse'),
  ('doordash.com', 'Delivery app, not the restaurant''s own page; its terms restrict reuse'),
  ('ubereats.com', 'Delivery app, not the restaurant''s own page; its terms restrict reuse'),
  ('postmates.com', 'Delivery app, not the restaurant''s own page; its terms restrict reuse'),
  ('caviar.com', 'Delivery app, not the restaurant''s own page; its terms restrict reuse'),
  ('ezcater.com', 'Catering marketplace, not the restaurant''s own page'),
  ('yelp.com', 'Review site; its terms forbid reuse of its content'),
  ('tripadvisor.com', 'Review site; its terms forbid reuse of its content'),
  ('groupon.com', 'Coupon site, not the restaurant''s own page'),
  ('opentable.com', 'Booking site, not the restaurant''s own page'),
  ('resy.com', 'Booking site, not the restaurant''s own page'),
  ('exploretock.com', 'Booking site, not the restaurant''s own page'),
  ('toasttab.com', 'Ordering platform run by a third party; its terms have not been reviewed'),
  ('olo.com', 'Ordering platform run by a third party; its terms have not been reviewed'),
  ('square.site', 'Ordering platform run by a third party; its terms have not been reviewed'),
  ('clover.com', 'Payment and ordering platform run by a third party; its terms have not been reviewed'),
  ('chownow.com', 'Ordering platform run by a third party; its terms have not been reviewed'),
  ('linktr.ee', 'Link page, not a menu'),
  ('facebook.com', 'Social network; its terms forbid automated collection'),
  ('instagram.com', 'Social network; its terms forbid automated collection'),
  ('calendar.boston.com', 'News events calendar, not the restaurant''s own page'),
  ('google.com', 'Search or maps page, not the restaurant''s own page'),
  ('goo.gl', 'Short link, not the restaurant''s own page'),
  ('bit.ly', 'Short link, not the restaurant''s own page');

-- One row per website (host) that serves a menu for one or more catalog places. A chain whose
-- locations all point at one site is one source with many places.
create table menu_ingest.sources (
  id            uuid primary key default gen_random_uuid(),
  host          text not null unique check (host ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  start_url     text not null check (start_url ~ '^https?://' and length(start_url) <= 500),
  scope         text not null check (scope in ('location', 'brand')),
  excluded_by   text references menu_ingest.excluded_hosts (host),
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

-- Which catalog places point at which source, and from which public record that was learned.
create table menu_ingest.source_places (
  source_id     uuid not null references menu_ingest.sources (id),
  candidate_id  uuid not null references catalog_import.place_candidates (id),
  website       text not null check (length(website) <= 500),
  first_seen    timestamptz not null default now(),
  primary key (source_id, candidate_id)
);
create index menu_ingest_source_places_candidate on menu_ingest.source_places (candidate_id);

-- Every access check, kept forever.
create table menu_ingest.access_checks (
  id            bigint generated always as identity primary key,
  source_id     uuid not null references menu_ingest.sources (id),
  checked_at    timestamptz not null default now(),
  robots_url    text not null check (robots_url ~ '^https?://'),
  http_status   int check (http_status between 100 and 599),
  robots_sha256 text check (robots_sha256 ~ '^[0-9a-f]{64}$'),
  -- The file itself, so later stages can test every page they want against the same rules.
  robots_text   text check (length(robots_text) <= 512000),
  user_agent    text not null check (length(user_agent) between 3 and 200),
  path_checked  text not null check (path_checked ~ '^/' and length(path_checked) <= 500),
  decision      text not null check (decision in ('allowed', 'disallowed', 'unreachable', 'excluded')),
  rule          text check (length(rule) <= 500),
  note          text check (length(note) <= 500),
  terms_url     text check (terms_url ~ '^https?://'),
  terms_note    text check (length(terms_note) <= 1000)
);
create index menu_ingest_access_checks_source on menu_ingest.access_checks (source_id, checked_at desc, id desc);

create trigger access_checks_append_only before update or delete on menu_ingest.access_checks
  for each row execute function menu_ingest.guard_append_only();
create trigger source_places_append_only before update or delete on menu_ingest.source_places
  for each row execute function menu_ingest.guard_append_only();

-- The latest decision for each source. Only "allowed" may be fetched.
create view menu_ingest.source_status with (security_invoker = true) as
  select s.id, s.host, s.start_url, s.scope, s.excluded_by,
         (select count(*) from menu_ingest.source_places p where p.source_id = s.id)::int as places,
         c.decision, c.checked_at, c.rule, c.note,
         case when s.excluded_by is not null then 'excluded'
              when c.decision is null then 'not_checked'
              when c.decision = 'allowed' then 'may_fetch'
              else 'blocked' end as state
    from menu_ingest.sources s
    left join lateral (select * from menu_ingest.access_checks a where a.source_id = s.id
                        order by a.checked_at desc, a.id desc limit 1) c on true;

do $$
declare t text;
begin
  foreach t in array array['excluded_hosts', 'sources', 'source_places', 'access_checks'] loop
    execute format('alter table menu_ingest.%I enable row level security', t);
    execute format('alter table menu_ingest.%I force row level security', t);
    execute format('revoke all on menu_ingest.%I from public, anon, authenticated', t);
    execute format('create policy %I on menu_ingest.%I for all to postgres using (true) with check (true)', t || '_owner', t);
  end loop;
end;
$$;
revoke all on menu_ingest.source_status from public, anon, authenticated;
revoke all on function menu_ingest.guard_append_only() from public, anon, authenticated;
