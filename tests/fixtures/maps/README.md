# Test map

`central-square.pmtiles` (12,476 bytes, SHA-256 `7454f699190de2c33419570ea0692a344ef899cef280c2281a72969f5b8ebc18`)
is a tiny street map made entirely of **invented shapes**: one pond, one park, three roads and one
place name, all labelled "(invented)", around the demo Central Square places, zoom 12 to 15.
It contains **no OpenStreetMap or other third-party data**, so no licence or attribution applies to it.

It exists so the automated checks (including GitHub's) always exercise the real street-map path:
the file route with byte ranges, the `pmtiles` reader and the Protomaps style. The full Boston
street map is a separate, much larger OpenStreetMap file kept out of git (docs/21).

Regenerate (same bytes every time): `node scripts/make-test-map.mjs`.
