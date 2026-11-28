// Pilot staging leak check (A-STAGING-1): with real research records loaded into LOCAL staging, ask
// every public surface for them and fail if any label, URL or figure appears. LOCAL ONLY.
//
//   node scripts/staging-leak-check.mjs [http://localhost:3000] > result.json
//
// Checks: public pages (Discover, Map view, Protein, Cook, Friends), the public JSON APIs (catalog
// search, map search, nearby), and the Data API (PostgREST) asking for the staging schema directly
// as a guest. Needles are taken from the staging tables themselves, so new records are covered.
import { readFileSync } from "node:fs";
import pg from "pg";

const base = process.argv[2] ?? "http://localhost:3000";
const dbUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(dbUrl) || !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(base)) throw new Error("Runs only against a local stack.");
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const places = (await db.query("select label from staging.places")).rows.map((r) => r.label);
const dishes = (await db.query("select label from staging.dishes")).rows.map((r) => r.label);
const urls = (await db.query("select url from staging.source_pages")).rows.map((r) => r.url);
await db.end();
if (!places.length) throw new Error("No staged records loaded: load the research entries first.");
// Short distinctive words of each label (e.g. "Life Alive", "sweetgreen") plus every full label and URL.
const needles = [...new Set([...places, ...places.map((p) => p.replace(/\s*\(.*\)$/, "")), ...dishes, ...urls])].filter((n) => n.length >= 6);

const hits = [];
let requests = 0;
const scan = (where, text) => {
  requests += 1;
  for (const n of needles) if (text.toLowerCase().includes(n.toLowerCase())) hits.push({ where, needle: n });
};
const get = async (path) => {
  const r = await fetch(base + path);
  scan(`GET ${path} (${r.status})`, await r.text());
};
const post = async (path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  scan(`POST ${path} (${r.status})`, await r.text());
};

// Search words are PARTS of the staged labels, never a whole label, because pages echo the search
// text back into the search box: a staged label can then only appear if a staged record leaked.
const terms = ["", "alive", "sweet", "galax", "grill", "veggie", "lentil", "dal", "falafel", "shawarma", "shroom", "hummus", "goddess", "teriyaki", "buddha", "tofu"];
for (const t of terms) if (t && needles.some((n) => n.toLowerCase() === t)) throw new Error(`Search word "${t}" equals a staged label`);
for (const p of ["/discover", "/discover?view=map", "/protein", "/cook", "/friends", "/"]) await get(p);
for (const q of terms) {
  await get(`/discover?q=${encodeURIComponent(q)}`);
  await get(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&includeDemo=true`);
  await get(`/api/v1/catalog/search?q=${encodeURIComponent(q)}&includeDemo=true&diet=vegan`);
  await post("/api/v1/map/search", { q, includeDemo: true });
}
await post("/api/v1/catalog/nearby", { lat: 42.3655, lng: -71.1040, radiusKm: 3, includeDemo: true }); // Central Square
await post("/api/v1/catalog/nearby", { lat: 42.3736, lng: -71.1190, radiusKm: 3, includeDemo: true }); // Harvard Square

// The Data API itself, as a guest, asking for the staging schema by name.
const rest = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const dataApi = [];
if (rest && anon) {
  for (const t of ["places", "dishes", "facts", "source_pages", "events"]) {
    const r = await fetch(`${rest}/rest/v1/${t}?select=*`, { headers: { apikey: anon, authorization: `Bearer ${anon}`, "accept-profile": "staging" } });
    const text = await r.text();
    scan(`DATA API staging.${t} (${r.status})`, text);
    dataApi.push({ table: t, status: r.status, refused: r.status >= 400 });
  }
  const rpc = await fetch(`${rest}/rest/v1/rpc/pilot_overview`, { method: "POST", headers: { apikey: anon, authorization: `Bearer ${anon}`, "content-profile": "staging", "content-type": "application/json" }, body: "{}" });
  scan(`DATA API rpc staging.pilot_overview (${rpc.status})`, await rpc.text());
  dataApi.push({ rpc: "pilot_overview", status: rpc.status, refused: rpc.status >= 400 });
}

const result = { stagedPlaces: places.length, stagedDishes: dishes.length, needles: needles.length, requests, dataApi, hits };
console.log(JSON.stringify(result, null, 2));
if (hits.length || dataApi.some((d) => !d.refused) || !dataApi.length) process.exitCode = 1;
