-- Audit log for loading data into a hosted beta database and for carrying the founder's review decisions from his
-- own computer to it (owner direction 25 Nov 2026 21:53 UTC). Nothing here loads or decides anything: the scripts
-- scripts/hosted-import.mjs and scripts/review-transfer.mjs write one run row per applied or refused run, and one
-- item row per decision they replayed, in the same transaction as the change itself.
--
-- * Append-only: a row can never be changed or removed.
-- * Idempotent replay: data_transfer_items.source_ref is unique, so the same source decision can be replayed once.
-- * Private: no API role can read or write either table; only a database administrator running the scripts.
--
-- Rollback: drop table app.data_transfer_items; drop table app.data_transfer_runs; drop function
-- app.guard_data_transfer(). No other object depends on them.

create table app.data_transfer_runs (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('hosted_import', 'review_transfer')),
  part text not null check (length(part) between 1 and 40),
  outcome text not null check (outcome in ('applied', 'refused', 'no_change')),
  -- 'local' or the hosted project id the run named.
  target text not null check (length(target) between 1 and 40),
  -- The source database (its Postgres system identifier) for a review transfer; null for an import.
  source_fingerprint text,
  -- SHA-256 of the data package's checksum list, or of the exported decisions file.
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'),
  code_commit text,
  -- The owner's own words approving this run, copied exactly (required by the scripts for anything but a rehearsal).
  approval text not null check (length(btrim(approval)) between 3 and 1000),
  summary jsonb not null default '{}'::jsonb,
  recorded_by text not null check (length(recorded_by) between 1 and 200),
  recorded_at timestamptz not null default now()
);

create table app.data_transfer_items (
  id bigint generated always as identity primary key,
  run_id bigint not null references app.data_transfer_runs (id),
  -- '<source fingerprint>:<kind>:<id on the source>': one source decision is replayed at most once.
  source_ref text not null unique check (length(source_ref) between 10 and 300),
  kind text not null check (kind in ('fact_transcription', 'fact_review', 'meal_note', 'tester_decision', 'identity_decision')),
  -- What the decision was matched on (restaurant, branch, dish, fact, value) and the evidence version it rested on
  -- (source address, saved-page SHA-256, retrieval time), exactly as the source recorded them.
  natural_key jsonb not null,
  evidence jsonb not null,
  source_decided_at timestamptz not null,
  target_id text not null,
  recorded_at timestamptz not null default now()
);
create index data_transfer_items_run on app.data_transfer_items (run_id);

create function app.guard_data_transfer()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'RECORD_IMMUTABLE' using errcode = 'PT409';
end $$;
revoke all on function app.guard_data_transfer() from public, anon, authenticated;
create trigger data_transfer_runs_guard before update or delete on app.data_transfer_runs
  for each row execute function app.guard_data_transfer();
create trigger data_transfer_items_guard before update or delete on app.data_transfer_items
  for each row execute function app.guard_data_transfer();

alter table app.data_transfer_runs enable row level security;
alter table app.data_transfer_runs force row level security;
alter table app.data_transfer_items enable row level security;
alter table app.data_transfer_items force row level security;
revoke all on app.data_transfer_runs, app.data_transfer_items from public, anon, authenticated;
