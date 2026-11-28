# USDA FoodData Central reference files (NIE V1, slice N-1)

**Source:** U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, https://fdc.nal.usda.gov/.
**Licence (checked 15 Nov 2026 at https://fdc.nal.usda.gov/help):** public domain under CC0 1.0. USDA asks for a citation; we give it on every screen that uses these values and on the About page: "Nutrient data: USDA FoodData Central".

`manifest.json` lists the only files the importer accepts, each pinned by its SHA-256 fingerprint and byte size. The archives themselves are **not** in Git (they are large and anyone can download them for free from the URLs in the manifest).

## Restore in a fresh developer environment ($0)

1. Download each file in `manifest.json` from its `sourceUrl` into `work/usda/downloads/`.
2. Optional check: `node scripts/usda-import.mjs work/usda/downloads/<file>.zip --dry-run` prints the food count and content fingerprint without touching the database.
3. Import into the **local** database: `node scripts/usda-import.mjs work/usda/downloads/<file>.zip`. It refuses any file whose fingerprint differs, and any database that is not on this computer.
4. Running it again prints `"status":"unchanged"`. Releases are sealed and can never be edited or deleted.

## Expected results (recorded 15 Nov 2026)

| File | Foods | Refused values | Content fingerprint |
|---|---|---|---|
| Foundation, JSON, 2026-10-29 | 424 | 10 (negative or unusable values, reported, never stored) | `9f214668183d…` |
| SR Legacy, CSV, 2018-04 | 7,793 | 0 | `a58d823dd250…` |

Reference foods are not visible to visitors or members. Using one for a dish goes through the two-person review (later slices).
