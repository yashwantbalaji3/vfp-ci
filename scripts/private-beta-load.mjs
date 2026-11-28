// Load the founder-only private beta's real drafted menus into a database (docs/59): the owner's own computer, or
// a hosted beta database only when VFP_HOSTED_REF names that project (scripts/lib/db-target.mjs; run it through
// scripts/hosted-import.mjs, which plans first and needs --confirm). It never resets, deletes or publishes anything, never confirms or
// verifies a fact, and never reads the web: everything comes from files the owner already has.
//
//   node scripts/private-beta-load.mjs load <bundle folder> [--usda <folder with the USDA .zip files>] [--dry-run]
//   node scripts/private-beta-load.mjs verify <bundle folder>    read-only: lists what the bundle holds that this database lacks
//   node scripts/private-beta-load.mjs export-checks <bundle folder>/machine-checks.json    (research sandbox)
//
// The bundle folder holds drafts-v2.json, drafts-batch2.json, estimates.json, machine-checks.json and the optional later
// batches: drafts-batch3.json + estimates-batch3.json (Cafe Landwer Cleveland Circle, 20 Nov) and drafts-batch4.json +
// estimates-batch4.json (Cafe Landwer Back Bay, owner decision 21 Nov 2026 19:07 UTC), and drafts-batch6.json (Dirty
// Water Dough, Union Park Pizza, Typhoon, Mama's Place) + drafts-batch6b.json (Amelia's Taqueria, Boylston), owner
// decision 22 Nov 2026 06:25 UTC (APPROVALS A-1122-B6), and drafts-batch7.json (Crystal Spoons, Servia), owner
// decision 22 Nov 2026 15:26 UTC (APPROVALS A-1122-CK), and drafts-batch8.json (Pho Pasteur, Gene's Chinese Flatbread Cafe),
// owner decision 23 Nov 2026 02:04 UTC (APPROVALS A-1123-0204), and drafts-batch10.json (Vegan 4 The Soul), owner
// decision 24 Nov 2026 21:20 UTC (decision 1, the 10 dedicated vegetarian and vegan sites), and drafts-batch12.json
// (Madras Dosa Co Seaport, Dirty Water Dough East Boston), owner decision 28 Nov 2026 04:49 UTC (Group A)
// (the automatic comparison results, recorded again here with the fingerprint of the page they were
// made from, so they stay labelled automatic). The drafts are entered by a local research account,
// research-curator@local.invalid, so the founder can never confirm their own entries.
// Run it again safely: if the first researched places are already there, it only adds a later batch whose place is
// not there yet, and changes nothing else.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const CURATOR = "research-curator@local.invalid";
const [cmd, folder, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
const TARGET = assertTarget(url, cmd, ["load", "verify"]);
const node = (...args) => {
  console.log(`\n> node ${args.join(" ")}`);
  execFileSync(process.execPath, args, { stdio: "inherit", env: process.env });
};
/** The key a machine check travels under: the same fact on two databases has different ids. */
const factKey = (r) => JSON.stringify([r.place, r.dish, r.kind, r.subject ?? null, r.value ?? null]);

async function exportChecks(client, out) {
  // Only the places the bundle's drafts hold: never a place a test created in the research database.
  const dir = resolve(out, "..");
  const labels = ["drafts-v2.json", "drafts-batch2.json", ...LATER_BATCHES.map((b) => `drafts-${b}.json`)]
    .filter((f) => existsSync(join(dir, f)))
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).places.map((p) => p.label));
  if (!labels.length) throw new Error(`No drafts next to ${out}: export the checks into the bundle folder.`);
  const rows = (await client.query(`
    select p.label place, d.label dish, f.kind, f.subject, f.value, m.result, m.detail, m.page_sha256 sha, m.page_saved_at saved
      from staging.facts f join staging.places p on p.id = f.place_id join staging.dishes d on d.id = f.dish_id
      join lateral (select * from staging.current_machine_check(f.id)) m on true
     where m.id is not null and p.label = any($1::text[])
     order by 1, 2, 3, 4`, [labels])).rows;
  writeFileSync(out, JSON.stringify({ exportedAt: new Date().toISOString(), checks: rows.map((r) => ({ key: factKey(r), result: r.result, detail: r.detail, pageSha256: r.sha, pageSavedAt: r.saved })) }, null, 1));
  console.log(`Wrote ${rows.length} automatic checks to ${out}.`);
}

const LATER_BATCHES = ["batch3", "batch4", "batch6", "batch6b", "batch7", "batch8", "batch10", "batch12"];

/**
 * Enters each later batch (drafts-<b>.json, estimates-<b>.json) whose places are not in this database yet, then
 * links by address. A place already there is left as it is. Returns how many batches were added.
 */
async function laterBatches(client, dir, dryRun, { link = true } = {}) {
  let added = 0;
  let registry = false;
  for (const b of LATER_BATCHES) {
    const drafts = join(dir, `drafts-${b}.json`);
    if (!existsSync(drafts)) continue;
    const labels = JSON.parse(readFileSync(drafts, "utf8")).places.map((p) => p.label);
    const have = (await client.query("select count(*)::int n from staging.places where label = any($1::text[])", [labels])).rows[0].n;
    if (have > 0) continue;
    if (dryRun) { console.log(`Dry run: would add ${labels.join(", ")}.`); continue; }
    // The access registry in this code names the later sources (batch 6 onwards); load it once before entering.
    if (!registry) { node("scripts/research-sources.mjs", "db-load"); registry = true; }
    node("scripts/staging-entry.mjs", "enter", drafts, "--as", CURATOR);
    const est = join(dir, `estimates-${b}.json`);
    if (existsSync(est)) node("scripts/menu-estimates.mjs", est, "--as", CURATOR);
    added += 1;
  }
  // Ties each new place to the catalog place at its address. Its menu shows only once that catalog place is in
  // the preview: Cafe Landwer Back Bay needs the founder's identity decision first (docs/67).
  if (added && link) {
    node("scripts/menu-link.mjs", "link-websites", "--as", CURATOR, "--confirm");
    node("scripts/menu-link.mjs", "link-matches", "--as", CURATOR, "--confirm");
  }
  return added;
}

/**
 * Address facts the drafts left out, each taken from the restaurant's own page, added once (a place that already
 * has an address fact is left alone). Gene's Chinese Flatbread Cafe: its own home page embeds a map pinned to
 * "86 Bedford St, Boston, MA 02111" and prints no other address (saved copy retrieved 23 Nov 2026 02:37 UTC; owner
 * 23 Nov 17:49 UTC asked to resolve
 * its catalog identity). The ordinary exact-address check then links it; no name matching. Returns how many it added.
 */
const ADDRESS_FIXES = [{ label: "Gene's Chinese Flatbread Cafe", url: "https://genescafeboston.com/", street: "86 Bedford St", postcode: "02111" }];
async function addressFixes(client, dryRun) {
  let n = 0;
  for (const a of ADDRESS_FIXES) {
    const missing = (await client.query(
      `select count(*)::int n from staging.places p join staging.source_pages s on s.url = $2
        where p.label = $1 and not exists (select 1 from staging.facts f where f.place_id = p.id and f.kind = 'address')`,
      [a.label, a.url])).rows[0].n;
    if (!missing) continue;
    if (dryRun) { console.log(`Dry run: would add the address ${a.street} ${a.postcode} for ${a.label}, from its own page.`); n += 1; continue; }
    await client.query(
      `select staging.submit_fact(u.id, jsonb_build_object('placeId', p.id, 'sourcePageId', s.id, 'kind', 'address',
          'value', jsonb_build_object('street', $3::text, 'postcode', $4::text), 'checkedOn', s.retrieved_at::date::text, 'confidence', 'medium'))
         from auth.users u, staging.places p, staging.source_pages s
        where u.email = $5 and p.label = $1 and s.url = $2
          and not exists (select 1 from staging.facts f where f.place_id = p.id and f.kind = 'address')`,
      [a.label, a.url, a.street, a.postcode, CURATOR]);
    n += 1;
  }
  return n;
}

/**
 * Record the bundle's automatic comparison results on this database's facts. With `onlyMissing`, only facts that
 * have no automatic result yet get one (a later package's new results), so an earlier result is never replaced.
 */
async function recordChecks(client, dir, dryRun, onlyMissing) {
  const file = join(dir, "machine-checks.json");
  if (!existsSync(file)) return 0;
  const checks = new Map(JSON.parse(readFileSync(file, "utf8")).checks.map((c) => [c.key, c]));
  const actor = (await client.query("select id from auth.users where email = $1", [CURATOR])).rows[0]?.id;
  if (!actor) return 0;
  const facts = (await client.query(`
    select f.id, p.label place, d.label dish, f.kind, f.subject, f.value
      from staging.facts f join staging.places p on p.id = f.place_id join staging.dishes d on d.id = f.dish_id
     where f.status = 'submitted'
       and (not $1 or not exists (select 1 from staging.fact_machine_checks m where m.fact_id = f.id))`, [onlyMissing])).rows;
  const todo = facts.filter((f) => checks.has(factKey(f)));
  if (dryRun) {
    if (todo.length) console.log(`Dry run: would record ${todo.length} new automatic checks (labelled automatic; none is a check by you).`);
    return todo.length;
  }
  await client.query("begin");
  for (const f of todo) {
    const c = checks.get(factKey(f));
    await client.query("select staging.record_machine_check($1, $2, $3, $4, $5, $6)", [actor, f.id, c.result, c.detail, c.pageSha256, c.pageSavedAt]);
  }
  await client.query("commit");
  if (todo.length) console.log(`\nRecorded ${todo.length} automatic checks (labelled automatic; none is a check by you).`);
  return todo.length;
}

/**
 * Recovery after an interrupted first load (a lost connection, for one): each draft file goes in as one transaction,
 * so a file is either fully there or not at all. A first-load file whose places are all missing is entered now, and the
 * steps after it (the estimates, NAYA's address, the website links) run on every repeat load; each adds only what is missing. A file with some of
 * its places there is never entered again (that would mean a partial file, which the one-transaction entry rules out).
 * Returns how many files it entered.
 */
async function baseRepair(client, dir, dryRun) {
  let entered = 0;
  for (const f of ["drafts-v2.json", "drafts-batch2.json"]) {
    const file = join(dir, f);
    if (!existsSync(file)) continue;
    const labels = JSON.parse(readFileSync(file, "utf8")).places.map((p) => p.label);
    const have = (await client.query("select count(*)::int n from staging.places where label = any($1::text[])", [labels])).rows[0].n;
    if (have > 0) continue;
    if (dryRun) { console.log(`Dry run: the first load stopped before ${f}; would enter it now.`); entered += 1; continue; }
    node("scripts/staging-entry.mjs", "enter", file, "--as", CURATOR);
    entered += 1;
  }
  // The steps after the first files run on every repeat load, not only after entering a file here: the first load can
  // stop after its last draft file and before these (each one adds only what is missing, so a repeat changes nothing).
  const base = (await client.query("select count(*)::int n from staging.places where label = 'NAYA'")).rows[0].n > 0;
  if (base && !dryRun) {
    if (existsSync(join(dir, "estimates.json"))) node("scripts/menu-estimates.mjs", join(dir, "estimates.json"), "--as", CURATOR);
    await nayaAddress(client);
    node("scripts/menu-link.mjs", "link-websites", "--as", CURATOR, "--confirm");
    node("scripts/menu-link.mjs", "link-matches", "--as", CURATOR, "--confirm");
  }
  return entered;
}

async function nayaAddress(client) {
  await client.query(
    `select staging.submit_fact(u.id, jsonb_build_object('placeId', p.id, 'sourcePageId', s.id, 'kind', 'address',
        'value', jsonb_build_object('street', '500 Boylston St', 'postcode', '02116'), 'checkedOn', s.retrieved_at::date::text, 'confidence', 'medium'))
       from auth.users u, staging.places p, staging.source_pages s
      where u.email = $1 and p.label = 'NAYA' and s.url = 'https://www.eatnaya.com/the-menu/'
        and not exists (select 1 from staging.facts f where f.place_id = p.id and f.kind = 'address')`,
    [CURATOR],
  );
}

async function load(client, dir, dryRun) {
  const staged = (await client.query("select count(*)::int n from staging.facts f join staging.places p on p.id = f.place_id where p.label in ('NAYA', 'Next Level Veggie Grill', 'Thai Basil')")).rows[0].n;
  if (staged > 0) {
    const repaired = await baseRepair(client, dir, dryRun);
    const added = (await laterBatches(client, dir, dryRun)) + repaired;
    const fixed = await addressFixes(client, dryRun);
    if (fixed && !dryRun) node("scripts/menu-link.mjs", "link-matches", "--as", CURATOR, "--confirm");
    const checked = await recordChecks(client, dir, dryRun, true);
    if (dryRun) console.log("Dry run: nothing changed.");
    else if (added || fixed || checked) console.log(`\n${added ? `Added ${added} later batch${added === 1 ? "" : "es"}. ` : ""}${fixed ? `Added ${fixed} address fact${fixed === 1 ? "" : "s"} from the restaurant's own page. ` : ""}${checked ? `Recorded ${checked} new automatic checks. ` : ""}Nothing was confirmed, verified or published.`);
    else console.log("The researched menus are already loaded here. Nothing changed.");
    return;
  }
  for (const f of ["drafts-v2.json", "drafts-batch2.json", "estimates.json"]) if (!existsSync(join(dir, f))) throw new Error(`Missing ${f} in ${dir}: the first menus are not loaded here yet, and they need the full bundle`);
  if (dryRun) {
    console.log("Dry run: the drafts are not loaded yet. Run again without --dry-run to load them.");
    return;
  }
  // 1. The research account that enters drafts (never the founder).
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, banned_until)
     select gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1::text, '{}', '{}', now(), now(),
            case when $2::boolean then 'infinity'::timestamptz end
      where not exists (select 1 from auth.users where email = $1::text)`,
    // On a hosted database the research account can never sign in: no password, no sign-in identity, and banned.
    // It keeps exactly the curator role it has locally (enter drafts, never confirm them); nothing more.
    [CURATOR, TARGET.kind === "hosted"],
  );
  await client.query("insert into public.role_assignments (user_id, role) select id, 'curator' from auth.users where email = $1 on conflict do nothing", [CURATOR]);
  // 2. The source access registry, then USDA (needed for the estimates).
  node("scripts/research-sources.mjs", "db-load");
  const usda = flag("--usda");
  if (usda)
    for (const z of readdirSync(usda).filter((x) => /^FoodData_Central_(sr_legacy|foundation).*\.zip$/.test(x)).sort()) {
      try {
        node("scripts/usda-import.mjs", join(usda, z));
      } catch {
        // Already imported on this computer, most likely; the estimates step below says if anything is missing.
        console.log(`(USDA file ${z} was not imported again; continuing.)`);
      }
    }
  // 3. The drafts and the estimates.
  for (const f of ["drafts-v2.json", "drafts-batch2.json"]) node("scripts/staging-entry.mjs", "enter", join(dir, f), "--as", CURATOR);
  node("scripts/menu-estimates.mjs", join(dir, "estimates.json"), "--as", CURATOR);
  // Later batches (optional: an older bundle without them still loads). Each place carries its own address fact.
  await laterBatches(client, dir, false, { link: false });
  // 4. NAYA's menu page lists every NAYA location; the researched profile is the Back Bay one, at
  //    500 Boylston St 02116 as that page lists it (the website alone is shared by three NAYA places).
  await nayaAddress(client);
  await addressFixes(client, false);
  // 5. Tie each researched place to its real catalog place (needs the real catalog, docs/39).
  node("scripts/menu-link.mjs", "link-websites", "--as", CURATOR, "--confirm");
  node("scripts/menu-link.mjs", "link-matches", "--as", CURATOR, "--confirm");
  // 6. The automatic comparison results, matched to this database's facts by place, dish and value.
  await recordChecks(client, dir, false, false);
  console.log("\nDone. Nothing was confirmed, verified or published.");
}

/**
 * Read-only. Compares the bundle with this database and returns every gap: a researched place that is missing, a
 * place with fewer dishes or facts here than in the bundle, and automatic results in the bundle that no fact here
 * carries. Exit code 1 when anything is missing, so an update can stop and report instead of guessing.
 */
async function verify(client, dir) {
  const gaps = [];
  const files = ["drafts-v2.json", "drafts-batch2.json", ...LATER_BATCHES.map((b) => `drafts-${b}.json`)].filter((f) => existsSync(join(dir, f)));
  let places = 0;
  for (const f of files) {
    for (const p of JSON.parse(readFileSync(join(dir, f), "utf8")).places) {
      places += 1;
      const r = (await client.query(
        `select (select count(*)::int from staging.dishes d where d.place_id = p.id) dishes,
                (select count(*)::int from staging.facts x where x.place_id = p.id) facts
           from staging.places p where p.label = $1`, [p.label])).rows[0];
      if (!r) { gaps.push(`missing place: ${p.label} (${f})`); continue; }
      if (r.dishes < (p.dishes ?? []).length) gaps.push(`${p.label}: ${r.dishes} dishes here, ${p.dishes.length} in the bundle`);
      if (r.facts < (p.facts ?? []).length) gaps.push(`${p.label}: ${r.facts} facts here, ${p.facts.length} in the bundle`);
    }
  }
  let missingChecks = 0;
  const file = join(dir, "machine-checks.json");
  if (existsSync(file)) {
    const keys = new Set(JSON.parse(readFileSync(file, "utf8")).checks.map((c) => c.key));
    const have = (await client.query(`
      select p.label place, d.label dish, f.kind, f.subject, f.value
        from staging.facts f join staging.places p on p.id = f.place_id join staging.dishes d on d.id = f.dish_id
       where exists (select 1 from staging.fact_machine_checks m where m.fact_id = f.id)`)).rows;
    for (const h of have) keys.delete(factKey(h));
    // A result for a place the bundle's drafts do not hold (a test place, for one) can never apply: noted, not a gap.
    const labels = new Set(files.flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).places.map((p) => p.label)));
    const foreign = [...keys].filter((k) => !labels.has(JSON.parse(k)[0]));
    missingChecks = keys.size - foreign.length;
    if (foreign.length) console.log(`NOTE ${foreign.length} automatic results are for places this bundle does not hold (${[...new Set(foreign.map((k) => JSON.parse(k)[0]))].join(", ")}); they are ignored.`);
    if (missingChecks) gaps.push(`${missingChecks} automatic results in the bundle that no fact here carries`);
  }
  // The steps after the first draft files: an estimate (or a recorded unknown) per estimated dish, NAYA's address.
  const est = join(dir, "estimates.json");
  if (existsSync(est)) {
    const want = JSON.parse(readFileSync(est, "utf8")).estimates ?? [];
    const have = new Set((await client.query(
      `select p.label || '|' || d.label k from staging.dishes d join staging.places p on p.id = d.place_id
        where exists (select 1 from staging.dish_estimates e where e.dish_id = d.id)`)).rows.map((r) => r.k));
    const missing = want.filter((e) => !have.has(`${e.place}|${e.dish}`));
    if (missing.length) gaps.push(`${missing.length} protein estimates in the bundle are not here (first: ${missing[0].place}, ${missing[0].dish})`);
  }
  if (files.includes("drafts-v2.json") && !(await client.query(
    "select 1 from staging.facts f join staging.places p on p.id = f.place_id where p.label = 'NAYA' and f.kind = 'address'")).rowCount)
    gaps.push("NAYA: no address fact (the step after the first draft files did not run)");
  console.log(`Checked ${places} researched places from ${files.length} draft files.`);
  if (gaps.length) for (const g of gaps) console.log(`GAP  ${g}`);
  else console.log("Nothing missing: every place, dish, fact and automatic result in the bundle is here.");
  return gaps.length;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (cmd === "export-checks" && folder) await exportChecks(client, resolve(folder));
  else if (cmd === "load" && folder) await load(client, resolve(folder), rest.includes("--dry-run"));
  else if (cmd === "verify" && folder) process.exitCode = (await verify(client, resolve(folder))) ? 1 : 0;
  else throw new Error("Use: load <bundle folder> [--usda <folder>] [--dry-run] | verify <bundle folder> | export-checks <file>");
} finally {
  await client.end();
}
