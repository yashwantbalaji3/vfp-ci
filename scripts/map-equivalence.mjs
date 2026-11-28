// MAP-1 map/list equivalence on whatever data is loaded (used on the 2,000-dish scale data). LOCAL ONLY.
//   node scripts/map-equivalence.mjs [output.json]
// For every dietary filter x area x view: the dishes on the map must be exactly the dishes in the
// list (or, when the map stops at its place limit, a subset with the same totals), and no
// "matches" pin may stand for an unknown or excluded dish.
// MAP-2: every case also runs with "Open now" at fixed moments (a weekday lunchtime, a late night
// and a Sunday morning, Boston time). Then every place on the map must also be open by
// app.venue_hours_status at that moment, and the list and map must still agree.
import { writeFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
const pool = new pg.Pool({ connectionString: url, max: 1 });
const c = await pool.connect();
await c.query("begin");
await c.query("set local role anon");

const DIETS = [{}, { diet: "vegan" }, { diet: "vegetarian" }, { diet: "vegetarian", exclusions: ["egg"] }, { diet: "vegetarian", exclusions: ["dairy"] }, { diet: "vegan", exclusions: ["egg", "dairy", "honey"] }, { diet: "vegan", includeConditional: true }];
const AREAS = [
  { name: "whole market" },
  { name: "0.5 mile circle", lat: 42.366, lon: -71.104, radiusM: 805 },
  { name: "3 mile circle", lat: 42.366, lon: -71.104, radiusM: 4828 },
  { name: "small rectangle", bbox: { west: -71.13, south: 42.36, east: -71.1, north: 42.38 } },
  { name: "large rectangle", bbox: { west: -71.2, south: 42.3, east: -71.0, north: 42.45 } },
];
const MOMENTS = [null, "2026-11-18T12:30:00-05:00", "2026-11-19T01:30:00-05:00", "2026-11-22T09:00:00-05:00"];
const one = async (sql, p) => (await c.query(sql, [JSON.stringify(p)])).rows[0].r;
const results = [];
let failures = 0;
for (const diet of DIETS) {
  for (const { name, ...area } of AREAS) {
    for (const view of ["matches", "needs_confirmation"]) {
     for (const at of MOMENTS) {
      const p = { market: "boston", includeDemo: true, ...diet, ...area, view, ...(at ? { openNow: true, at } : {}) };
      const ids = [];
      let offset = 0;
      let counts;
      for (;;) {
        const r = await one("select public.search_catalog($1) as r", { ...p, kinds: ["dish"], limit: 50, offset });
        counts = r.counts;
        ids.push(...r.items.map((i) => i.foodItemId));
        if (r.nextOffset === null) break;
        offset = r.nextOffset;
      }
      const map = await one("select public.search_map($1) as r", { ...p, limitPlaces: 200 });
      const mapIds = map.places.flatMap((pl) => pl.dishes.map((d) => d.foodItemId));
      const listSet = new Set(ids);
      const same = map.truncated ? mapIds.every((id) => listSet.has(id)) : mapIds.length === ids.length && mapIds.every((id) => listSet.has(id));
      const countsSame = map.counts.dishesMatches === counts.matches && map.counts.dishesNeedsConfirmation === counts.needsConfirmation && map.counts.hidden === counts.hidden;
      const allowed = diet.includeConditional ? ["eligible", "conditional"] : ["eligible"];
      const badPins = view === "matches" && diet.diet ? map.places.flatMap((pl) => pl.dishes).filter((d) => !allowed.includes(d.eligibility.status)).length : 0;
      let closedPins = 0;
      if (at && map.places.length) {
        const venueIds = map.places.map((pl) => pl.id);
        // The status rule is not open to visitors directly, so it is read as the database owner.
        await c.query("reset role");
        const st = await c.query("select count(*)::int n from unnest($1::uuid[]) v where app.venue_hours_status(v, $2::timestamptz) ->> 'state' <> 'open'", [venueIds, at]);
        await c.query("set local role anon");
        closedPins = st.rows[0].n;
      }
      const ok = same && countsSame && badPins === 0 && closedPins === 0;
      if (!ok) failures++;
      results.push({ diet: JSON.stringify(diet), area: name, view, openNowAt: at, listDishes: ids.length, mapDishes: mapIds.length, mapPlaces: map.places.length, truncated: map.truncated, closedPins, ok });
     }
    }
  }
}
await c.query("rollback");
c.release();
await pool.end();
const summary = { measuredAt: new Date().toISOString(), cases: results.length, failures, truncatedCases: results.filter((r) => r.truncated).length, results };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ cases: summary.cases, failures, truncatedCases: summary.truncatedCases }));
if (failures) process.exit(1);
