#!/usr/bin/env node
// Load the invited beta's private data into a hosted Supabase database, one part at a time (owner direction 25 Nov
// 2026 21:53 UTC). Every part runs the same loaders the owner's own computer uses, each of which only adds what is
// missing; nothing here publishes, decides, includes or switches anything on.
//
//   node scripts/hosted-import.mjs plan  --package <data package folder> [--recipes <recipe bundle>] [--scope foundation]
//   node scripts/hosted-import.mjs apply --package <folder> --part <part> --approval "<the owner's own words>" --confirm
//
// Parts, in order (docs/95 section F):
//   reference the USDA FoodData Central releases only (public domain reference foods, never shown on their own): what the
//             recipes' nutrition points at. No restaurant, menu, account or personal data.
//   catalog   the Boston and Cambridge directory: catalog sources, matching, the private preview listings
//   menus     the researched menus, estimates and automatic comparisons (scripts/private-beta-load.mjs), entered by the
//             research account, which holds the curator role only and can never sign in; and the USDA releases
//   recipes   the 50 original recipes, from a recipe bundle (scripts/recipe-bundle.mjs)
//   relink    after the founder's identity decisions are carried over: rebuild the preview listings, link menus again
//   enrol     the eight restaurants of the owner's 25 Nov 17:10 UTC decision (scripts/member-beta.mjs enroll --stage 2)
//
// A hosted target needs VFP_HOSTED_REF naming the project and DATABASE_URL pointing at it (scripts/lib/db-target.mjs).
// Before any part: the package's checksums must match, the target must have exactly this checkout's migrations, and it
// must hold no demo row and no seed account. Each applied part is logged in app.data_transfer_runs with the counts
// before and after. Without --confirm, apply is a dry run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const has = (n) => rest.includes(n);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const target = assertTarget(url, cmd, ["plan", "apply"]);
const CURATOR = "research-curator@local.invalid";
// recipes after reference: the recipes point at the USDA release records the reference part imports. The menus part
// imports the same releases again (each file once: a repeat is "unchanged"), so an older run order still works.
const PARTS = ["reference", "catalog", "menus", "recipes", "relink", "enrol"];
// The foundation beta (owner 26 Nov 2026 17:34 UTC: restaurant meals off): recipes and their reference data only.
const FOUNDATION = ["reference", "recipes"];
// The catalog files of the data package and the release each one is loaded as (as on the owner's computer).
const CATALOG = [
  ["overture_places", "catalog/overture-2026-10-21.0.csv", "2026-10-21.0"],
  ["boston_food_licenses", "catalog/boston-active.csv", "2026-11-16"],
  ["cambridge_food_permits", "catalog/cambridge-food-permits.csv", "2026-11-17"],
];
const TAXONOMY = ["catalog/overture-taxonomy-2026-10-21.0.csv", "2026-10-21.0"];

const sha = (b) => createHash("sha256").update(b).digest("hex");
const node = (...a) => {
  console.log(`\n> node ${a.join(" ")}`);
  execFileSync(process.execPath, a, { stdio: "inherit", env: process.env });
};

/** The package's own checksum list must match every file it names. Returns the list's SHA-256. */
function checkPackage(dir) {
  const list = join(dir, "SHA256SUMS.txt");
  if (!existsSync(list)) throw new Error(`No SHA256SUMS.txt in ${dir}. Nothing checked.`);
  const text = readFileSync(list, "utf8");
  const bad = [];
  for (const line of text.split("\n").filter(Boolean)) {
    const [want, path] = line.split(/\s+/);
    if (!existsSync(join(dir, path)) || sha(readFileSync(join(dir, path))) !== want) bad.push(path);
  }
  if (bad.length) throw new Error(`Package files do not match their checksums: ${bad.join(", ")}. Nothing changed.`);
  return sha(Buffer.from(text));
}

async function counts(c) {
  const one = async (sql) => (await c.query(sql)).rows[0].n;
  return {
    catalogRecords: await one("select count(*)::int n from catalog_import.source_records"),
    previewListings: await one("select count(*)::int n from public.place_listings where visibility = 'preview'"),
    publicListings: await one("select count(*)::int n from public.place_listings where visibility = 'public'"),
    recipes: await one("select count(*)::int n from public.food_items where kind = 'recipe' and not is_demo"),
    usdaReleases: await one("select count(*)::int n from public.source_records sr join public.sources s on s.id = sr.source_id where s.publisher ilike '%Department of Agriculture%' or s.publisher ilike 'USDA%'"),
    accounts: await one("select count(*)::int n from auth.users"),
    diaryEntries: await one("select count(*)::int n from public.diary_entries"),
    menuPlaces: await one("select count(*)::int n from staging.places"),
    menuFacts: await one("select count(*)::int n from staging.facts"),
    linkedRestaurants: await one("select count(*)::int n from staging.live_catalog_links"),
    enrolled: await one("select count(*)::int n from staging.member_beta_places"),
    founderSourceReviews: await one("select count(*)::int n from staging.fact_confirmations"),
    testerDecisions: await one("select count(*)::int n from staging.tester_meal_decisions"),
    memberBetaOn: (await c.query("select coalesce(bool_or(enabled), false) beta_on from staging.member_beta_switch")).rows[0].beta_on,
  };
}

/** Refusals that hold for every part: migrations exactly this checkout's, no demo data, no seed account. */
async function guard(c) {
  const problems = [];
  const files = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]).sort();
  const applied = (await c.query("select version from supabase_migrations.schema_migrations order by 1").catch(() => ({ rows: [] }))).rows.map((r) => r.version);
  if (applied.join(",") !== files.join(",")) problems.push(`the target has ${applied.length} migrations, this checkout ${files.length}; they must be identical`);
  const demo = (await c.query("select count(*)::int n from public.food_items where is_demo")).rows[0].n;
  if (demo) problems.push(`${demo} demo food rows (the seed must never run on a hosted database)`);
  const seedAccounts = (await c.query("select count(*)::int n from auth.users where email like '%@example.invalid' or email like '%@example.com'")).rows[0].n;
  if (seedAccounts) problems.push(`${seedAccounts} seed or example accounts`);
  return problems;
}

function steps(part, dir) {
  const pkg = resolve(dir);
  if (part === "reference") {
    const manifest = JSON.parse(readFileSync(new URL("../reference/usda/manifest.json", import.meta.url), "utf8"));
    const files = manifest.files.map((f) => join(pkg, "usda", f.fileName));
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length) throw new Error(`The reference part needs every USDA file in reference/usda/manifest.json; missing ${missing.join(", ")}. Nothing changed.`);
    return files.map((f) => ["scripts/usda-import.mjs", f]);
  }
  if (part === "catalog")
    return [
      ...CATALOG.map(([key, file, rel]) => ["scripts/catalog-import.mjs", "load", key, join(pkg, file), "--release", rel]),
      ["scripts/catalog-import.mjs", "load-taxonomy", join(pkg, TAXONOMY[0]), "--release", TAXONOMY[1]],
      ["scripts/catalog-import.mjs", "match"],
      ["scripts/catalog-preview.mjs", "assess"],
      ["scripts/catalog-preview.mjs", "build"],
      ["scripts/catalog-preview.mjs", "cuisines"],
    ];
  if (part === "recipes") {
    const bundle = flag("--recipes");
    if (!bundle) throw new Error("The recipes part needs --recipes <bundle file> (scripts/recipe-bundle.mjs export). Nothing changed.");
    return [["scripts/recipe-bundle.mjs", "import", resolve(bundle), "--confirm"]];
  }
  if (part === "menus") return [["scripts/private-beta-load.mjs", "load", join(pkg, "menus"), "--usda", join(pkg, "usda")]];
  if (part === "relink")
    return [["scripts/catalog-preview.mjs", "assess"], ["scripts/catalog-preview.mjs", "build"], ["scripts/menu-link.mjs", "link-matches", "--as", CURATOR, "--confirm"]];
  if (part === "enrol") return [["scripts/member-beta.mjs", "enroll", "--stage", "2", "--by", `hosted-import (${flag("--approval")})`, "--confirm"]];
  throw new Error(`--part is one of ${PARTS.join(", ")}. Nothing changed.`);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const dir = flag("--package");
  if (!["plan", "apply"].includes(cmd) || !dir) throw new Error('Use: plan --package <folder> | apply --package <folder> --part <part> --approval "..." --confirm');
  const pkgSha = checkPackage(dir);
  const where = target.kind === "hosted" ? `hosted project ${target.ref}` : "this local database";
  console.log(`Package checksums match (list SHA-256 ${pkgSha}). Target: ${where}.`);
  const problems = await guard(client);
  const before = await counts(client);
  console.log("Target now:", JSON.stringify(before));
  if (problems.length) {
    for (const p of problems) console.log(`REFUSED  ${p}`);
    console.log("Nothing changed.");
    process.exitCode = 1;
  } else if (cmd === "plan" || !has("--confirm")) {
    const part = flag("--part");
    const scope = flag("--scope");
    if (scope && scope !== "foundation") throw new Error("--scope is foundation (recipes and their reference data only). Nothing changed.");
    if (scope) console.log("\nFoundation scope: no directory, menu, account or personal data; restaurant meals stay off.");
    for (const p of part ? [part] : scope ? FOUNDATION : PARTS) {
      if (p === "recipes" && !flag("--recipes")) { console.log("\nrecipes: needs --recipes <bundle file>"); continue; }
      console.log(`\n${p}:`);
      for (const s of steps(p, dir)) console.log(`  node ${s.join(" ")}`);
    }
    console.log("\nDry run. Nothing changed.");
  } else {
    const part = flag("--part");
    const approval = flag("--approval");
    if (!PARTS.includes(part ?? "")) throw new Error(`--part is one of ${PARTS.join(", ")}. Nothing changed.`);
    if (!approval || approval.trim().length < 3) throw new Error('apply needs --approval "<the owner\'s own words>". Nothing changed.');
    if (before.memberBetaOn) throw new Error("The member beta is on. Turn it off before loading anything. Nothing changed.");
    for (const s of steps(part, dir)) node(...s);
    const after = await counts(client);
    if (after.publicListings !== 0 || after.memberBetaOn) throw new Error("Something became public or the member beta is on: stop and roll back (docs/95 section F).");
    let commit = null;
    try { commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    await client.query(
      `insert into app.data_transfer_runs (kind, part, outcome, target, file_sha256, code_commit, approval, summary, recorded_by)
       values ('hosted_import', $1, $2, $3, $4, $5, $6, $7, 'scripts/hosted-import.mjs')`,
      [part, changed ? "applied" : "no_change", target.kind === "hosted" ? target.ref : "local", pkgSha, commit, approval.trim(), { before, after }]);
    console.log(`\n${part}: done. Before ${JSON.stringify(before)}\nAfter  ${JSON.stringify(after)}\nNothing was published, decided or switched on.`);
  }
} finally {
  await client.end();
}
