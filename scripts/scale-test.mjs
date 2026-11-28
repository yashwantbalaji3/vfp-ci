// R1 scale test (acceptance test 7). LOCAL ONLY.
//   node scripts/scale-test.mjs seed     load the invented scale data (tests/scale/seed-scale.sql)
//   node scripts/scale-test.mjs measure  time the database calls and pages, write the results
// Afterwards run `pnpm exec supabase db reset` to return to the ordinary demo data.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("The scale test runs only against a local database.");
const APP = process.env.SCALE_APP_URL ?? "http://localhost:3000";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(APP)) throw new Error("The scale test measures only a local app.");
/** Proposed limits (for the owner to agree): slower than this is listed as needing attention. */
const LIMIT_DB_MS = 300;
const LIMIT_PAGE_MS = 1500;
const RUNS = 7;

const mode = process.argv[2];
if (mode === "seed") {
  execFileSync("psql", [url, "-q", "-f", "tests/scale/seed-scale.sql"], { stdio: "inherit" });
  // MAP-2: invented opening hours for the scale places too (every fourth has none), for "Open now".
  execFileSync("psql", [url, "-q", "-v", "ON_ERROR_STOP=1", "-v", "slug_like=%-scale-%", "-f", "tests/map/seed-map-demo-hours.sql"], { stdio: "inherit" });
  console.log("Scale data loaded.");
  process.exit(0);
}
if (mode !== "measure") throw new Error("Use: node scripts/scale-test.mjs seed | measure");

const pool = new pg.Pool({ connectionString: url, max: 2 });
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const counts = await one(
  `select (select count(*)::int from public.venues) as places, (select count(*)::int from public.dishes) as dishes,
          (select count(*)::int from public.profiles_public) as members, (select count(*)::int from public.reviews) as reviews,
          (select count(*)::int from public.follows) as follows,
          (select count(*)::int from public.venues where location is not null) as places_with_coordinates`,
);
const member = (await one("select user_id, handle from public.profiles_public where handle = 'scale_member_1'"));
if (!member) throw new Error("Scale data is not loaded. Run: node scripts/scale-test.mjs seed");
const venue = (await one("select id from public.venues where slug like '%-scale-%' order by id limit 1")).id;
const dish = (await one("select d.food_item_id as id from public.dishes d join public.venues v on v.id = d.venue_id where v.slug like '%-scale-%' order by 1 limit 1")).id;
const list = (await one("select id from public.food_lists where visibility = 'public' and publication_state = 'visible' order by id limit 1"))?.id;

const base = { market: "boston", includeDemo: true, limit: 24, offset: 0 };
const CALLS = [
  ["Discover: first page, no filter", "public.search_catalog($1)", [base]],
  ["Discover: text search 'tofu'", "public.search_catalog($1)", [{ ...base, q: "tofu" }]],
  ["Discover: vegan filter", "public.search_catalog($1)", [{ ...base, diet: "vegan" }]],
  ["Discover: vegan, needs-confirmation view", "public.search_catalog($1)", [{ ...base, diet: "vegan", view: "needs_confirmation" }]],
  ["Discover: vegetarian, egg-free, at least 20 g protein", "public.search_catalog($1)", [{ ...base, diet: "vegetarian", exclusions: ["egg"], minProtein: 20 }]],
  ["Discover: near a point, 2 km (map-style query)", "public.search_catalog($1)", [{ ...base, lat: 42.3655, lon: -71.104, radiusM: 2000 }]],
  ["Discover: near a point, 10 km, vegan", "public.search_catalog($1)", [{ ...base, lat: 42.3655, lon: -71.104, radiusM: 10000, diet: "vegan" }]],
  ["Discover: page 40 (offset 960)", "public.search_catalog($1)", [{ ...base, offset: 960 }]],
  ["Protein Explorer: sorted by protein, vegan", "public.search_catalog($1)", [{ ...base, sort: "protein", diet: "vegan" }]],
  // MAP-1: the map search (places with their dishes), same filters as the list.
  ["Map: whole market, no filter", "public.search_map($1)", [{ market: "boston", includeDemo: true }]],
  ["Map: whole market, vegan", "public.search_map($1)", [{ market: "boston", includeDemo: true, diet: "vegan" }]],
  ["Map: whole market, vegetarian egg-free, needs-confirmation view", "public.search_map($1)", [{ market: "boston", includeDemo: true, diet: "vegetarian", exclusions: ["egg"], view: "needs_confirmation" }]],
  ["Map: 0.5 mile around a point, vegan", "public.search_map($1)", [{ market: "boston", includeDemo: true, diet: "vegan", lat: 42.366, lon: -71.104, radiusM: 805 }]],
  ["Map: 5 miles around a point, vegetarian egg-free", "public.search_map($1)", [{ market: "boston", includeDemo: true, diet: "vegetarian", exclusions: ["egg"], lat: 42.366, lon: -71.104, radiusM: 8047 }]],
  ["Map: map rectangle (search this area), vegan, at least 20 g protein", "public.search_map($1)", [{ market: "boston", includeDemo: true, diet: "vegan", minProtein: 20, bbox: { west: -71.15, south: 42.33, east: -71.05, north: 42.4 } }]],
  ["Discover: Open now (MAP-2)", "public.search_catalog($1)", [{ ...base, openNow: true, at: "2026-11-18T12:30:00-05:00" }]],
  ["Discover: Open now, vegetarian egg-free (MAP-2)", "public.search_catalog($1)", [{ ...base, openNow: true, at: "2026-11-18T12:30:00-05:00", diet: "vegetarian", exclusions: ["egg"] }]],
  ["Discover: places left out by Open now (MAP-2)", "public.open_now_left_out($1)", [{ ...base, openNow: true, at: "2026-11-18T12:30:00-05:00" }]],
  ["Map: whole market, Open now, vegan (MAP-2)", "public.search_map($1)", [{ market: "boston", includeDemo: true, diet: "vegan", openNow: true, at: "2026-11-19T01:30:00-05:00" }]],
  ["Map: 5 miles around a point, Open now (MAP-2)", "public.search_map($1)", [{ market: "boston", includeDemo: true, openNow: true, at: "2026-11-18T12:30:00-05:00", lat: 42.366, lon: -71.104, radiusM: 8047 }]],
  ["Hours status of 24 places (MAP-2)", "public.venue_hours_statuses((select array_agg(id) from (select id from public.venues where slug like '%-scale-%' order by id limit 24) x), true)", []],
  ["Map: area names", "public.map_areas('boston')", []],
  ["Dish page", "public.food_detail($1, true, false)", [dish]],
  ["Place page", "public.venue_detail($1, true)", [venue]],
  ["Reviews of a place (about 250 reviews)", "public.target_reviews('venue', $1, true)", [venue]],
  ["Reviews of a dish", "public.target_reviews('food', $1, true)", [dish]],
  ["Recipe library", "public.recipe_list($1)", [{ includeDemo: true, diet: "vegan" }]],
  ["Following feed (follows 10 people, 400 posts)", "public.social_feed('following', 'matches', 'vegan', '{}', false, null, 20, true)", []],
  ["Recommendations from people followed", "public.social_recommendations('matches', 'vegan', '{}', false, true)", []],
  ["A member's profile", "public.profile_view('scale_member_2', 'matches', 'vegan', '{}', false, true)", []],
  ...(list ? [["A shared list", "public.list_view($1, 'matches', 'vegan', '{}', false, true)", [list]]] : []),
  ["Saved items", "public.my_saves(true, 'vegan', '{}')", []],
  ["People to follow", "public.suggested_people(true)", []],
];

async function timeCall(sql, params) {
  const c = await pool.connect();
  const times = [];
  try {
    for (let i = 0; i < RUNS; i++) {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: member.user_id, role: "authenticated" })]);
      const t = process.hrtime.bigint();
      await c.query(`select ${sql} as r`, params.map((p) => (p && typeof p === "object" && !Array.isArray(p) ? JSON.stringify(p) : p)));
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      await c.query("rollback");
    }
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return { error: e.message };
  } finally {
    c.release();
  }
  times.sort((a, b) => a - b);
  return { medianMs: Math.round(times[Math.floor(times.length / 2)]), slowestMs: Math.round(times[times.length - 1]) };
}
const db = [];
for (const [name, sql, params] of CALLS) db.push({ name, ...(await timeCall(sql, params)) });

const PAGES = [
  ["Discover", "/discover"],
  ["Discover, search 'tofu'", "/discover?q=tofu"],
  ["Discover, page 40", "/discover?offset=960"],
  ["Discover, Open now (MAP-2)", "/discover?open=1"],
  ["Protein Explorer", "/protein"],
  ["Place page (about 250 reviews)", `/venues/${venue}`],
  ["Dish page", `/foods/${dish}`],
  ["Recipes", "/cook"],
  ["Friends and lists (signed out)", "/friends"],
  ["A member's profile (signed out)", "/u/scale_member_2"],
];
const pages = [];
let appUp = await fetch(`${APP}/health`).then((r) => r.ok, () => false);
if (appUp) {
  for (const [name, path] of PAGES) {
    const times = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      // A different invented address each time, so the page limit (300 a minute) is not what is measured.
      const res = await fetch(`${APP}${path}`, { headers: { "x-forwarded-for": `198.51.100.${i + 1}-scale-${Date.now()}` } });
      const body = await res.text(); // the whole streamed page, not just the first byte
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      status = res.status;
      bytes = body.length;
    }
    times.sort((a, b) => a - b);
    pages.push({ name, path: path.replace(/[0-9a-f-]{36}/, "<id>"), status, kilobytes: Math.round(bytes / 1024), medianMs: Math.round(times[2]), slowestMs: Math.round(times[4]) });
  }
}
await pool.end();

const slowDb = [...db].filter((d) => !d.error).sort((a, b) => b.slowestMs - a.slowestMs)[0];
const slowPage = [...pages].sort((a, b) => b.slowestMs - a.slowestMs)[0];
const result = {
  measuredAt: new Date().toISOString(), environment: "local container, local Supabase, production build", runsPerCall: RUNS,
  proposedLimits: { databaseCallMs: LIMIT_DB_MS, pageMs: LIMIT_PAGE_MS }, counts, database: db, pages, appMeasured: appUp,
  slowestDatabaseCall: slowDb, slowestPage: slowPage ?? null,
  overLimit: [...db.filter((d) => d.error || d.slowestMs > LIMIT_DB_MS).map((d) => `database: ${d.name}`), ...pages.filter((p) => p.slowestMs > LIMIT_PAGE_MS || p.status !== 200).map((p) => `page: ${p.name}`)],
};
mkdirSync("test-results", { recursive: true });
writeFileSync("test-results/r1-scale.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
