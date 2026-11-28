// Readiness report for real Boston places (owner 20:42 UTC 16 Nov; dedup 22:03 UTC). Reads researched
// staging entry files, merges entries that describe the same physical location (same street + ZIP),
// and writes a Markdown report: what each location still needs, progress to the first 10 and 50,
// founder-review batches and the sources we cannot use.
// Reads files only: no database, no network, nothing verified, nothing published.
//
//   node scripts/onboarding-readiness.mjs <entries.json>... [--out report.md] [--max-facts 60] [--blockers research-blockers.json]
//     [--batch "Place A|Place B" --batch-out batch.md]   (a founder-review sheet for named locations, grouped by fact type)
//     [--registry scripts/menu-access-registry.json]
// Only facts from sources the access registry clears count (owner 22:37 UTC 17 Nov; docs/46). Facts
// from pending or prohibited sources are held: listed by count, never in readiness or review batches.
import { readFileSync, writeFileSync } from "node:fs";
import { registryIndex, splitByClearance } from "./lib/source-access.mjs";
import { batchSheetMarkdown, coverageSummary, heldSummary, mergeByLocation, placeReadiness, readinessMarkdown, reviewBatches } from "./lib/onboarding-readiness-lib.mjs";

const args = process.argv.slice(2);
const VALUED = ["--out", "--max-facts", "--blockers", "--batch", "--batch-out", "--registry"];
const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const files = args.filter((a, i) => !a.startsWith("--") && !VALUED.includes(args[i - 1]));
if (!files.length) throw new Error("Use: node scripts/onboarding-readiness.mjs <entries.json>... [--out report.md] [--max-facts 60] [--blockers file.json]");

const entries = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).places ?? []);
const index = registryIndex(JSON.parse(readFileSync(flag("--registry") ?? new URL("./menu-access-registry.json", import.meta.url), "utf8")));
// Locations are grouped on every researched address (identity only), then only cleared facts count.
const locations = mergeByLocation(entries).map((l) => {
  const { cleared, held } = splitByClearance(l, index);
  return { ...l, facts: cleared, held };
});
const readiness = locations.map(placeReadiness);
const summary = { ...coverageSummary(entries, locations, readiness), held: heldSummary(locations) };
const blockers = flag("--blockers") ? JSON.parse(readFileSync(flag("--blockers"), "utf8")).blockers ?? [] : [];
const batches = reviewBatches(readiness, Number(flag("--max-facts") ?? 60));
const md = readinessMarkdown(readiness, batches, new Date().toISOString().slice(0, 10), { summary, blockers });
if (flag("--out")) {
  writeFileSync(flag("--out"), md);
  console.log(`Wrote ${flag("--out")}: ${summary.entries} entries, ${summary.locations} unique locations, ${summary.ready} ready for review, ${batches.length} review batches.`);
} else {
  process.stdout.write(md);
}

if (flag("--batch")) {
  const names = flag("--batch").split("|").map((n) => n.trim());
  const chosen = names.map((n) => locations.find((l) => l.label === n || l.entries.includes(n)) ?? (() => { throw new Error(`No researched location named "${n}"`); })());
  const sheet = batchSheetMarkdown(chosen, `Founder-review batch: ${names.join(", ")}`, new Date().toISOString().slice(0, 10));
  if (flag("--batch-out")) { writeFileSync(flag("--batch-out"), sheet); console.log(`Wrote ${flag("--batch-out")}: ${chosen.length} locations.`); } else process.stdout.write(sheet);
}
