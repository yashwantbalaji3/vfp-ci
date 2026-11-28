// Boston-wide restaurant IDENTITY import into the private `catalog_import` schema (docs/31).
// LOCAL, or a hosted beta database for loading commands only (scripts/lib/db-target.mjs). refuses any database that is not on this computer. Nothing here publishes anything,
// and nothing here records what a place serves.
//
//   node scripts/catalog-import.mjs load <source_key> <file.csv> --release <id> [--area boston-core|<market>] [--as-of YYYY-MM-DD] [--dry-run]
//     --area: boston-core (default, the first import's box) or a market slug (about 25 miles round its centre: docs/84).
//     A run only compares with, and marks absent, records of the same source inside the same area, so loading one
//     city never touches another city's records.
//   node scripts/catalog-import.mjs match [--dry-run]
//   node scripts/catalog-import.mjs report [--out coverage.md]
//   node scripts/catalog-import.mjs load-taxonomy <file.csv> --release <id> [--dry-run]
//     (Overture's own categories from scripts/catalog/overture-taxonomy.py, for cuisine: docs/49)
//
// source_key: overture_places (CSV from scripts/catalog/overture-extract.py), boston_food_licenses
// (Analyze Boston CSV), cambridge_food_permits (Cambridge open data CSV, identity columns).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { parseTaxonomyRows } from "./lib/cuisine.mjs";
import { areaFor, buildCandidates, coverageMarkdown, parseBostonLicenses, parseCambridgePermits, parseCsv, parseOverture, runRefusal, THRESHOLDS } from "./lib/catalog-import-lib.mjs";
import { assertTarget } from "./lib/db-target.mjs";

const args = process.argv.slice(2);
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const has = (n) => args.includes(n);
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, args[0], ["load", "load-taxonomy", "match", "report"]);

const PARSERS = {
  overture_places: (rows, asOf, area) => parseOverture(rows, { area }),
  boston_food_licenses: (rows, asOf, area) => parseBostonLicenses(rows, { area }),
  cambridge_food_permits: (rows, asOf, area) => parseCambridgePermits(rows, asOf, { area }),
};

/** Loads one source file as one import run. Returns the run summary. */
// `ownTransaction: false` lets a caller (the database tests) hold the transaction; `minRows` overrides
// the run-level minimum for small test files only.
/**
 * @param {import("pg").ClientBase} client
 * @param {string} sourceKey
 * @param {string} file
 * @param {{ release?: string, asOf?: Date, dryRun?: boolean, ownTransaction?: boolean, minRows?: number, area?: string }} [options]
 */
export async function load(client, sourceKey, file, { release, asOf = new Date(), dryRun = false, ownTransaction = true, minRows, area: areaKey = "boston-core" } = {}) {
  const area = areaFor(areaKey);
  if (!PARSERS[sourceKey]) throw new Error(`Unknown source ${sourceKey}`);
  if (!release) throw new Error("--release is required (the dataset's release or download date)");
  const bytes = readFileSync(file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const rows = parseCsv(bytes.toString("utf8"));
  const { records, skipped } = PARSERS[sourceKey](rows, asOf, area);
  // The previous run of this source in this area (runs before areas existed were all boston-core).
  const prev = (await client.query("select (counts->>'records')::int as n from catalog_import.import_runs where source_key = $1 and status = 'completed' and coalesce(counts->>'area', 'boston-core') = $2 order by started_at desc limit 1", [sourceKey, area.key])).rows[0]?.n ?? null;
  const refusal = runRefusal(sourceKey, records, rows.length, prev, minRows);
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    const run = (await client.query(
      "insert into catalog_import.import_runs (source_key, release, file_sha256, retrieved_at, thresholds, status, refusal) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [sourceKey, release, sha, asOf.toISOString(), JSON.stringify(THRESHOLDS), refusal ? "refused" : "running", refusal],
    )).rows[0].id;
    const counts = { area: area.key, input_rows: rows.length, records: records.length, skipped, added: 0, changed: 0, unchanged: 0, returned: 0, absent: 0 };
    if (!refusal) {
      const existing = new Map((await client.query("select id, external_id, record_hash, present, lat, lon from catalog_import.source_records where source_key = $1", [sourceKey])).rows.map((r) => [r.external_id, r]));
      const seen = new Set();
      for (const r of records) {
        seen.add(r.external_id);
        const old = existing.get(r.external_id);
        const vals = [r.name, r.street, r.locality, r.postcode, r.lat, r.lon, r.category, r.status_hint, r.confidence, r.website, r.record_licence, r.record_hash, run];
        if (!old) {
          const id = (await client.query(
            `insert into catalog_import.source_records (source_key, external_id, name, street, locality, postcode, lat, lon, category, status_hint, confidence, website, record_licence, record_hash, first_run, last_run)
             values ($14, $15, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) returning id`, [...vals, sourceKey, r.external_id])).rows[0].id;
          await client.query("insert into catalog_import.record_history (record_id, run_id, change, new_hash) values ($1, $2, 'added', $3)", [id, run, r.record_hash]);
          counts.added++;
        } else {
          const change = !old.present ? "returned" : old.record_hash !== r.record_hash ? "changed" : null;
          await client.query(
            `update catalog_import.source_records set name = $1, street = $2, locality = $3, postcode = $4, lat = $5, lon = $6, category = $7, status_hint = $8, confidence = $9,
             website = $10, record_licence = $11, record_hash = $12, last_run = $13, present = true where id = $14`, [...vals, old.id]);
          if (change) {
            await client.query("insert into catalog_import.record_history (record_id, run_id, change, old_hash, new_hash) values ($1, $2, $3, $4, $5)", [old.id, run, change, old.record_hash, r.record_hash]);
            counts[change]++;
          } else counts.unchanged++;
        }
      }
      for (const old of existing.values()) {
        if (seen.has(old.external_id) || !old.present) continue;
        // Only records inside this run's area can be "gone from this release"; another city's records are not compared.
        if (!area.contains({ lat: old.lat, lon: old.lon })) continue;
        // Gone from this release: kept and marked absent, never deleted.
        await client.query("update catalog_import.source_records set present = false, last_run = $1 where id = $2", [run, old.id]);
        await client.query("insert into catalog_import.record_history (record_id, run_id, change, old_hash) values ($1, $2, 'absent', $3)", [old.id, run, old.record_hash]);
        counts.absent++;
      }
    }
    await client.query("update catalog_import.import_runs set counts = $1, finished_at = now(), status = case when status = 'refused' then 'refused' else 'completed' end where id = $2", [JSON.stringify(counts), run]);
    await tx(dryRun ? "rollback" : "commit");
    return { run, refusal, counts, dryRun };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/** Links every present, unlinked source record to a candidate (strict automatic match or a new candidate). */
/** A UUID-shaped id derived from a source record key (not random). */
export function stableId(key) {
  const h = createHash("sha256").update(`candidate:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function match(client, { dryRun = false, ownTransaction = true } = {}) {
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  await tx("begin");
  try {
    const run = (await client.query("select id from catalog_import.import_runs where status = 'completed' order by started_at desc limit 1")).rows[0]?.id;
    if (!run) throw new Error("No completed import run yet.");
    const recs = (await client.query("select r.*, l.candidate_id from catalog_import.source_records r left join catalog_import.candidate_links l on l.record_id = r.id where r.present")).rows;
    const cands = new Map((await client.query("select * from catalog_import.place_candidates")).rows.map((c) => [c.id, { ...c, records: [] }]));
    for (const r of recs) if (r.candidate_id) cands.get(r.candidate_id)?.records.push(r);
    const unlinked = recs.filter((r) => !r.candidate_id);
    const before = new Set(cands.keys());
    const { candidates, links, stats } = buildCandidates(unlinked, [...cands.values()].filter((c) => c.records.length));
    for (const c of candidates) {
      if (c.id && before.has(c.id)) {
        await client.query("update catalog_import.place_candidates set quality = $1, flags = $2, updated_at = now() where id = $3 and quality <> 'rejected'", [c.quality, c.flags, c.id]);
        continue;
      }
      // A stable id from the record that started the candidate, so rebuilding from the same files
      // gives the same ids (and the same representative sample for the same seed).
      c.id = (await client.query(
        "insert into catalog_import.place_candidates (id, name, street, postcode, lat, lon, category, quality, flags, created_run) values ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
        [c.name, c.street, c.postcode, c.lat, c.lon, c.category, c.quality, c.flags, run, stableId(`${c.records[0].source_key}:${c.records[0].external_id}`)])).rows[0].id;
    }
    for (const l of links) {
      await client.query("insert into catalog_import.candidate_links (candidate_id, record_id, match_score, match_method) values ($1, $2, $3, $4)", [l.candidate.id, l.record.id, l.score, l.method]);
    }
    await tx(dryRun ? "rollback" : "commit");
    return { stats, candidates: candidates.length };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

/**
 * Loads Overture's taxonomy (primary category and alternates) for Overture records into the private import schema.
 * Replaces the row of a record seen again; never touches a listing (the build step reads it).
 * @param {import("pg").ClientBase} client
 * @param {Array<Record<string, string>>} rows header-keyed rows of the taxonomy CSV
 * @param {{ release?: string, dryRun?: boolean, ownTransaction?: boolean }} [options]
 */
export async function loadTaxonomy(client, rows, { release, dryRun = false, ownTransaction = true } = {}) {
  if (!release || !/^[0-9A-Za-z.\-]{1,40}$/.test(release)) throw new Error("A --release is required.");
  const tx = (sql) => (ownTransaction ? client.query(sql) : Promise.resolve());
  const map = parseTaxonomyRows(rows);
  await tx("begin");
  try {
    let n = 0;
    for (const [id, t] of map) {
      await client.query(
        `insert into catalog_import.overture_taxonomy (external_id, release, primary_category, alternates) values ($1, $2, $3, $4)
         on conflict (external_id) do update set release = $2, primary_category = $3, alternates = $4, loaded_at = now()`,
        [id, release, t.primary || null, t.alternates.slice(0, 20)]);
      n++;
    }
    await tx(dryRun ? "rollback" : "commit");
    return { records: n, dryRun };
  } catch (e) {
    await tx("rollback");
    throw e;
  }
}

export async function report(client) {
  const runs = (await client.query("select distinct on (source_key) source_key, release, counts from catalog_import.import_runs where status = 'completed' order by source_key, started_at desc")).rows
    .map((r) => ({ source_key: r.source_key, release: r.release, records: r.counts.records, skipped: r.counts.skipped ?? {} }));
  const cands = (await client.query(
    `select c.id, c.quality, c.flags, c.postcode, coalesce(json_agg(json_build_object('source_key', r.source_key, 'locality', r.locality)) filter (where r.id is not null), '[]') as records
     from catalog_import.place_candidates c left join catalog_import.candidate_links l on l.candidate_id = c.id left join catalog_import.source_records r on r.id = l.record_id group by c.id`)).rows;
  return coverageMarkdown(cands, runs, new Date().toISOString().slice(0, 10));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const [cmd, a, b] = args;
    if (cmd === "load") {
      const out = await load(client, a, b, { release: flag("--release"), asOf: flag("--as-of") ? new Date(flag("--as-of")) : new Date(), dryRun: has("--dry-run"), area: flag("--area") ?? "boston-core" });
      console.log(out.refusal ? `Refused, nothing imported: ${out.refusal}` : `${out.dryRun ? "Dry run (rolled back)" : "Imported"}: ${JSON.stringify(out.counts)}`);
    } else if (cmd === "match") {
      const out = await match(client, { dryRun: has("--dry-run") });
      console.log(`${has("--dry-run") ? "Dry run (rolled back)" : "Matched"}: ${out.candidates} candidates; ${JSON.stringify(out.stats)}`);
    } else if (cmd === "load-taxonomy") {
      // parseCsv already returns one object per row, keyed by the header (fixed 18 Nov: this mapped them twice).
      const rows = parseCsv(readFileSync(a, "utf8"));
      const out = await loadTaxonomy(client, rows, { release: flag("--release"), dryRun: has("--dry-run") });
      console.log(`${out.dryRun ? "Dry run (rolled back)" : "Loaded"}: Overture taxonomy for ${out.records} records`);
    } else if (cmd === "report") {
      const md = await report(client);
      if (flag("--out")) { writeFileSync(flag("--out"), md); console.log(`Wrote ${flag("--out")}`); } else process.stdout.write(md);
    } else {
      throw new Error("Use: catalog-import.mjs load|match|report|load-taxonomy (see the header of this file)");
    }
  } finally {
    await client.end();
  }
}
