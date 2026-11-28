-- Boston-wide restaurant IDENTITY import (owner 23:59 UTC 16 Nov: "Restaurant identity and discovery:
-- Bulk-import locations, names, addresses, coordinates and supported metadata, with deduplication,
-- source provenance, update history and quality checks"). Plan: docs/31.
--
-- A private holding area for bulk-imported place identities. LOCAL ONLY, like `staging`:
--   * Separate schema `catalog_import`, not in the Data API; closed to anon and authenticated, and
--     Row Level Security denies everything by default. Only the local import script (database owner)
--     reads or writes it.
--   * Nothing here is read by any public screen, search, map, count, Protein Explorer or diary, and
--     there is no function that copies a candidate into the public catalog. Publication stays behind
--     the real-data lock and the owner's separate approval.
--   * Identity only: name, address, position, category hint, operating-status hint and links to the
--     source records. No menu, dietary, allergen or nutrition data is ever stored here, so nothing
--     imported can pass a dietary filter.
--   * Every source record keeps its dataset, release, licence and record id. Every import run is
--     recorded with its counts and thresholds, and every change to a source record is appended to
--     `record_history` (never edited or deleted).
--   * Real records only; demo fixtures stay in the public catalog with is_demo = true.

create schema catalog_import;
revoke all on schema catalog_import from public, anon, authenticated;

create table catalog_import.sources (
  key            text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  title          text not null check (length(title) between 1 and 200),
  publisher      text not null check (length(publisher) between 1 and 200),
  licence        text not null check (length(licence) between 1 and 100),
  licence_url    text check (licence_url ~ '^https://'),
  homepage       text check (homepage ~ '^https://'),
  -- What the licence lets us do with identity data, in plain words (recorded from the licence text).
  permitted_use  text not null check (length(permitted_use) between 1 and 1000),
  attribution    text not null check (length(attribution) between 1 and 500),
  recorded_on    date not null
);

create table catalog_import.import_runs (
  id             uuid primary key default gen_random_uuid(),
  source_key     text not null references catalog_import.sources (key),
  release        text not null check (length(release) between 1 and 100),
  file_sha256    text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  retrieved_at   timestamptz not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'completed', 'refused')),
  thresholds     jsonb not null,
  counts         jsonb not null default '{}'::jsonb,
  refusal        text
);

create table catalog_import.source_records (
  id             uuid primary key default gen_random_uuid(),
  source_key     text not null references catalog_import.sources (key),
  external_id    text not null check (length(external_id) between 1 and 200),
  name           text not null check (length(name) between 1 and 300),
  street         text check (length(street) <= 300),
  locality       text check (length(locality) <= 100),
  postcode       text check (postcode ~ '^[0-9]{5}$'),
  lat            double precision not null check (lat between 42.2 and 42.5),
  lon            double precision not null check (lon between -71.3 and -70.9),
  category       text check (length(category) <= 100),
  status_hint    text check (status_hint in ('open', 'licensed_active', 'unknown')),
  confidence     numeric(4, 3) check (confidence between 0 and 1),
  website        text check (website ~ '^https?://' and length(website) <= 500),
  record_licence text not null check (length(record_licence) between 1 and 100),
  record_hash    text not null check (record_hash ~ '^[0-9a-f]{64}$'),
  first_run      uuid not null references catalog_import.import_runs (id),
  last_run       uuid not null references catalog_import.import_runs (id),
  -- Present in the latest run of its source? A record missing from a later release is kept, marked
  -- absent, never deleted.
  present        boolean not null default true,
  unique (source_key, external_id)
);

create table catalog_import.record_history (
  id             bigint generated always as identity primary key,
  record_id      uuid not null references catalog_import.source_records (id),
  run_id         uuid not null references catalog_import.import_runs (id),
  change         text not null check (change in ('added', 'changed', 'absent', 'returned')),
  old_hash       text,
  new_hash       text,
  at             timestamptz not null default now()
);

-- A candidate is one physical place as we currently understand it: one or more linked source records.
create table catalog_import.place_candidates (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 300),
  street         text,
  postcode       text check (postcode ~ '^[0-9]{5}$'),
  lat            double precision not null,
  lon            double precision not null,
  category       text,
  -- quality: 'corroborated' (two independent sources agree), 'single_source' (one source passed every
  -- check), 'needs_review' (a check is borderline), 'rejected' (a person rejected it). Never "verified":
  -- identity verification is the founder's step in the pilot workflow.
  quality        text not null check (quality in ('corroborated', 'single_source', 'needs_review', 'rejected')),
  flags          text[] not null default '{}',
  created_run    uuid not null references catalog_import.import_runs (id),
  updated_at     timestamptz not null default now()
);

create table catalog_import.candidate_links (
  candidate_id   uuid not null references catalog_import.place_candidates (id),
  record_id      uuid not null references catalog_import.source_records (id) unique,
  match_score    numeric(4, 3) not null check (match_score between 0 and 1),
  match_method   text not null check (match_method in ('seed', 'auto_strict', 'person')),
  primary key (candidate_id, record_id)
);

create index source_records_pos on catalog_import.source_records (lat, lon);
create index record_history_record on catalog_import.record_history (record_id);

do $$
declare t text;
begin
  foreach t in array array['sources', 'import_runs', 'source_records', 'record_history', 'place_candidates', 'candidate_links'] loop
    execute format('alter table catalog_import.%I enable row level security', t);
    execute format('revoke all on catalog_import.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- The sources and licences as read on 17 Nov 2026 (docs/31 section 3). Re-read before each import.
insert into catalog_import.sources (key, title, publisher, licence, licence_url, homepage, permitted_use, attribution, recorded_on) values
  ('overture_places', 'Overture Maps Places', 'Overture Maps Foundation', 'CDLA-Permissive-2.0 (per record: also Apache-2.0, CC0-1.0)',
   'https://cdla.dev/permissive-2-0/', 'https://docs.overturemaps.org/attribution/',
   'Use, modify and share the data, including in a product, without share-alike. Keep the per-record licence and give the attribution Overture lists.',
   '© Overture Maps Foundation, with the per-source credits in its attribution guide', '2026-11-17'),
  ('boston_food_licenses', 'Active Food Establishment Licenses', 'City of Boston (Analyze Boston)', 'ODC-PDDL-1.0',
   'https://opendatacommons.org/licenses/pddl/1-0/', 'https://data.boston.gov/dataset/active-food-establishment-licenses',
   'Public domain dedication: any use. Used for "licensed and active" and position only, never as a food-safety claim. The phone column is not imported.',
   'City of Boston, Analyze Boston (courtesy credit)', '2026-11-17'),
  ('cambridge_food_permits', 'Food Establishment Permits', 'City of Cambridge (Open Data Portal)', 'ODC-PDDL-1.0',
   'https://opendatacommons.org/licenses/pddl/1-0/', 'https://data.cambridgema.gov/Inspectional-Services/Food-Establishment-Permits/iect-ma2e',
   'Public domain dedication: any use. Only business name, address, position and permit date are read; the applicant name and every other column are never imported. Corroborates a place; never starts one.',
   'City of Cambridge Open Data (courtesy credit)', '2026-11-17');
