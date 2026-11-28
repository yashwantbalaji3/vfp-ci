-- MENU-3 (PR 2 of the menu pipeline, docs/41): dated, fingerprinted copies of the menu pages we
-- are allowed to read, and the menu items read from them. Still private, still unverified.
--
-- Owner direction 17 Nov 2026 18:00 UTC: a reviewed cloud allowlist of chain websites first, and
-- the same pipeline for permitted local imports (the founder's Mac) without duplicate engineering.
--
--   * A snapshot is never edited or deleted. The same page with the same content is stored once.
--   * Every snapshot names the access check (robots.txt decision) that allowed it, and where it was
--     fetched: in the cloud workspace or imported from a local run. Both land in the same table.
--   * Items keep the restaurant's own words exactly (name, description, labels, ingredients) next to
--     the cleaned name used for matching. Nutrition keeps its amount, unit and basis; a missing
--     value is null, never zero.
--   * Nothing here is a verified fact. Items reach the founder review page only as submitted facts
--     (MENU-4), and the public catalog never reads this schema (tested).

create table menu_ingest.snapshots (
  id               bigint generated always as identity primary key,
  source_id        uuid not null references menu_ingest.sources (id),
  access_check_id  bigint not null references menu_ingest.access_checks (id),
  url              text not null check (url ~ '^https?://' and length(url) <= 2000),
  fetched_at       timestamptz not null,
  fetched_via      text not null check (fetched_via in ('cloud', 'local_import')),
  http_status      int not null check (http_status between 100 and 599),
  content_type     text check (length(content_type) <= 200),
  sha256           text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes            int not null check (bytes between 0 and 5242880),
  body             bytea not null,
  recorded_at      timestamptz not null default now(),
  unique (url, sha256)
);
create index menu_ingest_snapshots_source on menu_ingest.snapshots (source_id, fetched_at desc);

-- Each reading of a snapshot by a named reader. Re-reading with a newer reader adds a new run.
create table menu_ingest.read_runs (
  id            bigint generated always as identity primary key,
  snapshot_id   bigint not null references menu_ingest.snapshots (id),
  reader        text not null check (reader ~ '^[a-z0-9_]{2,40}@[0-9]+$'),
  read_at       timestamptz not null default now(),
  items         int not null check (items >= 0),
  note          text check (length(note) <= 500),
  unique (snapshot_id, reader)
);

create table menu_ingest.items (
  id               bigint generated always as identity primary key,
  read_run_id      bigint not null references menu_ingest.read_runs (id),
  source_id        uuid not null references menu_ingest.sources (id),
  -- The restaurant's own words, exactly as printed.
  name             text not null check (length(name) between 1 and 300),
  description      text check (length(description) <= 2000),
  section          text check (length(section) <= 200),
  labels           text[] not null default '{}',
  legend           jsonb not null default '{}'::jsonb check (jsonb_typeof(legend) = 'object'),
  ingredients      text check (length(ingredients) <= 4000),
  allergens        text check (length(allergens) <= 1000),
  price_usd        numeric(8, 2) check (price_usd is null or price_usd >= 0),
  serving          text check (length(serving) <= 200),
  serving_grams    numeric check (serving_grams is null or serving_grams > 0),
  -- {"protein_g": {"amount": 21, "unit": "g", "per": "serving"}, ...}; a missing nutrient is absent.
  nutrition        jsonb not null default '{}'::jsonb check (jsonb_typeof(nutrition) = 'object'),
  -- The cleaned name used to match one dish across pages, locations and snapshots.
  match_key        text not null check (match_key ~ '^[a-z0-9 ]+$' and length(match_key) <= 300),
  item_sha256      text not null check (item_sha256 ~ '^[0-9a-f]{64}$'),
  unique (read_run_id, match_key, item_sha256)
);
create index menu_ingest_items_source_key on menu_ingest.items (source_id, match_key);

do $$
declare t text;
begin
  foreach t in array array['snapshots', 'read_runs', 'items'] loop
    execute format('alter table menu_ingest.%I enable row level security', t);
    execute format('alter table menu_ingest.%I force row level security', t);
    execute format('revoke all on menu_ingest.%I from public, anon, authenticated', t);
    execute format('create policy %I on menu_ingest.%I for all to postgres using (true) with check (true)', t || '_owner', t);
    execute format('create trigger %I before update or delete on menu_ingest.%I for each row execute function menu_ingest.guard_append_only()', t || '_append_only', t);
  end loop;
end;
$$;
