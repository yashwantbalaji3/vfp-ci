#!/usr/bin/env bash
# Six-city private directory import (owner decisions 24 Nov 2026 17:45 and 17:59 UTC; docs/84, docs/87).
#
# Extracts the approved Overture release for each market's 25-mile area (public S3, anonymous, no cost), checks each
# file against the checksums recorded in the repository, then loads, matches, assesses and builds the PRIVATE
# directory. Nothing is published: single-source listings are refused 'public' by the database.
#
#   bash scripts/catalog/six-city-import.sh                 # the local database (DATABASE_URL or 127.0.0.1:54322)
#   DATABASE_URL=postgresql://...:54399/postgres bash scripts/catalog/six-city-import.sh   # a throwaway copy first
#
# Needs python3 with pyarrow (python3 -m venv .venv-catalog && .venv-catalog/bin/pip install "pyarrow>=18"; then
# PYTHON=.venv-catalog/bin/python). Safe to run twice: the second run reports every record unchanged and adds nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."
RELEASE=2026-10-21.0
PY="${PYTHON:-python3}"
DIR=work/catalog-sources
mkdir -p "$DIR"
MARKETS=(boston new-york chicago los-angeles san-francisco dallas)
for m in "${MARKETS[@]}"; do
  f="$DIR/overture-$RELEASE-$m.csv"
  if [ ! -f "$f" ]; then "$PY" -I scripts/catalog/overture-extract.py "$RELEASE" "$f" "$m"; fi
done
( cd "$DIR" && if command -v sha256sum >/dev/null; then sha256sum -c "../../scripts/catalog/overture-$RELEASE-six-city.sha256"; else shasum -a 256 -c "../../scripts/catalog/overture-$RELEASE-six-city.sha256"; fi )
for m in "${MARKETS[@]}"; do
  echo "== load $m"
  node scripts/catalog-import.mjs load overture_places "$DIR/overture-$RELEASE-$m.csv" --release "$RELEASE" --area "$m"
done
echo "== match";  node scripts/catalog-import.mjs match
echo "== assess"; node scripts/catalog-preview.mjs assess
echo "== build";  node scripts/catalog-preview.mjs build
echo "== coverage"; node scripts/coverage-metrics.mjs
