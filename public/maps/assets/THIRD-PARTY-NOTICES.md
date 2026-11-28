# Map assets: third-party notices (MAP-1.1, decision M11-4)

Everything in this folder is served by this site itself. The browser never fetches map fonts,
icons or tiles from another site. Total size: about 2.6 MB (limit agreed in M11-4: about 3 MB).

| What | Files | Source (pinned) | Licence | Credit needed on screen |
| --- | --- | --- | --- | --- |
| Map label fonts (Noto Sans Regular, Medium, Italic; 8 character ranges each, Latin, Greek, Cyrillic, punctuation) | `fonts/Noto Sans */*.pbf` | github.com/protomaps/basemaps-assets, commit `028c18f713baecad011301ff7a69acc39bcc2ae7` (2025-10-31), folder `fonts/` | SIL Open Font License 1.1, Copyright 2022 The Noto Project Authors. Full text: `fonts/OFL.txt` | No (OFL needs the licence kept with the fonts, which this file and OFL.txt do) |
| Devanagari stack used for names written in that script (3 ranges only) | `fonts/Noto Sans Devanagari Regular v1/*.pbf` | same commit (in the source these files are links to Noto Sans Regular; here they are real copies) | SIL Open Font License 1.1, as above | No |
| Map icons (road shields, town dots) | `sprites/v4/light.json`, `light.png`, `light@2x.json`, `light@2x.png` | same commit, folder `sprites/v4/` | Derived from tangrams/icons (commit `92510779634f`, 2018-11-18), MIT, Copyright (c) 2017 Mapzen. Full text: `sprites/LICENSE-tangrams-icons-MIT.md` | No (MIT needs the notice kept with the files) |

## Code used to draw the map (installed packages, not in this folder)

| Package | Version | Licence | Notes |
| --- | --- | --- | --- |
| `maplibre-gl` | 6.16.0 | BSD-3-Clause | Map drawing (MAP-1) |
| `pmtiles` | 4.5.0 | BSD-3-Clause | Reads the street-map file in pieces; depends on `fflate` 0.8.3 (MIT). No install scripts. |
| `@protomaps/basemaps` | 5.7.2 | BSD-3-Clause (code); the "light" design is CC0 | Builds the street style. No dependencies, no install scripts, no built-in web addresses. |

## Street data (not in this folder and not in Git)

- The Boston street-map file (`local-maps/boston.pmtiles`, outside Git) was cut by the owner on
  15 Nov 2026 from the Protomaps daily build `https://build.protomaps.com/20261115.pmtiles`
  (Protomaps Basemap 4.15.2; OpenStreetMap data as of 2026-11-15 04:00 UTC) with
  `pmtiles extract --bbox=-71.30,42.20,-70.90,42.45 --maxzoom=15`. 37,671,774 bytes, SHA-256
  `1dbc0e6cd2588cb040cc9b6eab897ca781f94148e97169d778f70159f8870887`.
  - OpenStreetMap data: © OpenStreetMap contributors, Open Database License (ODbL 1.0). The map
    shows "Protomaps © OpenStreetMap" linked to https://www.openstreetmap.org/copyright whenever
    street data is drawn. If the file is ever offered publicly it is offered under the ODbL; we
    add nothing of ours into it.
  - Natural Earth (used by Protomaps for low-zoom land and water): public domain, no credit
    required.
- The test file `tests/fixtures/maps/central-square.pmtiles` contains only invented shapes made by
  `scripts/make-test-map.mjs`. It has no third-party data and needs no credit.
