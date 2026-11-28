// USDA protein estimates for drafted complete meals, in the LOCAL private staging area (docs/58,
// owner direction 18 Nov 2026 20:56 UTC). LOCAL, or a hosted beta database for loading commands only (scripts/lib/db-target.mjs). Nothing here publishes, verifies or reads the web.
//
//   node scripts/menu-estimates.mjs <estimates.json> --as <curator email> [--dry-run] [--replace]
//
// estimates.json: { "estimates": [
//   { "place", "dish", "evidence": listed_ingredients | dish_name | listed_ingredients_and_dish_name,
//     "assumptions": "...", "lines": [ { label, dataset: sr_legacy | foundation, fdcId, usdaState, weighedAs,
//       amountBasis: typical, grams, gramsLow, gramsHigh, substitutes?: [{label, dataset, fdcId, usdaState}] } ] }
//   | { "place", "dish", "unknownReason": "..." } ] }
// Each estimate becomes a DRAFT nutrition-engine model with typical amounts (never the restaurant's
// quantities) linked to the dish; the database refuses a dish that is not a complete meal, a dish with
// any protein figure from the restaurant, and "listed ingredients" evidence with no listed ingredients on
// file. A dish whose ingredients are not known well enough is linked to "unknown" with the reason.
// The model stays a draft: a second person reviews its assumptions before it can ever be published.
// A dish that already has an estimate is skipped unless --replace is given (the old one stays in history).
// The whole file goes in one transaction: if any entry is refused, nothing is written.
import { readFileSync } from "node:fs";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const [file, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (!file) throw new Error("Use: node scripts/menu-estimates.mjs <estimates.json> --as <curator email> [--dry-run] [--replace]");
const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, "import", ["import"]);

const { estimates } = JSON.parse(readFileSync(file, "utf8"));
const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;
try {
  const email = flag("--as");
  if (!email) throw new Error("--as <email> is required");
  const actor = (await q("select id from auth.users where lower(email) = lower($1)", [email]))[0]?.id;
  if (!actor) throw new Error(`No local account ${email}`);
  // The newest sealed release of each dataset that holds the food.
  const release = async (dataset, fdcId) => {
    const r = (await q(`select r.id from app.usda_releases r join app.usda_foods f on f.release_id = r.id
                         where r.dataset = $1 and f.fdc_id = $2 and r.sealed and r.file_name not like '%demo%'
                         order by r.imported_at desc limit 1`, [dataset, fdcId]))[0];
    if (!r) throw new Error(`USDA ${dataset} food ${fdcId} is not imported here (import the full release first)`);
    return r.id;
  };
  await client.query("begin");
  const counts = { models: 0, unknown: 0, skipped: 0 };
  for (const e of estimates) {
    const dish = (await q(`select d.id from staging.dishes d join staging.places p on p.id = d.place_id
                            where p.label = $1 and d.label = $2`, [e.place, e.dish]));
    if (dish.length !== 1) throw new Error(`${e.place} / ${e.dish}: ${dish.length} staged dishes match (exactly one needed; no fuzzy matching)`);
    const dishId = dish[0].id;
    const has = (await q("select id from staging.current_estimate($1) where id is not null", [dishId])).length > 0;
    if (has && !rest.includes("--replace")) {
      counts.skipped += 1;
      continue;
    }
    let modelId = null;
    if (e.lines) {
      const lines = [];
      for (const l of e.lines) {
        lines.push({
          label: l.label, usdaReleaseId: await release(l.dataset, l.fdcId), fdcId: l.fdcId, usdaState: l.usdaState,
          weighedAs: l.weighedAs ?? l.usdaState, amountBasis: l.amountBasis ?? "typical", grams: l.grams, gramsLow: l.gramsLow, gramsHigh: l.gramsHigh,
          substitutes: await Promise.all((l.substitutes ?? []).map(async (s) => ({
            label: s.label, usdaReleaseId: await release(s.dataset, s.fdcId), fdcId: s.fdcId, usdaState: s.usdaState,
          }))),
        });
      }
      modelId = (await q("select app.nie_create_model($1, $2::jsonb) as id", [actor, JSON.stringify({
        label: `USDA estimate: ${e.dish} (${e.place})`.slice(0, 200), quantityBasis: "editorial_typical", servingBasis: "typical",
        assumptions: e.assumptions, lines,
      })]))[0].id;
      counts.models += 1;
    } else {
      counts.unknown += 1;
    }
    await q("select staging.link_dish_estimate($1, $2, $3, $4, $5)", [actor, dishId, modelId, e.lines ? e.evidence : null, e.lines ? null : e.unknownReason]);
  }
  if (rest.includes("--dry-run")) {
    await client.query("rollback");
    console.log(`Dry run: ${counts.models} models and ${counts.unknown} unknown accepted, ${counts.skipped} skipped. Nothing was written.`);
  } else {
    await client.query("commit");
    console.log(`Recorded ${counts.models} draft models and ${counts.unknown} unknown; ${counts.skipped} dishes already had an estimate.`);
  }
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(`Nothing written: ${e.message}${e.detail ? ` (${e.detail})` : ""}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
