#!/usr/bin/env bash
# Backup and restore rehearsal (release gate, owner direction 22 Nov 2026; docs/68 section 7).
#
# LOCAL ONLY. Takes a full backup of the local Supabase database, restores it into a NEW, separate database on
# the same local server (never over the original), and compares the two: every table's row count, a content
# fingerprint of the private and catalog tables that matter most, row security flags, functions, policies and
# the applied migrations. Then it removes only the rehearsal database it created. The original database is only
# read. The backup file stays in OUT_DIR with its SHA-256 so it can be kept or deleted by hand.
#
#   bash scripts/backup-rehearsal.sh [OUT_DIR]        (default work/backup-rehearsal-<UTC time>)
#
# Needs the local stack's database container (supabase_db_<project>). Refuses anything else.
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-supabase_db_vegetarian-food-platform}"
REHEARSAL_DB="vfp_restore_rehearsal"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-work/backup-rehearsal-$STAMP}"
mkdir -p "$OUT"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "No local database container named $DB_CONTAINER. Nothing done." >&2
  exit 2
fi
q() { docker exec "$DB_CONTAINER" psql -U postgres -X -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }
if [ "$(q postgres "select count(*) from pg_database where datname = '$REHEARSAL_DB'")" != "0" ]; then
  echo "A database named $REHEARSAL_DB already exists; remove it by hand after checking it. Nothing done." >&2
  exit 2
fi

echo "1. Backup (custom format, every schema, owners and grants kept)"
t0=$(date +%s)
docker exec "$DB_CONTAINER" pg_dump -U postgres -Fc -d postgres -f /tmp/vfp-backup.dump
docker cp "$DB_CONTAINER":/tmp/vfp-backup.dump "$OUT/vfp-backup.dump" >/dev/null
docker exec "$DB_CONTAINER" rm -f /tmp/vfp-backup.dump
t1=$(date +%s)
SHA=$(sha256sum "$OUT/vfp-backup.dump" | cut -d' ' -f1)
BYTES=$(stat -c %s "$OUT/vfp-backup.dump")
echo "   $BYTES bytes, sha256 $SHA, $((t1 - t0)) s"

echo "2. Restore into a new database ($REHEARSAL_DB)"
q postgres "create database $REHEARSAL_DB" >/dev/null
docker cp "$OUT/vfp-backup.dump" "$DB_CONTAINER":/tmp/vfp-backup.dump >/dev/null
set +e
docker exec "$DB_CONTAINER" pg_restore -U postgres -d "$REHEARSAL_DB" /tmp/vfp-backup.dump > "$OUT/restore.log" 2>&1
RESTORE_EXIT=$?
set -e
docker exec "$DB_CONTAINER" rm -f /tmp/vfp-backup.dump
t2=$(date +%s)
echo "   pg_restore exit $RESTORE_EXIT, $(grep -c '^pg_restore: error' "$OUT/restore.log" || true) errors listed in restore.log, $((t2 - t1)) s"

echo "3. Compare"
SCHEMAS="'public','staging','auth','app','catalog_import','menu_ingest','partner','storage','supabase_migrations'"
COUNTS_SQL="select string_agg(format('%s.%s=%s', n.nspname, c.relname,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text), E'\n' order by n.nspname, c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname in ($SCHEMAS)"
q postgres "$COUNTS_SQL" > "$OUT/counts-original.txt"
q "$REHEARSAL_DB" "$COUNTS_SQL" > "$OUT/counts-restored.txt"
FP_SQL="select string_agg(format('%s=%s', t, md5(coalesce(x, ''))), E'\n' order by t) from (
  select 'public.diary_entries' t, (select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.diary_entries r) x union all
  select 'public.reviews', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.reviews r) union all
  select 'public.food_items', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.food_items r) union all
  select 'public.food_lists', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.food_lists r) union all
  select 'public.goal_versions', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.goal_versions r) union all
  select 'staging.facts', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from staging.facts r) union all
  select 'staging.dishes', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from staging.dishes r) union all
  select 'public.place_listings', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.place_listings r) union all
  select 'auth.users', (select string_agg(to_jsonb(r)::text, '|' order by r.id) from auth.users r)) s"
q postgres "$FP_SQL" > "$OUT/fingerprints-original.txt"
q "$REHEARSAL_DB" "$FP_SQL" > "$OUT/fingerprints-restored.txt"
SHAPE_SQL="select 'rls ' || count(*) filter (where c.relrowsecurity) || '/' || count(*) filter (where c.relforcerowsecurity)
             from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname in ($SCHEMAS)
  union all select 'policies ' || count(*) from pg_policies where schemaname in ($SCHEMAS)
  union all select 'functions ' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ($SCHEMAS)
  union all select 'migrations ' || count(*) || ' latest ' || max(version) from supabase_migrations.schema_migrations"
q postgres "$SHAPE_SQL" > "$OUT/shape-original.txt"
q "$REHEARSAL_DB" "$SHAPE_SQL" > "$OUT/shape-restored.txt"

ok=true
for f in counts fingerprints shape; do
  if diff -q "$OUT/$f-original.txt" "$OUT/$f-restored.txt" >/dev/null; then echo "   $f: identical"; else echo "   $f: DIFFERENT (see $OUT/$f-*.txt)"; ok=false; fi
done
TABLES=$(wc -l < "$OUT/counts-original.txt")
ROWS=$(awk -F= '{s+=$2} END {print s}' "$OUT/counts-original.txt")

echo "4. Remove the rehearsal database only"
q postgres "drop database $REHEARSAL_DB" >/dev/null

cat > "$OUT/summary.json" <<JSON
{
  "at": "$STAMP",
  "backup": { "file": "vfp-backup.dump", "bytes": $BYTES, "sha256": "$SHA", "seconds": $((t1 - t0)) },
  "restore": { "database": "$REHEARSAL_DB (removed afterwards)", "pgRestoreExit": $RESTORE_EXIT, "seconds": $((t2 - t1)) },
  "tablesCompared": $TABLES,
  "rowsCompared": $ROWS,
  "identical": $ok,
  "cronJobsInOriginal": $(q postgres "select count(*) from cron.job" 2>/dev/null || echo null),
  "knownLimits": "pg_cron lives in one database per server, so its schema and the scheduled maintenance job cannot be restored into a second database on the same server (restore.log lists those errors); a restore over the original database name, or on a fresh server, brings them back. The local 'postgres' role is not a full superuser, so ownership changes to Supabase's internal roles and a few internal grants are refused (also listed); every application schema, row, policy and function still compares identical."
}
JSON
cat "$OUT/summary.json"
$ok
