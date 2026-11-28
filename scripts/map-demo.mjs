// MAP-1 demo places for viewing the map locally. LOCAL ONLY.
//   node scripts/map-demo.mjs     adds 58 invented places (tests/map/seed-map-demo.sql), all marked is_demo,
//                                 and invented opening hours for them (tests/map/seed-map-demo-hours.sql)
// Remove them with `pnpm exec supabase db reset`.
import { execFileSync } from "node:child_process";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Map demo places are added only to a local database.");
const already = execFileSync("psql", [url, "-Atc", "select count(*) from public.venues where slug like 'map-demo-%'"]).toString().trim();
if (already !== "0") console.log(`Map demo places are already loaded (${already}).`);
else execFileSync("psql", [url, "-q", "-f", "tests/map/seed-map-demo.sql"], { stdio: "inherit" });
// MAP-2: invented opening hours for map demo places that have none yet (adds rows only).
execFileSync("psql", [url, "-q", "-v", "ON_ERROR_STOP=1", "-v", "slug_like=map-demo-%", "-f", "tests/map/seed-map-demo-hours.sql"], { stdio: "inherit" });
console.log("Map demo places and their invented hours are loaded. Remove them with: pnpm exec supabase db reset");
