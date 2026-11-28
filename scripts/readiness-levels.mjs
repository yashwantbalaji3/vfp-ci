#!/usr/bin/env node
// Five release levels, each judged separately (owner directive 26 Nov 2026 06:48 UTC, section 6; docs/97).
// READ-ONLY: it changes nothing anywhere, and it prints only names and counts, never a secret.
//
//   node scripts/readiness-levels.mjs [--env-file path]
//
//   1. Local                       this database and checkout work on this computer.
//   2. Hosted foundation beta      release-preflight (launch stage) holds against the hosted env and database.
//   3. Hosted restaurant-meal beta release-preflight --stage meals holds, and enough reviewed meals to be useful.
//   4. Boston public launch        the docs/78 minimum in 2 Boston neighbourhoods with reviewed meals, legal text
//                                  approved, and the owner's public-release approval (never checkable by a script).
//   5. Six-city expansion          the same minimum in 2 neighbourhoods of each other city.
//
// Each level says READY, BLOCKED (with the reasons) or NEEDS OWNER (every automatic check holds; what is left is a
// decision only the owner makes). A level is never READY when the one below it is not.
// Directory volume (how many listings) is shown beside source-backed coverage, never in place of it.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import pg from "pg";

const args = process.argv.slice(2);
const envFile = args.includes("--env-file") ? args[args.indexOf("--env-file") + 1] : null;
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// docs/78: a neighbourhood is usable when 3+ restaurants each have 3+ meals, across 2+ cuisines; a city when 2 are.
const MIN = { restaurants: 3, mealsEach: 3, cuisines: 2, neighbourhoods: 2 };
const MARKETS = ["boston", "new-york", "chicago", "los-angeles", "san-francisco", "dallas"];

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("begin read only");
const q = async (sql, p = []) => (await client.query(sql, p)).rows;

const levels = [];
const level = (n, name, blockers, owner, detail = []) => levels.push({ n, name, blockers, owner, detail });

try {
  // ---------- 1. Local
  const files = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]);
  const applied = new Set((await q("select version from supabase_migrations.schema_migrations")).map((r) => r.version));
  const missing = files.filter((v) => !applied.has(v));
  const pub = (await q("select count(*)::int n from public.place_listings where visibility = 'public'"))[0].n;
  const recipes = (await q("select count(*)::int n from public.food_items where kind = 'recipe' and status = 'published' and not is_demo"))[0].n;
  const l1 = [];
  if (missing.length) l1.push(`${missing.length} migration(s) in the checkout are not applied here`);
  if (pub) l1.push(`${pub} public restaurant listing(s); none should exist before a public launch`);
  if (!recipes) l1.push("no published recipe");
  level(1, "Local", l1, [], [`${files.length} migrations, ${applied.size} applied`, `${recipes} published recipes`, "Run the branch regression for code checks; this script does not run tests"]);

  // ---------- 2 and 3. Hosted betas: the release preflight, run read-only against the env file.
  const preflight = (stage) => {
    if (!envFile) return { ran: false, fails: ["no --env-file given: the hosted environment was not checked"] };
    const r = spawnSync(process.execPath, [new URL("./release-preflight.mjs", import.meta.url).pathname, "--env-file", envFile, ...(stage ? ["--stage", stage] : [])], {
      env: { ...process.env, DATABASE_URL: url }, encoding: "utf8",
    });
    if (r.status === 2) return { ran: false, fails: [`preflight could not run: ${(r.stderr || r.stdout).split("\n")[0]}`] };
    return { ran: true, fails: r.stdout.split("\n").filter((x) => x.startsWith("FAIL")).map((x) => x.replace(/^FAIL\s+/, "")) };
  };
  const host = /^postgres(ql)?:\/\/[^@]*@(db\.[a-z0-9]{20}\.supabase\.co|[^/]*pooler\.supabase\.com)/.test(url);
  const p2 = preflight(null);
  const l2 = [...(l1.length ? ["level 1 is not ready"] : []), ...(host ? [] : ["this is not a hosted database (create the Supabase project first: owner approval)"]), ...p2.fails];
  level(2, "Hosted foundation beta", l2, ["approve creating the hosted Supabase and Vercel projects", "approve the privacy notice and terms", "choose the sign-in email sender", "approve inviting the first testers"]);

  // Meals the founder reviewed and included (every check passes), and meals ready for that review.
  const meals = await q(`
    select pl.market_slug market, coalesce(nullif(pl.area, ''), pl.locality, '?') area, p.id place, p.label,
           coalesce(pl.cuisines -> 0 ->> 'cuisine', '?') cuisine,
           count(*) filter (where staging.tester_meal_included(d.id))::int included,
           count(*) filter (where staging.tester_meal_all_pass(staging.tester_meal_checks(d.id) || '{"reviewed": true}'::jsonb))::int ready
      from staging.dishes d join staging.places p on p.id = d.place_id
      join staging.live_catalog_links l on l.staging_place = p.id
      join public.place_listings pl on pl.candidate_id = l.candidate_id
     group by 1, 2, 3, 4, 5`);
  const usable = (market, key) => {
    const byArea = new Map();
    for (const m of meals.filter((x) => x.market === market && x[key] >= MIN.mealsEach)) {
      if (!byArea.has(m.area)) byArea.set(m.area, []);
      byArea.get(m.area).push(m);
    }
    return [...byArea].filter(([, ps]) => ps.length >= MIN.restaurants && new Set(ps.map((p) => p.cuisine)).size >= MIN.cuisines).map(([a]) => a);
  };
  const included = meals.reduce((s, m) => s + m.included, 0);
  const ready = meals.reduce((s, m) => s + m.ready, 0);
  const p3 = preflight("meals");
  const l3 = [...(l2.length ? ["level 2 is not ready"] : []), ...(included ? [] : [`no meal is reviewed and included yet (${ready} are ready for the founder's review)`]), ...p3.fails];
  level(3, "Hosted restaurant-meal beta", l3, ["review the proposed meals (founder)", "approve transferring the reviews to the hosted copy", "approve turning the member beta on"],
    [`${included} meals reviewed and included; ${ready} ready for review`]);

  // ---------- 4. Boston public launch
  const legal = readFileSync(new URL("../src/content/legal.ts", import.meta.url), "utf8");
  const bos = usable("boston", "included");
  const bosReady = usable("boston", "ready");
  const l4 = [
    ...(l3.length ? ["level 3 is not ready"] : []),
    ...(bos.length >= MIN.neighbourhoods ? [] : [`${bos.length} Boston neighbourhood(s) meet the docs/78 minimum with reviewed meals; ${MIN.neighbourhoods} needed (${bosReady.length} would with every ready meal reviewed: ${bosReady.join(", ") || "none"})`]),
    ...(/LEGAL_TEXT_APPROVED = true;/.test(legal) ? [] : ["the privacy notice and terms are drafts"]),
    "public meals need the dietary and nutrition review dimensions and a publication approval per batch (docs/94); none exists yet",
  ];
  level(4, "Boston public launch", l4, ["approve a public release (a separate decision, even on a free plan)"]);

  // ---------- 5. Six-city expansion, with directory volume beside source-backed coverage.
  const volume = await q(`
    select pl.market_slug market, count(*)::int listings,
           count(*) filter (where x.primary_category in ('vegetarian_restaurant', 'vegan_restaurant'))::int dedicated
      from public.place_listings pl
      left join lateral (select t.primary_category from catalog_import.candidate_links cl
                           join catalog_import.source_records r on r.id = cl.record_id and r.source_key = 'overture_places'
                           join catalog_import.overture_taxonomy t on t.external_id = r.external_id
                          where cl.candidate_id = pl.candidate_id limit 1) x on true
     group by 1`);
  const rows = MARKETS.map((m) => {
    const v = volume.find((x) => x.market === m) ?? { listings: 0, dedicated: 0 };
    const ms = meals.filter((x) => x.market === m);
    return {
      city: m, listings: v.listings, dedicatedByDataset: v.dedicated, researchedMenus: ms.length,
      mealsReady: ms.reduce((s, x) => s + x.ready, 0), mealsReviewed: ms.reduce((s, x) => s + x.included, 0),
      neighbourhoodsAtMinimum: usable(m, "included").length,
    };
  });
  const behind = rows.filter((r) => r.city !== "boston" && r.neighbourhoodsAtMinimum < MIN.neighbourhoods).map((r) => r.city);
  level(5, "Six-city expansion", [...(l4.length ? ["level 4 is not ready"] : []), ...(behind.length ? [`${behind.length} cities have no neighbourhood at the minimum: ${behind.join(", ")}`] : [])],
    ["approve the source hosts for each city's restaurants", "approve each city's public release"]);

  console.log("Coverage by city (directory volume beside source-backed coverage):");
  console.table(rows);
  console.log("  dedicatedByDataset = the map dataset's category says vegetarian or vegan; nobody has checked it, and it never");
  console.log("  counts as a diet claim. mealsReady = every automatic check passes, waiting for the founder's source review.");
  console.log("  mealsReviewed = reviewed by the founder and included for testers.\n");
} finally {
  await client.query("rollback").catch(() => {});
  await client.end();
}

for (const l of levels) {
  const state = l.blockers.length ? "BLOCKED" : l.owner.length ? "NEEDS OWNER" : "READY";
  console.log(`${l.n}. ${l.name}: ${state}`);
  for (const d of l.detail) console.log(`     ${d}`);
  for (const b of l.blockers) console.log(`   - ${b}`);
  if (!l.blockers.length) for (const o of l.owner) console.log(`   owner: ${o}`);
}
console.log("\nRead-only: nothing was changed.");
