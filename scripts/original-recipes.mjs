// Recipe library v2: 38 more original recipes with USDA ingredient nutrition. LOCAL ONLY for load (a hosted database gets the recipes from scripts/recipe-bundle.mjs).
//
//   node scripts/original-recipes.mjs load      # adds the recipes in data/recipes/original-v2.json
//   node scripts/original-recipes.mjs status    # read-only: what is there, with protein and vegan counts
//
// Every recipe was written for this project (nothing copied or paraphrased from a book, site or database).
// Each ingredient is either one of the real ingredients scripts/real-recipes.mjs already added (reused, not
// duplicated) or a new real ingredient with USDA FoodData Central SR Legacy 2018-04 values per 100 g
// (public domain, CC0). A value USDA does not give stays "not known", never zero. Per-serving numbers are
// calculated from the ingredients by app.recipe_variant_nutrients, exactly as scripts/real-recipes.mjs does,
// with no cooking-loss adjustment. Dietary statements are derived from the plain ingredients only and are
// labelled a curator assessment, valid 365 days; nothing here says anything is safe for an allergy.
//
// Run scripts/real-recipes.mjs load first. This never resets, deletes or changes a row it did not add; every
// row it adds has an id under a0380000-0000-4000-8000-. Running it again changes nothing.
import { readFileSync } from "node:fs";
import pg from "pg";
import { load, status } from "./lib/original-recipes.mjs";
import { assertTarget } from "./lib/db-target.mjs";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, process.argv[2], ["status"]);
const DATA = JSON.parse(readFileSync(new URL("../data/recipes/original-v2.json", import.meta.url), "utf8"));

const client = new pg.Client({ connectionString: url });
await client.connect();
/** @param {string} sql @param {unknown[]} [args] */
const q = (sql, args = []) => client.query(sql, args).then((r) => r.rows);

async function run() {
  const usda = await q("select count(*)::int n from app.usda_foods uf join app.usda_releases ur on ur.id = uf.release_id where ur.release_label = '2018-04' and ur.dataset = 'sr_legacy'");
  if (!usda[0].n) throw new Error("USDA SR Legacy 2018-04 is not loaded on this computer (run the private-beta loader with --usda first).");
  await client.query("begin");
  try {
    const added = await load(q, DATA);
    await client.query("commit");
    console.log(added.newRecipes || added.newIngredients
      ? `Added ${added.newRecipes} recipes and ${added.newIngredients} new ingredients (${added.mapped} with USDA values).`
      : `All ${DATA.recipes.length} recipes are already here. Nothing changed.`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

try {
  const cmd = process.argv[2];
  if (cmd === "load") await run();
  else if (cmd !== "status") throw new Error("Use: load | status");
  console.log(JSON.stringify(await status(q), null, 1));
} finally {
  await client.end();
}
