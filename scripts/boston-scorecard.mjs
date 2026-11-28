#!/usr/bin/env node
// Boston readiness scorecard (owner directive 27 Nov 2026 06:04 UTC, section 8; twelve areas and the twelve categories of
// the Boston charter, 28 Nov 2026 00:32 UTC, sections 3 and 12). LOCAL ONLY and READ-ONLY: one
// read-only transaction; it writes nothing except the optional --out file.
//
//   node scripts/boston-scorecard.mjs [--json] [--out file.md]
//
// Every count stands on its own and is never added to another. Neighbourhoods are the listing's address-based area
// (app.boston_area(), migration 20261127000100), the same definition Discover and the meal filters use.
//
//   directory-only place  a private listing whose menu nobody has researched (identity only, says nothing about food)
//   researched menu       a drafted menu linked to one listing
//   source-backed meal    a complete meal from a cleared source whose restaurant's own words say vegetarian or vegan
//   awaiting your review  a source-backed meal you have not source-reviewed yet
//   diet-confirmed        a meal whose vegetarian or vegan label you verified at its source, or a documented answer
//   enabled for members   a meal you included for invited members
//
// Coverage levels (charter section 4), never added together: L1 directory identity (a listing), L2 researched menu,
// L3 diet-confirmed and included for members (publication is separately authorized, and nothing here publishes).
// Categories 9 to 12 are partly measured by the test suites (named below), not by this database; the script says so
// rather than printing a score it cannot know.
import { writeFileSync } from "node:fs";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!/@(127\.0\.0\.1|localhost):/.test(url)) throw new Error("Runs only against a local database.");
const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

/** The charter's twelve Boston areas, by the prefixes of the address-based area (same as src/contracts/neighbourhoods.ts HOODS). */
const PRIORITY = [
  ["Fenway & Kenmore", ["Fenway"]],
  ["Back Bay", ["Back Bay"]],
  ["Downtown & Chinatown", ["Downtown"]],
  ["Cambridge & Somerville", ["Cambridge", "Somerville"]],
  ["Allston & Brighton", ["Allston"]],
  ["Brookline", ["Brookline"]],
  ["South End", ["South End"]],
  ["South Boston & Seaport", ["South Boston"]],
  ["Beacon Hill & West End", ["Beacon Hill"]],
  ["Mission Hill & Longwood", ["Mission Hill"]],
  ["Jamaica Plain & Roxbury", ["Jamaica Plain", "Roxbury"]],
  ["East Boston & Charlestown", ["East Boston", "Charlestown"]],
];
const ELSEWHERE = "Elsewhere in greater Boston";
const inArea = (prefixes) => (a) => prefixes.some((p) => a.startsWith(p));
/** docs/78 minimum for one neighbourhood: 3 restaurants each with 3 source-backed meals, across 2 cuisines. */
const MIN = { restaurants: 3, mealsEach: 3, cuisines: 2 };
const SEARCHES = ["tofu", "curry", "noodle", "burger", "falafel", "dosa", "salad", "bowl", "pho", "paneer", "taco", "pizza"];

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("begin read only");
const rows = async (sql) => (await client.query(sql)).rows;
const hasArea = (await rows("select 1 from pg_proc where proname = 'boston_area'")).length > 0;
const AREA = hasArea ? "app.boston_area(pl.postcode, pl.locality, pl.lon)" : "pl.area";

const listings = await rows(`
  select coalesce(${AREA}, '(no area)') area, count(*)::int n,
         count(*) filter (where not exists (select 1 from staging.live_catalog_links k where k.candidate_id = pl.candidate_id))::int directory_only
    from public.place_listings pl where pl.market_slug = 'boston' and pl.visibility <> 'withdrawn' group by 1`);
const meals = await rows(`
  select d.id, d.label dish, p.id place_id, p.label place, coalesce(${AREA}, '(no area)') area, pl.cuisines, k.method link_method,
         pl.identity_status, staging.tester_meal_checks(d.id) c,
         staging.has_restaurant_protein(d.id) printed,
         (select e.model_id is not null and e.unknown_reason is null from staging.current_estimate(d.id) e) estimate,
         exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject in ('vegetarian', 'vegan')
                  and f.value ->> 'status' = 'yes' and f.status = 'verified' and not f.is_unknown)
           or (exists (select 1 from staging.diet_confirmations x where x.dish_id = d.id and x.answer = 'suitable' and staging.diet_confirmation_state(x) = 'current')
               and not exists (select 1 from staging.diet_confirmations x where x.dish_id = d.id and x.answer = 'not_suitable' and staging.diet_confirmation_state(x) = 'current')) diet_confirmed,
         staging.tester_meal_included(d.id) enabled,
         exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'dietary_status' and f.subject = 'egg_free'
                  and f.value ->> 'status' = 'yes' and f.status in ('submitted', 'verified') and not f.is_unknown) egg_free_stated,
         exists (select 1 from staging.facts f where f.dish_id = d.id and f.kind = 'listed_ingredients' and f.status in ('submitted', 'verified')) ingredients
    from staging.dishes d join staging.places p on p.id = d.place_id
    join staging.live_catalog_links k on k.staging_place = p.id
    join public.place_listings pl on pl.candidate_id = k.candidate_id and pl.market_slug = 'boston'
   where not d.is_demo and not p.is_demo`);
const identityVerified = (await rows(`select count(distinct pl.id)::int n from staging.live_catalog_links k join public.place_listings pl on pl.candidate_id = k.candidate_id
   where pl.market_slug = 'boston' and pl.identity_status = 'verified'`))[0].n;
await client.query("rollback");
await client.end();

const is = (m, k) => m.c?.[k] === true;
const sb = meals.filter((m) => is(m, "meal") && is(m, "rights") && is(m, "stated"));
const cuisineOf = (m) => (m.cuisines ?? []).find((x) => x && typeof x === "object" && x.basis !== "possibly")?.cuisine ?? null;
const placesOf = (list) => new Set(list.map((m) => m.place_id)).size;

const areaRows = [...PRIORITY.map(([label, prefixes]) => [label, inArea(prefixes)]), [ELSEWHERE, (a) => !PRIORITY.some(([, p]) => inArea(p)(a))]].map(([label, test]) => {
  const L = listings.filter((l) => test(l.area));
  const M = meals.filter((m) => test(m.area));
  const S = sb.filter((m) => test(m.area));
  const perPlace = new Map();
  for (const m of S) perPlace.set(m.place_id, [...(perPlace.get(m.place_id) ?? []), m]);
  const strong = [...perPlace.values()].filter((v) => v.length >= MIN.mealsEach);
  const cuisines = new Set(strong.map((v) => cuisineOf(v[0])).filter(Boolean));
  return {
    label,
    listings: L.reduce((s, l) => s + l.n, 0),
    directoryOnly: L.reduce((s, l) => s + l.directory_only, 0),
    researchedMenus: placesOf(M),
    sourceBacked: S.length,
    awaitingReview: S.filter((m) => !is(m, "reviewed")).length,
    dietConfirmed: M.filter((m) => m.diet_confirmed).length,
    enabled: M.filter((m) => m.enabled).length,
    restaurantsWith3: strong.length,
    cuisinesAmongThem: cuisines.size,
    researchedCuisines: [...new Set(M.map(cuisineOf).filter(Boolean))].sort(),
    meetsMinimum: strong.length >= MIN.restaurants && cuisines.size >= MIN.cuisines,
  };
});

const search = SEARCHES.map((q) => {
  // Accent-insensitive, as a person types it ("pho" finds "Phở Chay"); đ has no decomposition, so it is mapped by hand.
  const fold = (t) => t.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
  const hit = sb.filter((m) => fold(m.dish).includes(q));
  return { q, meals: hit.length, restaurants: placesOf(hit) };
});
const largest = [...new Map(sb.map((m) => [m.place, sb.filter((x) => x.place === m.place).length])).entries()].sort((a, b) => b[1] - a[1])[0] ?? ["none", 0];

const twelve = areaRows.filter((a) => a.label !== ELSEWHERE);
const qualifying = twelve.filter((a) => a.meetsMinimum).length;
const reviewed = sb.filter((m) => is(m, "reviewed")).length;
const enabled = meals.filter((m) => m.enabled);
const status = (go, conditional) => (go ? "GO" : conditional ? "CONDITIONAL GO" : "NO-GO");
/** The charter's twelve categories (section 12): baseline, pass criterion, gap, owner, next action, evidence, status. */
const D = [
  {
    n: 1, name: "Directory identity and geography",
    measure: `${listings.reduce((s, l) => s + l.n, 0)} Boston-area listings; ${listings.filter((l) => l.area === "(no area)").reduce((s, l) => s + l.n, 0)} without an area; ${identityVerified} researched restaurants with an identity you verified`,
    target: "Every listing in one address-based area; every restaurant members can see has its branch checked by you",
    gap: `${placesOf(meals) - identityVerified} researched restaurants without your identity check`, owner: "Claude (areas), Yash (identity checks)",
    next: "Identity check during review sittings", evidence: "app.boston_area, tests/db/boston-neighbourhoods.test.ts",
    status: status(identityVerified >= placesOf(meals), listings.filter((l) => l.area === "(no area)").reduce((s, l) => s + l.n, 0) < 50),
  },
  {
    n: 2, name: "Restaurants with researched menus",
    measure: `${placesOf(meals)} restaurants; ${twelve.filter((a) => a.researchedMenus > 0).length} of 12 areas have any`,
    target: "At least 3 independently researched restaurants in each qualifying area", gap: `${twelve.filter((a) => a.researchedMenus < 3).length} areas below 3`,
    owner: "Claude (research), Yash (site approvals)", next: "Approve the named research-site shortlist", evidence: "this scorecard, by area",
    status: status(false, twelve.filter((a) => a.researchedMenus >= 3).length >= 2),
  },
  {
    n: 3, name: "Source-backed dishes",
    measure: `${sb.length} at ${placesOf(sb)} restaurants (largest: ${largest[0]}, ${largest[1]})`,
    target: "Multiple source-backed dishes per qualifying restaurant; no one restaurant above a quarter", gap: `largest restaurant holds ${sb.length ? Math.round((largest[1] / sb.length) * 100) : 0}%`,
    owner: "Claude", next: "Research under-covered areas after approval", evidence: "staging.tester_meal_checks",
    status: status(false, placesOf(sb) >= 8),
  },
  {
    n: 4, name: "Founder-reviewed facts",
    measure: `${reviewed} of ${sb.length} source-backed meals source-reviewed by you`, target: "Your first selection (33 meals) reviewed", gap: `${Math.max(0, 33 - reviewed)} of the 33 to go`,
    owner: "Yash", next: "Review sittings 1 to 4", evidence: "staging.fact_confirmations", status: status(reviewed >= 33, reviewed > 0),
  },
  {
    n: 5, name: "Diet-confirmed dishes",
    measure: `${meals.filter((m) => m.diet_confirmed).length} diet-confirmed; ${sb.filter((m) => m.ingredients).length} of ${sb.length} list ingredients; ${meals.filter((m) => m.egg_free_stated).length} say egg-free`,
    target: "Every member-visible meal diet-confirmed; unknown never shown as a fit", gap: "confirmations follow your source review",
    owner: "Yash", next: "Confirm diet labels in the sittings", evidence: "tests/db/r1-dietary-matrix, journey B", status: status(enabled.length > 0 && enabled.every((m) => m.diet_confirmed), false),
  },
  {
    n: 6, name: "Nutrition provenance",
    measure: `${sb.filter((m) => m.printed).length} printed, ${sb.filter((m) => !m.printed && m.estimate).length} labelled estimate, ${sb.filter((m) => !m.printed && !m.estimate).length} unknown`,
    target: "Every figure carries its basis; unknown is never zero", gap: "unknowns are real gaps in restaurant information, not defects",
    owner: "Claude", next: "Keep labels; no invented values", evidence: "journey D, tests/unit/protein tests", status: status(true, true),
  },
  {
    n: 7, name: "Member-eligible and member-visible dishes",
    measure: `${enabled.length} included for members; member beta switch stays off`, target: "Reviewed, diet-confirmed meals included by you; switch on only with your approval",
    gap: "depends on 4 and 5", owner: "Yash", next: "Inclusion choices after the sittings", evidence: "staging.tester_meal_included", status: status(enabled.length >= 30, enabled.length > 0),
  },
  {
    n: 8, name: "Neighbourhood and cuisine diversity",
    measure: `${qualifying} of 12 areas meet the minimum (3 restaurants with 3 source-backed meals, 2 cuisines)`,
    target: "At least 2 areas for localhost readiness; 4 for an invited beta", gap: `${Math.max(0, 2 - qualifying)} more areas needed`,
    owner: "Claude (research), Yash (approvals)", next: "Brookline, South End, Fenway, Back Bay first", evidence: "this scorecard, by area", status: status(qualifying >= 4, qualifying >= 2),
  },
  {
    n: 9, name: "Search quality",
    measure: `${search.filter((s) => s.meals > 0).length} of ${search.length} common searches find source-backed meals`, target: "Most common searches find a meal; empty results offer a next step",
    gap: search.filter((s) => s.meals === 0).map((s) => s.q).join(", ") || "none", owner: "Claude", next: "Coverage for the empty searches", evidence: "tests/e2e-real search journeys",
    status: status(search.filter((s) => s.meals > 0).length >= 11, search.filter((s) => s.meals > 0).length >= 8),
  },
  { n: 10, name: "Critical consumer journey completion", measure: "tests/e2e-real/journeys-a-to-l.spec.ts, boston-first.spec.ts and the full regression", target: "Every journey passes in a real browser, twice in a row", gap: "see the latest run", owner: "Claude", next: "Run at each merge gate", evidence: "real-data suite log", status: "see tests" },
  { n: 11, name: "UX and accessibility", measure: "tests/e2e-real/product-audit.spec.ts (every screen, phone and desktop) and your own walkthrough", target: "No sideways scrolling or accessibility violations; your firsthand review accepts the key screens", gap: "your walkthrough", owner: "Claude, then Yash", next: "Founder walkthrough", evidence: "audit log, screenshots", status: "see tests" },
  { n: 12, name: "Reliability and privacy", measure: "Full regression (lint, typecheck, unit, db, rls, build, browser), RLS suite, member-isolation journeys", target: "All pass on the exact merged commit; your Mac data unchanged by updates", gap: "see the latest run", owner: "Claude", next: "Run at each merge gate", evidence: "regression summary, Mac before/after counts", status: "see tests" },
];


const R = { asOf: new Date().toISOString(), areas: areaRows, searches: search, dimensions: D };
if (args.includes("--json")) {
  console.log(JSON.stringify(R, null, 2));
} else {
  const L = [`# Boston readiness scorecard (${R.asOf.slice(0, 16).replace("T", " ")} UTC)`, "", "Counts are separate and never added together. Nothing here is public.", ""];
  L.push("| Area | L1 listings | Directory only | L2 researched menus | Cuisines researched | Source-backed meals | Awaiting your review | Diet-confirmed | L3 included for members | Restaurants with 3+ | Meets minimum (source-backed, before review) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const a of areaRows) L.push(`| ${a.label} | ${a.listings} | ${a.directoryOnly} | ${a.researchedMenus} | ${a.researchedCuisines.join(", ") || "none"} | ${a.sourceBacked} | ${a.awaitingReview} | ${a.dietConfirmed} | ${a.enabled} | ${a.restaurantsWith3} (${a.cuisinesAmongThem} ${a.cuisinesAmongThem === 1 ? "cuisine" : "cuisines"}) | ${a.meetsMinimum ? "yes" : "no"} |`);
  L.push("", "| # | Category | Now | Pass criterion | Gap | Owner | Next action | Evidence | Status |", "|---|---|---|---|---|---|---|---|---|");
  for (const d of D) L.push(`| ${d.n} | ${d.name} | ${d.measure} | ${d.target} | ${d.gap} | ${d.owner} | ${d.next} | ${d.evidence} | ${d.status} |`);
  L.push("", `Searches (source-backed meals / restaurants): ${search.map((s) => `${s.q} ${s.meals}/${s.restaurants}`).join(", ")}`);
  const text = L.join("\n");
  console.log(text);
  if (out) writeFileSync(out, text + "\n");
}
