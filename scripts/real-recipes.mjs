// Real-mode recipes (owner direction 20 Nov 2026 01:06 UTC, journey 9; docs/62). LOCAL ONLY for load (a hosted database gets the recipes from scripts/recipe-bundle.mjs).
//
//   node scripts/real-recipes.mjs load      # adds the 12 original recipes with USDA ingredient nutrition
//   node scripts/real-recipes.mjs status    # read-only: how many are there and how many have a protein figure
//
// The 12 recipes in the demo library were written for this project (nothing copied from a book, site or
// database); only their ingredient numbers were invented. This makes a non-demo copy of each recipe whose
// ingredients carry USDA FoodData Central values per 100 g (public domain, CC0), mapped one by one in
// scripts/real-recipes-usda.json. An ingredient without a USDA match keeps "not known", never zero, so a
// recipe that needs it shows its protein as not known. Per-serving numbers are then calculated from the
// ingredients by the same database function the demo recipes use, with no cooking-loss adjustment.
//
// Dietary and ingredient-family statements are copied from the demo ingredient they replace and labelled a
// curator assessment of the plain ingredient (brands differ; the recipe page says to check labels).
// It never resets or deletes anything. Running it again changes nothing.
import { readFileSync } from "node:fs";
import pg from "pg";
import { assertTarget } from "./lib/db-target.mjs";

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Hosted only with VFP_HOSTED_REF naming the project, and only these commands (scripts/lib/db-target.mjs).
assertTarget(url, process.argv[2], ["status"]);
const MAP = JSON.parse(readFileSync(new URL("./real-recipes-usda.json", import.meta.url), "utf8"));
const LICENSE = "a0000000-0000-4000-8000-00000000b001";
const SOURCE = "a0000000-0000-4000-8000-00000000b101";
const RECORD = "a0000000-0000-4000-8000-00000000b202";
/** The real copy of a demo row has the same last 12 hex digits under the a0000000 prefix. */
const realId = (demo) => `a0000000-0000-4000-8000-${demo.slice(-12)}`;

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (sql, args = []) => client.query(sql, args).then((r) => r.rows);

async function status() {
  const rows = await q(`
    select fr.name, (select nv.value from public.nutrient_values nv where nv.revision_id = fr.id and nv.nutrient_code = 'protein_g') protein
      from public.food_items fi join public.food_revisions fr on fr.id = fi.current_revision_id
     where fi.kind = 'recipe' and not fi.is_demo and fi.id::text like 'a0000000-%' order by fr.name`);
  console.log(JSON.stringify({ recipes: rows.length, withProtein: rows.filter((r) => r.protein !== null).length, list: rows.map((r) => `${r.name}: ${r.protein === null ? "protein not known" : `${Number(r.protein).toFixed(1)} g per serving`}`) }, null, 1));
}

async function columns(table) {
  return (await q("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [table])).map((r) => r.column_name);
}
/** Copy the rows of a per-revision table from a demo revision to its real copy, replacing a few columns. */
async function copyRows(table, key, from, to, replace) {
  const cols = (await columns(table)).filter((c) => c !== "id");
  const exprs = cols.map((c) => (c === key ? "$2::uuid" : (replace[c] ?? c)));
  await q(`insert into public.${table} (${cols.join(", ")}) select ${exprs.join(", ")} from public.${table} where ${key} = $1::uuid`, [from, to]);
}

async function load() {
  const usda = await q("select count(*)::int n from app.usda_foods");
  if (!usda[0].n) throw new Error("USDA reference data is not loaded on this computer (run the private-beta loader with --usda first).");
  const demo = await q(`
    select fi.id item, fr.id rev from public.food_items fi join public.food_revisions fr on fr.id = fi.current_revision_id
     where fi.kind = 'recipe' and fi.is_demo order by fr.name`);
  if (demo.length !== 12) throw new Error(`Expected the 12 demo recipes this copies from; found ${demo.length}.`);
  const done = await q("select count(*)::int n from public.food_items where id = any($1::uuid[])", [demo.map((d) => realId(d.item))]);
  if (done[0].n === 12) {
    console.log("The 12 recipes are already here. Nothing changed.");
    return status();
  }
  if (done[0].n !== 0) throw new Error(`Found ${done[0].n} of the 12 recipes: stopping rather than guessing. Report this.`);

  await client.query("begin");
  try {
    await q(`insert into public.licenses (id, label, checked_at, permitted_uses, attribution)
             values ($1, 'Original recipes written for this project', now(), array['display', 'store', 'derive'], 'Vegetarian Food Platform') on conflict do nothing`, [LICENSE]);
    await q(`insert into public.sources (id, publisher, source_type, license_id, access_scope, is_demo, retrieved_at)
             values ($1, 'Vegetarian Food Platform recipes', 'original_recipe', $2, 'public', false, now()) on conflict do nothing`, [SOURCE, LICENSE]);
    await q(`insert into public.source_records (id, source_id, external_id, observed_at, evidence_summary, rights_status)
             values ($1, $2, 'original-recipes-v1', now(), 'Original recipe written for this project. Ingredient nutrition from USDA FoodData Central per 100 g; per-serving figures calculated, not lab-tested; no cooking-loss adjustment. Dietary notes are a curator assessment of plain ingredients: check packaged labels.', 'cleared')
             on conflict do nothing`, [RECORD, SOURCE]);

    // 1. Ingredients: every ingredient any demo recipe uses, as a real ingredient with USDA values (or unknown).
    const ings = await q(`
      select distinct ri.ingredient_revision_id rev, fr.food_item_id item, fr.name, fr.basis_kind
        from public.recipe_ingredients ri join public.recipe_revisions rr on rr.food_revision_id = ri.recipe_revision_id
        join public.food_revisions fr on fr.id = ri.ingredient_revision_id
       where rr.food_revision_id = any($1::uuid[])`, [demo.map((d) => d.rev)]);
    const defs = (await q("select code from public.nutrient_definitions")).map((r) => r.code);
    let mapped = 0;
    for (const ing of ings) {
      const m = MAP[ing.rev];
      if (!m) throw new Error(`No USDA mapping entry for ${ing.name} (${ing.rev}).`);
      const f = m.fdcId
        ? (await q(`select uf.nutrients, ur.source_record_id from app.usda_foods uf join app.usda_releases ur on ur.id = uf.release_id
                     where uf.fdc_id = $1 and ur.release_label = $2`, [m.fdcId, m.release]))[0]
        : null;
      if (m.fdcId && !f) throw new Error(`USDA food ${m.fdcId} (${m.release}) is not on this computer.`);
      if (f) mapped += 1;
      const item = realId(ing.item);
      const rev = realId(ing.rev);
      await q("insert into public.food_items (id, kind, visibility, status, is_demo) values ($1, 'ingredient', 'public', 'approved', false)", [item]);
      await q(`insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit, description)
               values ($1, $2, 1, $3, 'mass', 100, 'g', $4)`,
        [rev, item, m.name, f ? `USDA FoodData Central ${m.release} release, FDC ID ${m.fdcId}: ${m.usda}.` : `No matching USDA food: nutrition not known. ${m.note ?? ""}`.trim()]);
      for (const code of defs) {
        const v = f?.nutrients?.[code]?.value;
        if (f && v !== undefined && v !== null)
          await q("insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method) values ($1, $2, $3, $4, 'published')", [rev, code, v, f.source_record_id]);
        else
          await q("insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason) values ($1, $2, null, $3, 'unknown', 'not_provided')", [rev, code, f?.source_record_id ?? RECORD]);
      }
      const later = { source_record_id: `case when source_record_id is null then null else '${RECORD}'::uuid end`, checked_at: "now()", expires_at: "now() + interval '365 days'" };
      await copyRows("ingredient_family_statements", "revision_id", ing.rev, rev, later);
      await copyRows("dietary_claims", "revision_id", ing.rev, rev, { ...later, evidence_tier: "'curator_assessment'" });
      await copyRows("allergen_statements", "revision_id", ing.rev, rev, later);
    }

    // 2. Recipes: the same text, servings, steps and substitution groups, with the real ingredients.
    for (const d of demo) {
      const item = realId(d.item);
      const rev = realId(d.rev);
      await q("insert into public.food_items (id, kind, visibility, status, is_demo) values ($1, 'recipe', 'public', 'approved', false)", [item]);
      await q(`insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit, description)
               select $2, $3, 1, regexp_replace(name, '^Demo ', ''), basis_kind, basis_amount, basis_unit, description from public.food_revisions where id = $1`, [d.rev, rev, item]);
      await q(`update public.food_revisions set name = upper(left(name, 1)) || substr(name, 2) where id = $1`, [rev]);
      await copyRows("recipe_revisions", "food_revision_id", d.rev, rev, { rights_record_id: `'${RECORD}'::uuid`, trial_cooked_at: "null" });
      await copyRows("recipe_steps", "recipe_revision_id", d.rev, rev, {});
      await copyRows("portions", "revision_id", d.rev, rev, { source_record_id: `'${RECORD}'::uuid` });
      await copyRows("dietary_claims", "revision_id", d.rev, rev, { source_record_id: `'${RECORD}'::uuid`, checked_at: "now()", expires_at: "now() + interval '365 days'", evidence_tier: "'curator_assessment'" });
      const lines = await columns("recipe_ingredients");
      const exprs = lines.filter((c) => c !== "id").map((c) =>
        c === "recipe_revision_id" ? "$2::uuid"
        : c === "ingredient_revision_id" ? "('a0000000-0000-4000-8000-' || right(ingredient_revision_id::text, 12))::uuid"
        : c === "grams" ? "coalesce(grams, case when unit = 'ml' then quantity end)"
        : c);
      await q(`insert into public.recipe_ingredients (${lines.filter((c) => c !== "id").join(", ")}) select ${exprs.join(", ")} from public.recipe_ingredients where recipe_revision_id = $1`, [d.rev, rev]);
      await q(`insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason, source_record_id, assumptions)
               select $1, n.key, (n.value ->> 'value')::numeric, case when n.value ->> 'value' is null then 'unknown' else 'calculated' end,
                      case when n.value ->> 'value' is null then 'incomplete_recipe' end, $2,
                      'Sum of the USDA values for each ingredient amount, divided by the number of servings. No adjustment for cooking losses.'
                 from jsonb_each(app.recipe_variant_nutrients($1, '{}'::jsonb)) n`, [rev, RECORD]);
    }
    const all = [...ings.map((i) => realId(i.rev)), ...demo.map((d) => realId(d.rev))];
    await q("update public.food_revisions set published_at = now() where id = any($1::uuid[])", [all]);
    await q(`update public.food_items fi set current_revision_id = r.id, status = 'published'
               from public.food_revisions r where r.food_item_id = fi.id and r.id = any($1::uuid[])`, [all]);
    await client.query("commit");
    console.log(`Added 12 recipes and ${ings.length} ingredients (${mapped} with USDA values, ${ings.length - mapped} not known).`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
  await status();
}

try {
  const cmd = process.argv[2];
  if (cmd === "load") await load();
  else if (cmd === "status") await status();
  else throw new Error("Use: load | status");
} finally {
  await client.end();
}
