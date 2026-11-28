// Private real-catalog preview (docs/32). Local, or a hosted beta database for assess, build, cuisines and
// cuisine-status only (scripts/lib/db-target.mjs); publishing, switches and founder decisions stay local-only.
//
//   node scripts/catalog-preview.mjs assess [--dry-run]       sort every candidate into preview / exception / excluded
//   node scripts/catalog-preview.mjs build [--dry-run]        copy preview candidates into private preview listings
//   node scripts/catalog-preview.mjs cuisines [--dry-run]     refresh only the listings' cuisines from the loaded Overture taxonomy (docs/64)
//   node scripts/catalog-preview.mjs cuisine-status           read-only: is the cuisine data loaded, and what to run if not
//   node scripts/catalog-preview.mjs sample --size 60 --seed s1 [--expect 61] [--out sheet.md]   draw a representative sample for the founder
//     (--size is a target: every area gets at least 3 places, so --size 60 draws 61 for the Boston preview;
//      --expect refuses any other count; the same seed over the same places reuses the sample already drawn)
//   node scripts/catalog-preview.mjs batch --name boston-2026-11-17 --seed s1   freeze the preview and its sample as a batch (docs/35)
//   node scripts/catalog-preview.mjs extend-sample --name boston-2026-11-17 --to 125   add places to that batch's sample
//   node scripts/catalog-preview.mjs readiness [--out report.md]
//   node scripts/catalog-preview.mjs publication-status [--name boston-2026-11-17]   switch, approval and what could be public
//
// Publication (docs/38). Each one is the owner's decision; without --confirm each is a dry run that
// changes nothing. Every run that changes something is written to public.publication_events.
//   node scripts/catalog-preview.mjs switch on|off --by "<who>" [--note "..."] [--confirm]
//   node scripts/catalog-preview.mjs publish --name <batch> | --verified  --by "<who>" [--confirm]
//   node scripts/catalog-preview.mjs unpublish --name <batch> | --verified | --all  --by "<who>" [--confirm]
//
// The founder's own steps (never run on the founder's behalf):
//   node scripts/catalog-preview.mjs record-sample <sample_id> <candidate_id> <outcome> --as <email> [--note "..."]
//   node scripts/catalog-preview.mjs decide <candidate_id> verify_identity|reject|needs_more_evidence --as <email> [--note "..."]
//
// Only publish (with --confirm) makes listings public. Listings are built with visibility 'preview', which only
// the founder can see, and making a listing public is refused by the database unless the real-place switch
// is on and the place is founder-verified or in a currently approved batch.
import { cuisinesFromTaxonomy } from "./lib/cuisine.mjs";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { precheckIdentity } from "./lib/identity-precheck.mjs";
import { areaFor, assessCandidate, batchFingerprint, extendSampleIds, nearTwins, categoryLabel, drawSample, EXCEPTION_REASONS, listingSlug, sampleVerdict } from "./lib/catalog-preview-lib.mjs";
import { FOCUS_POSTCODES, marketAt, metres, nameSimilarity } from "./lib/catalog-import-lib.mjs";
import { assertTarget } from "./lib/db-target.mjs";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const has = (n) => args.includes(n);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, args[0], ["assess", "build", "cuisines", "cuisine-status"]);

/** @param {import("pg").ClientBase} client */
async function candidatesWithRecords(client) {
  const rows = (await client.query(
    `select c.*, coalesce(json_agg(json_build_object('source_key', r.source_key, 'name', r.name, 'street', r.street, 'locality', r.locality, 'postcode', r.postcode,
            'lat', r.lat, 'lon', r.lon, 'present', r.present, 'category', r.category, 'external_id', r.external_id, 'website', r.website, 'status_hint', r.status_hint) order by r.source_key, r.external_id) filter (where r.id is not null), '[]') as records,
            -- The founder's latest decision, from the command line or from the review page.
            (select x.decision from (select d.decision, d.decided_at from catalog_import.identity_decisions d where d.candidate_id = c.id
                                     union all select r.decision, r.decided_at from public.identity_reviews r where r.candidate_id = c.id) x
              order by x.decided_at desc limit 1) as decision
       from catalog_import.place_candidates c
       left join catalog_import.candidate_links l on l.candidate_id = c.id
       left join catalog_import.source_records r on r.id = l.record_id
      group by c.id`)).rows;
  return rows;
}

/**
 * Assesses every candidate. A founder's latest "reject" excludes it; nothing else a person decided is
 * changed here. `ownTransaction: false` lets a test hold the transaction.
 * @param {import("pg").ClientBase} client
 * @param {{ dryRun?: boolean, ownTransaction?: boolean }} [options]
 */
export async function assess(client, { dryRun = false, ownTransaction = true } = {}) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    const counts = { preview: 0, exception: 0, excluded: 0, reasons: {} };
    const all = await candidatesWithRecords(client);
    const decided = (c) => {
      if (c.decision === "reject") return { tier: "excluded", reasons: ["rejected"] };
      // The founder checked this place's identity: it enters the preview, as verified, whatever the checks said.
      if (c.decision === "verify_identity") return { tier: "preview", reasons: [] };
      const a = assessCandidate(c);
      if (c.decision === "needs_more_evidence") return { tier: "exception", reasons: [...a.reasons.filter((r) => r !== "single_source" && r !== "needs_review"), "founder_needs_more_evidence"] };
      return a;
    };
    const first = new Map(all.map((c) => [c.id, decided(c)]));
    // Second pass: near-identical names close together among the places that passed.
    for (const id of nearTwins(all.filter((c) => first.get(c.id).tier === "preview" && c.decision !== "verify_identity"))) first.set(id, { tier: "exception", reasons: ["near_twin"] });
    for (const c of all) {
      const a = first.get(c.id);
      counts[a.tier]++;
      for (const r of a.reasons) counts.reasons[r] = (counts.reasons[r] ?? 0) + 1;
      await client.query("update catalog_import.place_candidates set preview_tier = $1, preview_reasons = $2, assessed_at = now() where id = $3", [a.tier, a.reasons, c.id]);
    }
    await tx(dryRun ? "rollback" : "commit");
    return counts;
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/**
 * A place known from one dataset only, with nothing else in doubt (owner decision 24 Nov 2026 17:59 UTC, Option A):
 * it becomes a private directory listing marked single_source ("one source, not cross-checked"). The database
 * refuses to make such a listing public. A founder rejection or any other concern keeps it out.
 */
export const singleSourceOnly = (c) =>
  c.decision !== "reject" && c.preview_tier === "exception" && Array.isArray(c.preview_reasons) && c.preview_reasons.length === 1 && c.preview_reasons[0] === "single_source";

/**
 * Copies every preview-tier candidate, and every single-source-only candidate, into public.place_listings (visibility 'preview'); a listing
 * whose candidate left the preview tier is withdrawn, never deleted. Identity is 'verified' only
 * where the founder's latest decision says so.
 * @param {import("pg").ClientBase} client
 * @param {{ dryRun?: boolean, ownTransaction?: boolean }} [options]
 */
export async function build(client, { dryRun = false, ownTransaction = true } = {}) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    const sources = new Map((await client.query("select key, title, attribution from catalog_import.sources")).rows.map((s) => [s.key, s]));
    const releases = new Map((await client.query("select distinct on (source_key) source_key, release from catalog_import.import_runs where status = 'completed' order by source_key, started_at desc")).rows.map((r) => [r.source_key, r.release]));
    const all = await candidatesWithRecords(client);
    // Overture's own categories, for cuisine (docs/49): read from the record, never guessed from a name.
    const taxonomy = new Map((await client.query("select external_id, primary_category, alternates from catalog_import.overture_taxonomy")).rows
      .map((t) => [t.external_id, { primary: t.primary_category ?? "", alternates: t.alternates ?? [] }]));
    // A catalog loaded before cuisine data existed (the owner's Mac, 17 Nov) had no taxonomy, and every build then
    // wrote empty cuisines without a word. Say so instead (docs/64).
    const overtureRecords = Number((await client.query("select count(*) n from catalog_import.source_records where source_key = 'overture_places'")).rows[0].n);
    const cuisineWarning = overtureRecords > 0 && taxonomy.size === 0 ? CUISINE_MISSING : null;
    if (cuisineWarning) console.warn(cuisineWarning);
    const keep = new Set();
    let added = 0;
    let updated = 0;
    let outsideMarkets = 0;
    let singleSource = 0;
    for (const c of all.filter((x) => x.preview_tier === "preview" || singleSourceOnly(x))) {
      // Each listing belongs to the market whose area holds it (docs/84); a place outside all six is not listed.
      const market = marketAt({ lat: c.lat, lon: c.lon });
      if (!market) {
        outsideMarkets++;
        continue;
      }
      keep.add(c.id);
      const srcKeys = [...new Set(c.records.map((r) => r.source_key))].sort();
      const src = srcKeys.map((k) => ({ key: k, title: sources.get(k)?.title, attribution: sources.get(k)?.attribution, release: releases.get(k) ?? null }));
      const overture = c.records.find((r) => r.source_key === "overture_places");
      const vals = [c.name, c.street, c.records.find((r) => r.locality)?.locality ?? null, c.postcode, areaFor(c.postcode), c.lat, c.lon, categoryLabel(overture?.category ?? c.category),
        c.decision === "verify_identity" ? "verified" : singleSourceOnly(c) ? "single_source" : "corroborated", JSON.stringify(src), srcKeys.map((k) => `${k}@${releases.get(k) ?? "?"}`).join(" + ")];
      const cuisines = overture && taxonomy.has(overture.external_id) ? cuisinesFromTaxonomy(taxonomy.get(overture.external_id)) : [];
      const res = await client.query(
        `insert into public.place_listings (candidate_id, slug, name, street, locality, postcode, area, lat, lon, category, identity_status, sources, built_from, cuisines, market_slug)
         values ($12, $13, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $14, $15)
         on conflict (candidate_id) do update set name = $1, street = $2, locality = $3, postcode = $4, area = $5, lat = $6, lon = $7, category = $8,
           identity_status = $9, sources = $10, built_from = $11, cuisines = $14, visibility = case when place_listings.visibility = 'withdrawn' then 'preview' else place_listings.visibility end
         returning (xmax = 0) as inserted`,
        [...vals, c.id, listingSlug(c.name, c.street, c.id), JSON.stringify(cuisines), market]);
      if (res.rows[0].inserted) added++; else updated++;
      if (singleSourceOnly(c)) singleSource++;
    }
    // A place that no longer passes every check leaves the preview, and leaves the public list too.
    const gone = (await client.query("update public.place_listings set visibility = 'withdrawn' where visibility in ('preview', 'public') and not (candidate_id = any($1::uuid[])) returning id", [[...keep]])).rowCount;
    const review = await buildReviewItems(client, all, releases);
    await tx(dryRun ? "rollback" : "commit");
    return { preview: keep.size - singleSource, singleSource, added, updated, withdrawn: gone, review, ...(outsideMarkets ? { outsideMarkets } : {}), ...(cuisineWarning ? { cuisineWarning } : {}) };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/**
 * Copies what the founder needs to judge each queued place into public.identity_review_items: every
 * corroborated place in an exception queue, and every place in the latest sample. Places that leave
 * every queue are marked inactive (their decisions stay). Nothing from a person (phone, applicant) is
 * copied, because it was never imported.
 * @param {import("pg").ClientBase} client
 */
async function buildReviewItems(client, all, releases) {
  const latest = (await client.query("select id, seed from catalog_import.identity_samples order by drawn_at desc limit 1")).rows[0];
  const sampled = new Set(latest ? (await client.query("select candidate_id from catalog_import.identity_sample_items where sample_id = $1", [latest.id])).rows.map((r) => r.candidate_id) : []);
  const titles = new Map((await client.query("select key, title from catalog_import.sources")).rows.map((r) => [r.key, r.title]));
  // Places a visitor reported (docs/36) join their own queue until the founder resolves the report.
  const reported = new Set((await client.query("select distinct l.candidate_id from public.place_reports r join public.place_listings l on l.id = r.listing_id where r.resolved_at is null")).rows.map((r) => r.candidate_id));
  const queued = all.filter((c) => sampled.has(c.id) || reported.has(c.id) || (c.quality === "corroborated" && c.preview_tier === "exception") || c.decision);
  const active = [];
  for (const c of queued) {
    const queues = [...(sampled.has(c.id) ? ["sample"] : []), ...(reported.has(c.id) ? ["reported_by_visitor"] : []), ...(c.preview_reasons ?? []).filter((r) => r !== "single_source" && r !== "needs_review")];
    if (!queues.length) queues.push(c.decision ? "decided" : "other");
    const near = (await client.query(
      `select name, street, quality, lat, lon from catalog_import.place_candidates where id <> $1 and abs(lat - $2) < 0.0014 and abs(lon - $3) < 0.0019`, [c.id, c.lat, c.lon])).rows
      .map((n) => ({ name: n.name, street: n.street, quality: n.quality, metres: Math.round(metres(c, n)) }))
      .filter((n) => n.metres <= 150 && nameSimilarity(n.name, c.name) >= 0.5)
      .sort((a, b) => a.metres - b.metres).slice(0, 5);
    let apart = 0;
    for (let i = 0; i < c.records.length; i++) for (let j = i + 1; j < c.records.length; j++) apart = Math.max(apart, metres(c.records[i], c.records[j]));
    const evidence = {
      reasons: queues.filter((q) => q !== "sample").map((q) => ({ code: q, words: EXCEPTION_REASONS[q] ?? q })),
      records: c.records.map((r) => ({ source: titles.get(r.source_key) ?? r.source_key, sourceKey: r.source_key, release: releases.get(r.source_key) ?? null, recordId: r.external_id,
        name: r.name, street: r.street, postcode: r.postcode, locality: r.locality, category: r.category, website: r.website, openStatus: r.status_hint, present: r.present,
        lat: Math.round(r.lat * 1e6) / 1e6, lon: Math.round(r.lon * 1e6) / 1e6 })),
      recordsApartMetres: Math.round(apart),
      lookalikes: near,
      quality: c.quality,
    };
    // The automatic pre-check (docs/51): stored so queue lists and the summary can show it; never a decision.
    const pre = precheckIdentity(evidence);
    evidence.precheck = { level: pre.level, concerns: pre.points.filter((p) => !p.ok).map((p) => p.code), version: pre.version };
    await client.query(
      `insert into public.identity_review_items (candidate_id, name, street, postcode, area, lat, lon, queues, sample_seed, evidence, active, sort_key, built_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, now())
       on conflict (candidate_id) do update set name = $2, street = $3, postcode = $4, area = $5, lat = $6, lon = $7, queues = $8, sample_seed = $9, evidence = $10, active = true, sort_key = $11, built_at = now()`,
      [c.id, c.name, c.street, c.postcode, areaFor(c.postcode), c.lat, c.lon, queues, sampled.has(c.id) ? latest.seed : null, JSON.stringify(evidence), `${areaFor(c.postcode) ?? "~"}|${c.name}`]);
    active.push(c.id);
  }
  const off = (await client.query("update public.identity_review_items set active = false where active and not (candidate_id = any($1::uuid[]))", [active])).rowCount;
  return { items: active.length, inactive: off };
}

const osm = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;

/**
 * Draws a representative sample of the preview tier and returns the founder's check sheet.
 * @param {import("pg").ClientBase} client
 * @param {{ size?: number, seed?: string, expect?: number, ownTransaction?: boolean }} [options]
 */
export async function sample(client, { size = 60, seed = "sample-1", expect, ownTransaction = true } = {}) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    const pool = (await candidatesWithRecords(client)).filter((c) => c.preview_tier === "preview");
    if (!pool.length) throw new Error("No preview candidates yet: run assess first.");
    const picked = drawSample(pool, { size, seed });
    // `--size` is a target: every area gets at least 3 places, so the count can differ by one or two.
    if (expect != null && picked.length !== expect) {
      throw new Error(`This draws ${picked.length} places, not the expected ${expect}. Nothing was written. Check --size and --seed.`);
    }
    const fingerprint = batchFingerprint(picked.map((p) => p.id));
    // The same seed over the same places always picks the same cohort: reuse the sample already drawn
    // instead of adding a copy, so the founder's recorded results stay attached to it.
    let id = null;
    let reused = false;
    for (const prev of (await client.query("select id, population_n from catalog_import.identity_samples where seed = $1 and population = 'preview' order by drawn_at desc", [seed])).rows) {
      const ids = (await client.query("select candidate_id from catalog_import.identity_sample_items where sample_id = $1", [prev.id])).rows.map((r) => r.candidate_id);
      if (prev.population_n === pool.length && batchFingerprint(ids) === fingerprint) { id = prev.id; reused = true; break; }
    }
    if (!id) {
      id = (await client.query("insert into catalog_import.identity_samples (seed, population, population_n) values ($1, 'preview', $2) returning id", [seed, pool.length])).rows[0].id;
      for (const p of picked) await client.query("insert into catalog_import.identity_sample_items (sample_id, candidate_id, stratum) values ($1, $2, $3)", [id, p.id, p.stratum]);
    }
    await tx("commit");
    const byId = new Map(pool.map((c) => [c.id, c]));
    const lines = [`# Identity sample ${seed} (${picked.length} of ${pool.length} preview places)`, "",
      `Cohort fingerprint: \`${fingerprint}\` (the same 61 places give the same fingerprint on any computer).`, "",
      "For each place, check that it is a real restaurant or café, open to the public, at this address, and not a duplicate. Open the map link and, if needed, the restaurant's own page. Record each result yourself on the review page, http://localhost:3000/places/review, signed in with your publisher account.", "",
      "Nothing here is verified by this sheet, and checking a sample does not publish anything.", ""];
    let stratum = null;
    for (const p of picked) {
      const c = byId.get(p.id);
      if (p.stratum !== stratum) { lines.push(`## ${p.stratum}`, ""); stratum = p.stratum; }
      lines.push(`- **${c.name}**, ${c.street ?? "no street"} ${c.postcode ?? ""}. Candidate \`${c.id}\`. [Map](${osm(c.lat, c.lon)})`);
      for (const r of c.records) lines.push(`  - ${r.source_key}: "${r.name}", ${r.street ?? "no street"} ${r.postcode ?? ""} (record ${r.external_id})`);
    }
    return { id, reused, fingerprint, picked: picked.length, population: pool.length, sheet: lines.join("\n") + "\n" };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/** @param {import("pg").ClientBase} client */
export async function readiness(client, generatedOn = new Date().toISOString().slice(0, 10)) {
  const all = await candidatesWithRecords(client);
  const corr = all.filter((c) => c.quality === "corroborated");
  const tier = (list, t) => list.filter((c) => c.preview_tier === t).length;
  const reasonCount = (list) => {
    const m = {};
    for (const c of list) for (const r of c.preview_reasons ?? []) m[r] = (m[r] ?? 0) + 1;
    return m;
  };
  const listings = (await client.query("select visibility, identity_status, area, count(*)::int n from public.place_listings group by 1, 2, 3")).rows;
  const sum = (f) => listings.filter(f).reduce((a, r) => a + r.n, 0);
  const decisions = (await client.query(`select decision, count(*)::int n from (select distinct on (candidate_id) candidate_id, decision from (
      select candidate_id, decision, decided_at from catalog_import.identity_decisions union all select candidate_id, decision, decided_at from public.identity_reviews) x
      order by candidate_id, decided_at desc) d group by 1`)).rows;
  const samples = (await client.query("select s.id, s.seed, s.population_n, array_agg(i.outcome) outcomes from catalog_import.identity_samples s join catalog_import.identity_sample_items i on i.sample_id = s.id group by s.id order by s.drawn_at desc limit 3")).rows;
  const L = [`# Real Boston catalog: release readiness (${generatedOn})`, ""];
  L.push("Identity only. Nothing is published; the real-place lock is off. \"Corroborated\" means two independent public datasets agree; it is not verification. Every listing says \"Menu not checked yet\" and none can appear in vegetarian, vegan or protein filters.", "");
  L.push("## Summary", "", "| | Places |", "|---|---|");
  L.push(`| Imported candidates | ${all.length} |`, `| Corroborated by two sources | ${corr.length} |`);
  L.push(`| **Safe for the private preview** (corroborated, every automatic check passed) | **${tier(corr, "preview")}** |`);
  L.push(`| Corroborated but in an exception queue (a person decides) | ${tier(corr, "exception")} |`);
  L.push(`| Single source, or failed an import check (not in this preview) | ${all.filter((c) => c.quality !== "corroborated" && c.preview_tier !== "excluded").length} |`);
  L.push(`| Excluded (rejected by a person) | ${tier(all, "excluded")} |`);
  L.push(`| Preview listings built | ${sum((r) => r.visibility === "preview")} (withdrawn ${sum((r) => r.visibility === "withdrawn")}, public ${sum((r) => r.visibility === "public")}) |`);
  L.push(`| Identity verified by the founder | ${decisions.find((d) => d.decision === "verify_identity")?.n ?? 0} |`, "");
  L.push("## Exception queues among corroborated places", "", "| Reason | Places |", "|---|---|");
  for (const [k, v] of Object.entries(reasonCount(corr)).sort((a, b) => b[1] - a[1])) L.push(`| ${EXCEPTION_REASONS[k] ?? k} | ${v} |`);
  L.push("", "A place can be in more than one queue.", "");
  L.push("## Preview listings by focus area", "", "| Area | Preview listings |", "|---|---|");
  for (const area of Object.keys(FOCUS_POSTCODES)) L.push(`| ${area} | ${sum((r) => r.area === area && r.visibility === "preview")} |`);
  L.push(`| Elsewhere in the service area | ${sum((r) => r.area === null && r.visibility === "preview")} |`, "");
  L.push("## Representative sample", "");
  if (!samples.length) L.push("No sample drawn yet.", "");
  for (const s of samples) {
    const v = sampleVerdict(s.outcomes);
    L.push(`- Sample ${s.seed}: ${v.checked} of ${v.of} checked by the founder${v.checked ? `, ${v.problems} problem(s)` : ""}. ${v.done ? (v.passes ? "Passes the 5% problem limit." : "Above the 5% problem limit: fix the rule that let them through and draw again.") : "Waiting for the founder."} (population ${s.population_n})`);
  }
  L.push("", "## What is automated, what needs a person, what is blocked", "");
  L.push("- **Automated:** import, deduplication, the checks above, building the private preview, drawing samples, this report, monthly refresh (re-run).");
  L.push("- **Needs the founder:** checking each sample; every exception-queue place; turning any place's identity into \"verified\"; every dish, dietary, allergen and nutrition fact (separate workflow).");
  L.push("- **Blocked until the owner decides:** showing any real place publicly (real-place lock off), and whether places without checked menus may appear in general discovery labelled \"Menu not checked yet\".", "");
  return L.join("\n");
}

/**
 * Freezes the current preview places into a named batch with the sample drawn from exactly that list
 * (docs/35). Publishes nothing and changes no identity status.
 * @param {import("pg").ClientBase} client
 * @param {{ name: string, seed: string, ownTransaction?: boolean }} options
 */
export async function freezeBatch(client, { name, seed, ownTransaction = true }) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    // Batches are never replaced: running the same command again leaves the frozen batch as it is.
    if ((await client.query("select 1 from public.publication_batches where name = $1", [name])).rowCount) {
      throw new Error(`A batch named ${name} already exists and is kept as it was frozen. Nothing was changed.`);
    }
    const ids = (await client.query("select id from catalog_import.place_candidates where preview_tier = 'preview' order by id")).rows.map((r) => r.id);
    if (!ids.length) throw new Error("No preview places: run assess and build first.");
    const sampleRow = (await client.query("select id, population_n from catalog_import.identity_samples where seed = $1 order by drawn_at desc limit 1", [seed])).rows[0];
    if (!sampleRow) throw new Error(`No sample with seed ${seed}: draw one with the sample command first.`);
    const sampled = (await client.query("select candidate_id from catalog_import.identity_sample_items where sample_id = $1", [sampleRow.id])).rows.map((r) => r.candidate_id);
    const inBatch = new Set(ids);
    if (sampleRow.population_n !== ids.length || sampled.some((id) => !inBatch.has(id))) {
      throw new Error("That sample was drawn from a different list of places. Draw a new sample of the current preview, then freeze the batch.");
    }
    const listed = (await client.query("select count(*)::int n from public.place_listings where candidate_id = any($1::uuid[])", [ids])).rows[0].n;
    if (listed !== ids.length) throw new Error("Some preview places have no listing yet: run build first.");
    const batchId = (await client.query("insert into public.publication_batches (name, sample_seed, fingerprint, place_count) values ($1, $2, $3, $4) returning id", [name, seed, batchFingerprint(ids), ids.length])).rows[0].id;
    await client.query(
      "insert into public.publication_batch_places (batch_id, candidate_id, in_sample) select $1, x, x = any($3::uuid[]) from unnest($2::uuid[]) x",
      [batchId, ids, sampled]);
    await client.query("update public.place_listings set publication_batch = $1 where candidate_id = any($2::uuid[])", [batchId, ids]);
    await tx("commit");
    return { id: batchId, places: ids.length, sample: sampled.length, sampleFingerprint: batchFingerprint(sampled) };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/**
 * Extends a batch's sample to `to` places (for example from 61 to 125 when one or two problems turn up).
 * Refused once the batch has an approval decision. The new places join the sample review queue on the
 * next build.
 * @param {import("pg").ClientBase} client
 * @param {{ name: string, to: number, ownTransaction?: boolean }} options
 */
export async function extendBatchSample(client, { name, to, ownTransaction = true }) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    const b = (await client.query("select id, sample_seed from public.publication_batches where name = $1", [name])).rows[0];
    if (!b) throw new Error(`No batch named ${name}.`);
    const places = (await client.query("select candidate_id, in_sample from public.publication_batch_places where batch_id = $1 order by candidate_id", [b.id])).rows;
    const add = extendSampleIds(places.map((p) => p.candidate_id), places.filter((p) => p.in_sample).map((p) => p.candidate_id), { to, seed: b.sample_seed });
    const sampleId = (await client.query("select id from catalog_import.identity_samples where seed = $1 order by drawn_at desc limit 1", [b.sample_seed])).rows[0].id;
    const postcodes = new Map((await client.query("select id, postcode from catalog_import.place_candidates where id = any($1::uuid[])", [add])).rows.map((r) => [r.id, r.postcode]));
    for (const id of add) {
      await client.query("update public.publication_batch_places set in_sample = true where batch_id = $1 and candidate_id = $2", [b.id, id]);
      await client.query("insert into catalog_import.identity_sample_items (sample_id, candidate_id, stratum) values ($1, $2, $3)", [sampleId, id, `${areaFor(postcodes.get(id)) ?? "Elsewhere in the service area"} (extension)`]);
    }
    await tx("commit");
    return { added: add.length, sample: places.filter((p) => p.in_sample).length + add.length };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/**
 * The state the owner decides from: the switch, the batch's latest approval and how many listings are
 * public now or could be made public.
 * @param {import("pg").ClientBase} client
 * @param {{ name?: string }} [options]
 */
export async function publicationStatus(client, { name } = {}) {
  const on = (await client.query("select enabled from app.platform_switches where name = 'real_place_listings'")).rows[0]?.enabled ?? false;
  const batch = name ? (await client.query("select id, name, place_count from public.publication_batches where name = $1", [name])).rows[0] : null;
  if (name && !batch) throw new Error(`No batch named ${name}.`);
  const approval = batch
    ? (await client.query("select decision, decided_at, decided_at + interval '90 days' as expires_at, problems, sample_size from public.batch_approvals where batch_id = $1 order by decided_at desc, id desc limit 1", [batch.id])).rows[0] ?? null
    : null;
  const counts = (await client.query(
    `select count(*) filter (where visibility = 'public')::int as public,
            count(*) filter (where visibility = 'preview')::int as preview,
            count(*) filter (where visibility = 'public' and not app.listing_may_be_public(candidate_id, identity_status, publication_batch))::int as public_but_hidden
       from public.place_listings where $1::uuid is null or publication_batch = $1`, [batch?.id ?? null])).rows[0];
  const events = (await client.query("select action, scope, listings, run_by, at from public.publication_events order by at desc, id desc limit 5")).rows;
  const sampled = batch ? (await client.query("select candidate_id from public.publication_batch_places where batch_id = $1 and in_sample", [batch.id])).rows.map((r) => r.candidate_id) : [];
  return { switchOn: on, batch: batch ? { name: batch.name, places: batch.place_count, sample: sampled.length, sampleFingerprint: batchFingerprint(sampled) } : null, approval, ...counts, recent: events };
}

/** Begin/commit/rollback, or a savepoint inside a caller's transaction (tests). */
function unit(client, own) {
  return {
    begin: () => client.query(own ? "begin" : "savepoint publication_unit"),
    end: (keep) => client.query(own ? (keep ? "commit" : "rollback") : keep ? "release savepoint publication_unit" : "rollback to savepoint publication_unit"),
  };
}

/**
 * Turns the real-place switch on or off. Logged by the database trigger with the operator's name.
 * @param {import("pg").ClientBase} client
 * @param {{ on: boolean, by?: string, note?: string, confirm?: boolean, ownTransaction?: boolean }} options
 */
export async function setPlaceSwitch(client, { on, by, note, confirm = false, ownTransaction = true }) {
  if (!by) throw new Error('--by "<who>" is required.');
  const u = unit(client, ownTransaction);
  await u.begin();
  try {
    await client.query("select set_config('app.publication_run_by', $1, true), set_config('app.publication_note', $2, true)", [by, note ?? ""]);
    const r = await client.query("update app.platform_switches set enabled = $1 where name = 'real_place_listings' and enabled <> $1", [on]);
    await u.end(confirm);
    return { changed: r.rowCount === 1, applied: confirm };
  } catch (e) {
    await u.end(false);
    throw e;
  }
}

/**
 * Makes listings public, or takes them back to the private preview. Publishing only touches listings
 * the database accepts (switch on, and founder-verified or in a currently approved batch); the
 * listing guard refuses anything else. Without confirm the work is rolled back.
 * @param {import("pg").ClientBase} client
 * @param {{ action: "publish" | "unpublish", name?: string, verified?: boolean, all?: boolean, by?: string, note?: string, confirm?: boolean, ownTransaction?: boolean }} options
 */
export async function setPublication(client, { action, name, verified = false, all = false, by, note, confirm = false, ownTransaction = true }) {
  if (!by) throw new Error('--by "<who>" is required.');
  if ([Boolean(name), verified, all].filter(Boolean).length !== 1) throw new Error("Choose exactly one of --name <batch>, --verified or --all.");
  if (action === "publish" && all) throw new Error("Publishing everything at once is not offered: publish a batch or the founder-verified places.");
  const u = unit(client, ownTransaction);
  await u.begin();
  try {
    const batch = name ? (await client.query("select id from public.publication_batches where name = $1", [name])).rows[0] : null;
    if (name && !batch) throw new Error(`No batch named ${name}.`);
    const scope = name ? "batch" : verified ? "verified" : "all";
    const where = name ? "publication_batch = $1" : verified ? "identity_status = 'verified' and $1::uuid is null" : "$1::uuid is null";
    let n;
    if (action === "publish") {
      const on = (await client.query("select enabled from app.platform_switches where name = 'real_place_listings'")).rows[0]?.enabled;
      if (!on) throw new Error("The real-place switch is off, so nothing can be made public.");
      n = (await client.query(
        `update public.place_listings set visibility = 'public'
          where visibility = 'preview' and ${where} and app.listing_may_be_public(candidate_id, identity_status, publication_batch)`, [batch?.id ?? null])).rowCount;
    } else {
      n = (await client.query(`update public.place_listings set visibility = 'preview' where visibility = 'public' and ${where}`, [batch?.id ?? null])).rowCount;
    }
    if (n > 0) {
      await client.query("insert into public.publication_events (action, batch_id, scope, listings, run_by, note) values ($1, $2, $3, $4, $5, $6)",
        [action, batch?.id ?? null, scope, n, by, note ?? null]);
    }
    await u.end(confirm);
    return { listings: n, applied: confirm };
  } catch (e) {
    await u.end(false);
    throw e;
  }
}

export const CUISINE_MISSING =
  "Cuisine data is not loaded: catalog_import.overture_taxonomy is empty, so no listing gets a cuisine. Load it with " +
  "`node scripts/catalog-import.mjs load-taxonomy <overture-taxonomy CSV> --release <release>`, then run `node scripts/catalog-preview.mjs cuisines`.";

/**
 * Read-only: whether cuisine data is loaded, and what to run if not (docs/64).
 * @param {import("pg").ClientBase} client
 */
export async function cuisineStatus(client) {
  const n = async (sql) => Number((await client.query(sql)).rows[0].n);
  const out = {
    overtureRecords: await n("select count(*) n from catalog_import.source_records where source_key = 'overture_places'"),
    taxonomyRows: await n("select count(*) n from catalog_import.overture_taxonomy"),
    listings: await n("select count(*) n from public.place_listings"),
    listingsWithCuisine: await n("select count(*) n from public.place_listings where jsonb_array_length(cuisines) > 0"),
  };
  const next =
    out.overtureRecords > 0 && out.taxonomyRows === 0
      ? CUISINE_MISSING
      : out.listings > 0 && out.listingsWithCuisine === 0
        ? "The taxonomy is loaded but no listing has a cuisine yet: run `node scripts/catalog-preview.mjs cuisines`."
        : "Cuisine data is loaded.";
  return { ...out, next };
}

/**
 * Refreshes only public.place_listings.cuisines from the loaded Overture taxonomy, in place (docs/64). Nothing
 * else on a listing changes: not its identity, visibility, sources, slug or anything a person decided. Refuses
 * when the taxonomy is empty, so it can never blank every cuisine. Safe to run again: unchanged rows stay as they are.
 * @param {import("pg").ClientBase} client
 * @param {{ dryRun?: boolean, ownTransaction?: boolean }} [options]
 */
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export async function refreshCuisines(client, { dryRun = false, ownTransaction = true } = {}) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  const taxonomy = new Map((await client.query("select external_id, primary_category, alternates from catalog_import.overture_taxonomy")).rows
    .map((t) => [t.external_id, { primary: t.primary_category ?? "", alternates: t.alternates ?? [] }]));
  if (taxonomy.size === 0) throw new Error(CUISINE_MISSING);
  await tx("begin");
  try {
    const rows = (await client.query(
      `select l.id, l.cuisines, (select r.external_id from catalog_import.candidate_links cl join catalog_import.source_records r on r.id = cl.record_id
                                  where cl.candidate_id = l.candidate_id and r.source_key = 'overture_places' order by r.external_id limit 1) as overture_id
         from public.place_listings l`)).rows;
    let changed = 0;
    let withCuisine = 0;
    for (const r of rows) {
      const next = r.overture_id && taxonomy.has(r.overture_id) ? cuisinesFromTaxonomy(taxonomy.get(r.overture_id)) : [];
      if (next.length) withCuisine++;
      if (canon(next) === canon(r.cuisines ?? [])) continue;
      await client.query("update public.place_listings set cuisines = $2 where id = $1", [r.id, JSON.stringify(next)]);
      changed++;
    }
    await tx(dryRun ? "rollback" : "commit");
    return { listings: rows.length, withCuisine, changed, dryRun };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

async function asFounder(client, email) {
  if (!email) throw new Error("--as <email> is required: only the founder records this.");
  const u = (await client.query("select id from auth.users where email = $1", [email])).rows[0];
  if (!u) throw new Error("No such local account.");
  return u.id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const [cmd, a, b, c] = args;
    if (cmd === "assess") console.log(`${has("--dry-run") ? "Dry run (rolled back)" : "Assessed"}: ${JSON.stringify(await assess(client, { dryRun: has("--dry-run") }))}`);
    else if (cmd === "build") console.log(`${has("--dry-run") ? "Dry run (rolled back)" : "Built"}: ${JSON.stringify(await build(client, { dryRun: has("--dry-run") }))}`);
    else if (cmd === "cuisines") {
      const r = await refreshCuisines(client, { dryRun: has("--dry-run") });
      console.log(`${r.dryRun ? "Dry run (rolled back)" : "Refreshed"}: ${r.withCuisine} of ${r.listings} listings have a cuisine; ${r.changed} changed. Nothing else on a listing changed.`);
    } else if (cmd === "cuisine-status") console.log(JSON.stringify(await cuisineStatus(client), null, 2));
    else if (cmd === "sample") {
      const out = await sample(client, { size: Number(flag("--size") ?? 60), seed: flag("--seed") ?? `sample-${new Date().toISOString().slice(0, 10)}`, expect: flag("--expect") ? Number(flag("--expect")) : undefined });
      if (flag("--out")) writeFileSync(flag("--out"), out.sheet);
      console.log(`Sample ${out.id}${out.reused ? " (already drawn; reused, nothing added)" : ""}: ${out.picked} of ${out.population}; fingerprint ${out.fingerprint}${flag("--out") ? `; sheet ${flag("--out")}` : ""}`);
    } else if (cmd === "readiness") {
      const md = await readiness(client);
      if (flag("--out")) { writeFileSync(flag("--out"), md); console.log(`Wrote ${flag("--out")}`); } else process.stdout.write(md);
    } else if (cmd === "record-sample") {
      const who = await asFounder(client, flag("--as"));
      const r = await client.query("update catalog_import.identity_sample_items set outcome = $3, note = $4, checked_by = $5, checked_at = now() where sample_id = $1 and candidate_id = $2", [a, b, c, flag("--note") ?? null, who]);
      console.log(r.rowCount ? "Recorded." : "No such sample item.");
    } else if (cmd === "decide") {
      const who = await asFounder(client, flag("--as"));
      await client.query("insert into catalog_import.identity_decisions (candidate_id, decision, note, decided_by) values ($1, $2, $3, $4)", [a, b, flag("--note") ?? null, who]);
      console.log("Recorded. Run assess and build to apply it to the preview.");
    } else if (cmd === "batch") {
      const r = await freezeBatch(client, { name: flag("--name") ?? "", seed: flag("--seed") ?? "" });
      console.log(`Batch ${r.id}: ${r.places} places frozen, sample of ${r.sample} (fingerprint ${r.sampleFingerprint}). Nothing is published.`);
    } else if (cmd === "extend-sample") {
      const r = await extendBatchSample(client, { name: flag("--name") ?? "", to: Number(flag("--to") ?? 125) });
      console.log(`Added ${r.added} places; the sample now has ${r.sample}. Run build to add them to the review queue.`);
    } else if (cmd === "publication-status") {
      console.log(JSON.stringify(await publicationStatus(client, { name: flag("--name") }), null, 2));
    } else if (cmd === "switch") {
      if (a !== "on" && a !== "off") throw new Error("Use: switch on|off --by <who> [--confirm]");
      const r = await setPlaceSwitch(client, { on: a === "on", by: flag("--by"), note: flag("--note"), confirm: has("--confirm") });
      console.log(`${r.applied ? "" : "Dry run (rolled back): "}real-place switch ${r.changed ? `turned ${a}` : `already ${a}`}.`);
    } else if (cmd === "publish" || cmd === "unpublish") {
      const r = await setPublication(client, { action: cmd, name: flag("--name"), verified: has("--verified"), all: has("--all"), by: flag("--by"), note: flag("--note"), confirm: has("--confirm") });
      console.log(`${r.applied ? "" : "Dry run (rolled back): "}${r.listings} listings ${cmd === "publish" ? "made public" : "taken back to the private preview"}.`);
    } else throw new Error("Use: catalog-preview.mjs assess|build|cuisines|cuisine-status|sample|batch|extend-sample|readiness|record-sample|decide|publication-status|switch|publish|unpublish (see the header of this file)");
  } finally {
    await client.end();
  }
}
