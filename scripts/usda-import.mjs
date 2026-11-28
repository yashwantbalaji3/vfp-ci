// NIE V1 slice N-1: import a USDA FoodData Central file into the LOCAL reference tables. LOCAL, or a hosted beta database for loading commands only (scripts/lib/db-target.mjs).
//
//   node scripts/usda-import.mjs <downloaded .zip> [--dry-run]
//
// Only files listed in reference/usda/manifest.json are accepted, and only when their SHA-256
// fingerprint matches. Nothing is downloaded here and nothing outside this computer is contacted.
// It only adds rows: running it again on the same file changes nothing ("unchanged"); a different
// file under the same release name is refused. Reference foods are not shown to anyone: turning one
// into a catalog ingredient goes through the two-person review later (slice N-2).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import pg from "pg";
import { fromFoundationJson, fromSrLegacyCsv, parseCsv } from "./lib/usda-normalize.mjs";
import { prepareRelease, writeRelease } from "./lib/usda-import-lib.mjs";
import { assertTarget } from "./lib/db-target.mjs";

const [zipPath, ...flags] = process.argv.slice(2);
if (!zipPath) throw new Error("Use: node scripts/usda-import.mjs <downloaded .zip> [--dry-run]");
const dryRun = flags.includes("--dry-run");
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, "import", ["import"]);

const manifest = JSON.parse(readFileSync(new URL("../reference/usda/manifest.json", import.meta.url), "utf8"));
const meta = manifest.files.find((f) => f.fileName === basename(zipPath));
if (!meta) throw new Error(`${basename(zipPath)} is not in reference/usda/manifest.json`);
const bytes = readFileSync(zipPath);
const sha = createHash("sha256").update(bytes).digest("hex");
if (sha !== meta.sha256 || bytes.length !== meta.bytes) {
  throw new Error(`Fingerprint mismatch for ${meta.fileName}: expected ${meta.sha256} (${meta.bytes} bytes), got ${sha} (${bytes.length} bytes). Nothing imported.`);
}

const unzip = (inner) => execFileSync("unzip", ["-p", zipPath, inner], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").filter(Boolean);
let raws;
if (meta.format === "json") {
  const inner = listing.find((n) => n.endsWith(".json"));
  raws = fromFoundationJson(JSON.parse(unzip(inner)));
} else {
  const table = (name) => {
    const inner = listing.find((n) => n.endsWith(`/${name}.csv`) || n === `${name}.csv`);
    if (!inner) throw new Error(`${name}.csv missing from ${meta.fileName}`);
    return parseCsv(unzip(inner));
  };
  raws = fromSrLegacyCsv(Object.fromEntries(
    ["food", "food_nutrient", "nutrient", "food_portion", "measure_unit", "food_category", "sr_legacy_food", "food_nutrient_derivation"].map((n) => [n, table(n)]),
  ));
}

const prepared = prepareRelease(meta, raws);
const { refused, ...summary } = prepared.release.report;
console.log(JSON.stringify({ file: meta.fileName, dataset: meta.dataset, release: meta.releaseLabel, contentSha256: prepared.release.contentSha256, ...summary, refusedExamples: refused.slice(0, 5) }, null, 2));
if (dryRun) process.exit(0);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("begin");
  const result = await writeRelease(client, prepared);
  await client.query("commit");
  console.log(JSON.stringify(result));
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`Nothing imported: ${e.message}${e.detail ? ` (${e.detail})` : ""}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
