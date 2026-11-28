#!/bin/bash
# LOCAL ONLY. Builds the hosted foundation beta's database on this computer, exactly as docs/98 describes for the hosted
# project: every migration, NO seed, then only the foundation parts of scripts/hosted-import.mjs (USDA reference data and
# the 50 original recipes). No directory, menu, account or personal data. Invite-only on, every switch off.
# It RESETS the local database: never run it on the owner's Mac (it refuses unless VFP_SANDBOX=1).
#
#   VFP_SANDBOX=1 bash scripts/ci/foundation-db.sh <data package folder> <recipe bundle>
set -euo pipefail
[ "${VFP_SANDBOX:-}" = "1" ] || { echo "Refused: this resets the local database. Set VFP_SANDBOX=1 only in a disposable sandbox."; exit 2; }
PKG=${1:?data package folder}; RECIPES=${2:?recipe bundle}
pnpm exec supabase db reset --no-seed
APPROVAL="LOCAL FOUNDATION REHEARSAL, not an owner approval"
node scripts/hosted-import.mjs apply --package "$PKG" --part reference --approval "$APPROVAL" --confirm | tail -1
node scripts/hosted-import.mjs apply --package "$PKG" --part recipes --recipes "$RECIPES" --approval "$APPROVAL" --confirm | tail -1
node scripts/local-doctor.mjs --register-local-key > /dev/null || true
node scripts/invites.mjs on --by "foundation rehearsal" --confirm
psql "${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}" -XAtc "
  select 'switches on', count(*) filter (where enabled) from app.platform_switches;
  select 'staging places', count(*) from staging.places; select 'listings', count(*) from public.place_listings;
  select 'recipes', count(*) from public.food_items where kind = 'recipe' and status = 'published';
  select 'accounts', count(*) from auth.users; select 'demo foods', count(*) from public.food_items where is_demo;"
