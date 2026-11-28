// Shared logic for scripts/original-recipes.mjs and its tests (docs/62 section 3, recipe library v2).
//
// The 38 recipes in data/recipes/original-v2.json were written for this project. Each ingredient names a
// USDA FoodData Central food (per 100 g, public domain) or reuses one of the real ingredients that
// scripts/real-recipes.mjs already added. Nothing here resets, deletes or changes a row it did not add:
// a recipe or ingredient that is already present is left exactly as it is.
import { createHash } from "node:crypto";

/** Every row this loader adds has an id under this prefix. Nothing else in the database uses it. */
export const PREFIX = "a0380000-0000-4000-8000-";
/** The licence and source rows scripts/real-recipes.mjs uses for the original recipes (same publisher). */
export const LICENSE = "a0000000-0000-4000-8000-00000000b001";
export const SOURCE = "a0000000-0000-4000-8000-00000000b101";
export const RECORD = `${PREFIX}000000000001`;
export const RELEASE = "2018-04";
export const FAMILIES = ["egg", "dairy", "honey", "gelatin", "animal_stock", "fish_sauce", "animal_rennet"];
const NON_VEGAN = new Set(FAMILIES);
const NON_VEGETARIAN = new Set(["gelatin", "animal_stock", "fish_sauce", "animal_rennet"]);
const ALLERGENS = new Set(["milk", "egg", "peanut", "tree_nut", "soy", "wheat", "sesame", "fish", "shellfish", "mustard", "celery", "lupin", "sulfite", "gluten"]);
const PRESENCE = new Set(["present", "unknown"]);
const OUTCOMES = ["compatible", "conditional", "unknown", "incompatible"];
export const CUISINES = ["indian", "asian", "mediterranean", "middle_eastern", "mexican", "italian", "east_african", "american", "everyday"];
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

/**
 * A fixed id for one row: the prefix, a two-digit kind and ten hex digits of a hash of the row's key.
 * Kinds: 11 ingredient item, 12 ingredient revision, 21 recipe item, 22 recipe revision, 31 recipe line,
 * 32 recipe step, 33 portion.
 * @param {string} kind
 * @param {string} key
 */
export const fixedId = (kind, key) => `${PREFIX}${kind}${createHash("sha256").update(`${kind}:${key}`).digest("hex").slice(0, 10)}`;

/**
 * @param {string} key
 * @param {any} ing
 */
export const ingredientRevisionId = (key, ing) => ing.reuse ?? fixedId("12", key);

/**
 * The plain ingredient's diet outcomes, as written in the data (absent means compatible).
 * @param {any} ing
 */
export function ingredientDiets(ing) {
  return { vegan: ing.diets?.vegan ?? "compatible", vegetarian: ing.diets?.vegetarian ?? "compatible" };
}

/**
 * A recipe's dietary statements, derived only from the plain ingredients it uses as written (the
 * default of every substitution group): the least compatible ingredient decides, and a conditional
 * outcome carries the ingredients' own label advice.
 * @param {any} recipe
 * @param {Record<string, any>} ingredients
 */
export function deriveDiet(recipe, ingredients) {
  /** @type {Record<string, { outcome: string, modifications: string | null }>} */
  const out = {};
  for (const diet of ["vegan", "vegetarian"]) {
    let rank = 0;
    const notes = new Set();
    for (const line of recipe.ingredients) {
      if (line.default === false) continue;
      const ing = ingredients[line.ingredient];
      const o = ingredientDiets(ing)[diet];
      rank = Math.max(rank, OUTCOMES.indexOf(o));
      if (o === "conditional" && ing.modifications) notes.add(ing.modifications);
    }
    const outcome = OUTCOMES[rank];
    out[diet] = { outcome, modifications: outcome === "conditional" ? [...notes].join(" ") : null };
  }
  return out;
}

const WORDS = [
  // A word in an ingredient's name that suggests an animal family, unless the name also says it is plant-based.
  { re: /\beggs?\b/i, family: "egg" },
  { re: /\b(milk|cheese|cheddar|feta|ricotta|paneer|yogurt|yoghurt|cream|butter|ghee|whey)\b/i, family: "dairy" },
  { re: /\bhoney\b/i, family: "honey" },
];
const PLANT = /\b(soy|coconut|peanut|almond|oat|vegan|plant)\b/i;

/**
 * Checks the recipe data without a database. Returns a list of problems (empty when all is well).
 * @param {any} data
 */
export function validate(data) {
  const problems = [];
  const bad = (/** @type {string} */ m) => problems.push(m);
  const ings = data.ingredients ?? {};
  for (const [key, ing] of Object.entries(/** @type {Record<string, any>} */ (ings))) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) bad(`ingredient key ${key}`);
    if (!ing.name || ing.name.length > 200) bad(`${key}: name`);
    if (ing.reuse !== undefined && !/^a0000000-0000-4000-8000-0000004200[0-9]{2}$/.test(ing.reuse)) bad(`${key}: reuse must name a real-recipes ingredient revision`);
    if (ing.reuse === undefined) {
      if (!Number.isInteger(ing.fdcId) || ing.fdcId <= 0) bad(`${key}: a new ingredient needs a USDA FDC ID`);
      if (ing.release !== RELEASE) bad(`${key}: a new ingredient must come from the SR Legacy ${RELEASE} release`);
      if (!ing.usda) bad(`${key}: USDA description`);
    } else if (ing.fdcId === null && ing.release !== null) bad(`${key}: no FDC ID but a release`);
    for (const [f, p] of Object.entries(ing.families ?? {})) {
      if (!FAMILIES.includes(f) || !PRESENCE.has(/** @type {string} */ (p))) bad(`${key}: family ${f}=${p}`);
    }
    for (const [a, p] of Object.entries(ing.allergens ?? {})) {
      if (!ALLERGENS.has(a) || !PRESENCE.has(/** @type {string} */ (p))) bad(`${key}: allergen ${a}=${p}`);
    }
    const d = ingredientDiets(ing);
    for (const [diet, o] of Object.entries(d)) if (!OUTCOMES.includes(o)) bad(`${key}: ${diet}=${o}`);
    if ((d.vegan === "conditional" || d.vegetarian === "conditional") && !ing.modifications) bad(`${key}: conditional needs label advice`);
    const present = Object.entries(ing.families ?? {}).filter(([, p]) => p === "present").map(([f]) => f);
    const unsure = Object.entries(ing.families ?? {}).filter(([, p]) => p === "unknown").map(([f]) => f);
    if (present.some((f) => NON_VEGAN.has(f)) && d.vegan !== "incompatible") bad(`${key}: contains an animal family but is not marked incompatible with vegan`);
    if (present.some((f) => NON_VEGETARIAN.has(f)) && d.vegetarian !== "incompatible") bad(`${key}: not vegetarian`);
    if (unsure.some((f) => NON_VEGAN.has(f)) && d.vegan === "compatible") bad(`${key}: an unknown animal family cannot be vegan-compatible`);
    if (unsure.some((f) => NON_VEGETARIAN.has(f)) && d.vegetarian === "compatible") bad(`${key}: an unknown non-vegetarian family cannot be vegetarian-compatible`);
    if (!PLANT.test(ing.name)) {
      for (const w of WORDS) if (w.re.test(ing.name) && ing.families?.[w.family] !== "present") bad(`${key}: the name says ${w.family} but the family is not present`);
    }
    if ((ing.families?.egg === "present") !== (ing.allergens?.egg === "present")) bad(`${key}: egg family and egg allergen disagree`);
    if ((ing.families?.dairy === "present") !== (ing.allergens?.milk === "present")) bad(`${key}: dairy family and milk allergen disagree`);
  }

  const recipes = data.recipes ?? [];
  const names = new Set();
  const slugs = new Set();
  for (const r of recipes) {
    const at = r.slug ?? r.name;
    if (!/^[a-z0-9-]{3,80}$/.test(r.slug ?? "")) bad(`${at}: slug`);
    if (slugs.has(r.slug)) bad(`${at}: duplicate slug`);
    slugs.add(r.slug);
    const n = String(r.name ?? "").trim().toLowerCase();
    if (!n || n.length > 200) bad(`${at}: name`);
    if (names.has(n)) bad(`${at}: duplicate name`);
    names.add(n);
    if (!r.description || r.description.length > 4000) bad(`${at}: description`);
    if (!(r.servings > 0)) bad(`${at}: servings must be more than 0`);
    if (!Number.isInteger(r.prepMinutes) || r.prepMinutes < 0 || !Number.isInteger(r.cookMinutes) || r.cookMinutes < 0) bad(`${at}: minutes`);
    if (!CUISINES.includes(r.cuisine)) bad(`${at}: cuisine ${r.cuisine}`);
    if (!Array.isArray(r.mealTypes) || !r.mealTypes.length || r.mealTypes.some((/** @type {string} */ m) => !MEAL_TYPES.includes(m))) bad(`${at}: meal types`);
    if (!Array.isArray(r.equipment)) bad(`${at}: equipment`);
    if (r.servingNote && r.servingNote.length > 200) bad(`${at}: serving note`);
    if (!Array.isArray(r.ingredients) || r.ingredients.length < 2) bad(`${at}: ingredients`);
    /** @type {Record<string, number>} */
    const defaults = {};
    const used = new Set();
    for (const l of r.ingredients ?? []) {
      const ing = ings[l.ingredient];
      if (!ing) bad(`${at}: unknown ingredient ${l.ingredient}`);
      if (!(l.quantity > 0)) bad(`${at}: ${l.ingredient} quantity`);
      if (!(l.grams > 0)) bad(`${at}: ${l.ingredient} grams must be more than 0`);
      if (typeof l.unit !== "string" || !l.unit) bad(`${at}: ${l.ingredient} unit`);
      if (l.prep && l.prep.length > 200) bad(`${at}: ${l.ingredient} prep note`);
      if (l.note && l.note.length > 300) bad(`${at}: ${l.ingredient} substitution note`);
      if (l.group !== undefined) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(l.group)) bad(`${at}: group ${l.group}`);
        defaults[l.group] = (defaults[l.group] ?? 0) + (l.default === false ? 0 : 1);
        if (l.default === false && !l.note) bad(`${at}: ${l.ingredient} alternative needs a note`);
      } else if (l.default === false) bad(`${at}: ${l.ingredient} is an alternative without a group`);
      if (l.default !== false) {
        if (used.has(l.ingredient)) bad(`${at}: ${l.ingredient} listed twice`);
        used.add(l.ingredient);
      }
    }
    for (const [g, n2] of Object.entries(defaults)) if (n2 !== 1) bad(`${at}: group ${g} needs exactly one default`);
    if (!Array.isArray(r.steps) || r.steps.length < 2) bad(`${at}: steps`);
    for (const s of r.steps ?? []) {
      if (!s.text || s.text.length > 2000) bad(`${at}: step text`);
      if (s.title && s.title.length > 80) bad(`${at}: step title`);
      if (s.timer !== undefined && !(Number.isInteger(s.timer) && s.timer > 0)) bad(`${at}: step timer`);
    }
    if (ings && r.ingredients?.every((/** @type {any} */ l) => ings[l.ingredient])) {
      const d = deriveDiet(r, ings);
      for (const diet of ["vegan", "vegetarian"]) {
        if (r.diet?.[diet] !== d[diet].outcome) bad(`${at}: ${diet} says ${r.diet?.[diet]} but the ingredients give ${d[diet].outcome}`);
        if ((r.diet?.modifications?.[diet] ?? null) !== d[diet].modifications) bad(`${at}: ${diet} label advice does not match the ingredients`);
      }
    }
  }
  return problems;
}

/**
 * @typedef {(sql: string, args?: unknown[]) => Promise<any[]>} Query
 */

/**
 * Adds what is missing, inside the caller's transaction. Returns what it added.
 * @param {Query} q
 * @param {any} data
 */
export async function load(q, data) {
  const problems = validate(data);
  if (problems.length) throw new Error(`The recipe data has problems:\n${problems.join("\n")}`);
  const ings = /** @type {Record<string, any>} */ (data.ingredients);

  // Reused ingredients come from scripts/real-recipes.mjs: they must be there, published, with the same USDA food.
  const reuse = Object.entries(ings).filter(([, i]) => i.reuse);
  const found = await q(
    `select fr.id::text id, fr.description from public.food_revisions fr join public.food_items fi on fi.id = fr.food_item_id
      where fr.id = any($1::uuid[]) and fi.kind = 'ingredient' and not fi.is_demo and fi.status = 'published' and fi.current_revision_id = fr.id`,
    [reuse.map(([, i]) => i.reuse)],
  );
  const byId = new Map(found.map((r) => [r.id, r.description ?? ""]));
  for (const [key, i] of reuse) {
    if (!byId.has(i.reuse)) throw new Error(`The real ingredient ${i.name} (${key}) is not here: run "node scripts/real-recipes.mjs load" first.`);
    const fdc = /FDC ID (\d+)/.exec(byId.get(i.reuse) ?? "")?.[1] ?? null;
    if (String(fdc) !== String(i.fdcId)) throw new Error(`${i.name} (${key}) here uses FDC ID ${fdc}, the data says ${i.fdcId}. Stopping.`);
  }

  // A recipe name already used by another published real recipe would be confusing: stop rather than guess.
  const clash = await q(
    `select fr.name from public.food_items fi join public.food_revisions fr on fr.id = fi.current_revision_id
      where fi.kind = 'recipe' and not fi.is_demo and fi.id::text not like $2 and lower(fr.name) = any($1::text[])`,
    [data.recipes.map((/** @type {any} */ r) => r.name.toLowerCase()), `${PREFIX}%`],
  );
  if (clash.length) throw new Error(`Another recipe already has the name ${clash.map((c) => c.name).join(", ")}. Stopping.`);

  await q(`insert into public.licenses (id, label, checked_at, permitted_uses, attribution)
           values ($1, 'Original recipes written for this project', now(), array['display', 'store', 'derive'], 'Vegetarian Food Platform') on conflict do nothing`, [LICENSE]);
  await q(`insert into public.sources (id, publisher, source_type, license_id, access_scope, is_demo, retrieved_at)
           values ($1, 'Vegetarian Food Platform recipes', 'original_recipe', $2, 'public', false, now()) on conflict do nothing`, [SOURCE, LICENSE]);
  await q(`insert into public.source_records (id, source_id, external_id, observed_at, evidence_summary, rights_status)
           values ($1, $2, 'original-recipes-v2', now(), 'Original recipe written for this project (library v2). Ingredient nutrition from USDA FoodData Central per 100 g; per-serving figures calculated, not lab-tested; no cooking-loss adjustment. Dietary notes are a curator assessment of plain ingredients: check packaged labels.', 'cleared')
           on conflict do nothing`, [RECORD, SOURCE]);

  const defs = (await q("select code from public.nutrient_definitions order by code")).map((r) => r.code);
  const fresh = [];
  let newIngredients = 0;
  let mapped = 0;

  // 1. New ingredients, each with its USDA values per 100 g (or "not known", never zero).
  for (const [key, i] of Object.entries(ings)) {
    if (i.reuse) continue;
    const item = fixedId("11", key);
    const rev = fixedId("12", key);
    if ((await q("select 1 from public.food_items where id = $1", [item])).length) continue;
    const f = (await q(
      `select uf.nutrients, ur.source_record_id from app.usda_foods uf join app.usda_releases ur on ur.id = uf.release_id
        where uf.fdc_id = $1 and ur.release_label = $2 and ur.dataset = 'sr_legacy'
        order by (ur.file_name like '%demo_excerpt%'), ur.id limit 1`, [i.fdcId, i.release]))[0];
    if (!f) throw new Error(`USDA food ${i.fdcId} (${i.release}) for ${i.name} is not on this computer (load the full SR Legacy release first).`);
    await q("insert into public.food_items (id, kind, visibility, status, is_demo) values ($1, 'ingredient', 'public', 'approved', false)", [item]);
    await q(`insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit, description)
             values ($1, $2, 1, $3, 'mass', 100, 'g', $4)`, [rev, item, i.name, `USDA FoodData Central ${i.release} release, FDC ID ${i.fdcId}: ${i.usda}.`]);
    let any = false;
    for (const code of defs) {
      const v = f.nutrients?.[code]?.value;
      if (v !== undefined && v !== null) {
        any = true;
        await q("insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method) values ($1, $2, $3, $4, 'published')", [rev, code, v, f.source_record_id]);
      } else {
        await q("insert into public.nutrient_values (revision_id, nutrient_code, value, source_record_id, method, missing_reason) values ($1, $2, null, $3, 'unknown', 'not_provided')", [rev, code, f.source_record_id]);
      }
    }
    if (any) mapped += 1;
    for (const fam of FAMILIES) {
      await q(`insert into public.ingredient_family_statements (revision_id, family, presence, source_record_id, checked_at, expires_at)
               values ($1, $2, $3, $4, now(), now() + interval '365 days')`, [rev, fam, i.families?.[fam] ?? "absent_by_statement", RECORD]);
    }
    for (const [a, p] of Object.entries(i.allergens ?? {})) {
      await q("insert into public.allergen_statements (revision_id, allergen, presence, cross_contact, source_record_id, checked_at) values ($1, $2, $3, 'unknown', $4, now())", [rev, a, p, RECORD]);
    }
    const d = ingredientDiets(i);
    for (const diet of ["vegan", "vegetarian"]) {
      await q(`insert into public.dietary_claims (revision_id, diet, outcome, evidence_tier, source_record_id, modifications, checked_at, expires_at)
               values ($1, $2, $3, 'curator_assessment', $4, $5, now(), now() + interval '365 days')`,
        [rev, diet, d[diet], RECORD, d[diet] === "conditional" ? i.modifications : null]);
    }
    fresh.push(rev);
    newIngredients += 1;
  }

  // 2. Recipes: text, servings, times, steps, ingredient lines with grams, substitution groups, diet statements.
  let newRecipes = 0;
  const recipeRevs = [];
  for (const r of data.recipes) {
    const item = fixedId("21", r.slug);
    const rev = fixedId("22", r.slug);
    if ((await q("select 1 from public.food_items where id = $1", [item])).length) continue;
    await q("insert into public.food_items (id, kind, visibility, status, is_demo) values ($1, 'recipe', 'public', 'approved', false)", [item]);
    await q(`insert into public.food_revisions (id, food_item_id, revision_no, name, basis_kind, basis_amount, basis_unit, description)
             values ($1, $2, 1, $3, 'serving', 1, 'serving', $4)`, [rev, item, r.name, r.description]);
    await q(`insert into public.recipe_revisions (food_revision_id, yield_servings, prep_minutes, cook_minutes, equipment, rights_record_id, meal_types, cuisine, serving_note)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [rev, r.servings, r.prepMinutes, r.cookMinutes, r.equipment, RECORD, r.mealTypes, r.cuisine, r.servingNote ?? null]);
    for (const [n, s] of r.steps.entries()) {
      await q("insert into public.recipe_steps (id, recipe_revision_id, ordinal, instruction, timer_seconds, title) values ($1, $2, $3, $4, $5, $6)",
        [fixedId("32", `${r.slug}:${n + 1}`), rev, n + 1, s.text, s.timer ?? null, s.title ?? null]);
    }
    await q("insert into public.portions (id, revision_id, label, amount, unit, source_record_id) values ($1, $2, '1 serving', 1, 'serving', $3)", [fixedId("33", r.slug), rev, RECORD]);
    for (const [n, l] of r.ingredients.entries()) {
      const alt = l.default === false;
      await q(`insert into public.recipe_ingredients (id, recipe_revision_id, ingredient_revision_id, position, quantity, unit, grams, optional, included_by_default, substitution_group, prep_note, substitution_note)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [fixedId("31", `${r.slug}:${n + 1}`), rev, ingredientRevisionId(l.ingredient, ings[l.ingredient]), n + 1, l.quantity, l.unit, l.grams, alt, !alt, l.group ?? null, l.prep ?? null, l.note ?? null]);
    }
    const d = deriveDiet(r, ings);
    for (const diet of ["vegan", "vegetarian"]) {
      await q(`insert into public.dietary_claims (revision_id, diet, outcome, evidence_tier, source_record_id, modifications, checked_at, expires_at)
               values ($1, $2, $3, 'curator_assessment', $4, $5, now(), now() + interval '365 days')`,
        [rev, diet, d[diet].outcome, RECORD, d[diet].modifications]);
    }
    recipeRevs.push(rev);
    newRecipes += 1;
  }
  // Per-serving numbers, by the same database function and in the same way as scripts/real-recipes.mjs.
  for (const rev of recipeRevs) {
    await q(`insert into public.nutrient_values (revision_id, nutrient_code, value, method, missing_reason, source_record_id, assumptions)
             select $1, n.key, (n.value ->> 'value')::numeric, case when n.value ->> 'value' is null then 'unknown' else 'calculated' end,
                    case when n.value ->> 'value' is null then 'incomplete_recipe' end, $2,
                    'Sum of the USDA values for each ingredient amount, divided by the number of servings. No adjustment for cooking losses.'
               from jsonb_each(app.recipe_variant_nutrients($1, '{}'::jsonb)) n`, [rev, RECORD]);
  }
  const all = [...fresh, ...recipeRevs];
  if (all.length) {
    await q("update public.food_revisions set published_at = now() where id = any($1::uuid[]) and published_at is null", [all]);
    await q(`update public.food_items fi set current_revision_id = r.id, status = 'published'
               from public.food_revisions r where r.food_item_id = fi.id and r.id = any($1::uuid[])`, [all]);
  }
  return { newRecipes, newIngredients, mapped };
}

/**
 * Read-only summary of what this loader has added.
 * @param {Query} q
 */
export async function status(q) {
  const rows = await q(`
    select fr.name, rr.cuisine, rr.meal_types,
           (select nv.value from public.nutrient_values nv where nv.revision_id = fr.id and nv.nutrient_code = 'protein_g') protein,
           (select dc.outcome from public.dietary_claims dc where dc.revision_id = fr.id and dc.diet = 'vegan') vegan,
           fi.status, fi.is_demo
      from public.food_items fi join public.food_revisions fr on fr.id = fi.current_revision_id
      join public.recipe_revisions rr on rr.food_revision_id = fr.id
     where fi.kind = 'recipe' and fi.id::text like $1 order by fr.name`, [`${PREFIX}%`]);
  const ing = await q(`
    select count(*)::int n,
           count(*) filter (where exists (select 1 from public.nutrient_values nv where nv.revision_id = fr.id and nv.nutrient_code = 'protein_g' and nv.value is not null))::int mapped
      from public.food_items fi join public.food_revisions fr on fr.id = fi.current_revision_id
     where fi.kind = 'ingredient' and fi.id::text like $1`, [`${PREFIX}%`]);
  return {
    recipes: rows.length,
    published: rows.filter((r) => r.status === "published" && !r.is_demo).length,
    vegan: rows.filter((r) => r.vegan === "compatible").length,
    withProtein: rows.filter((r) => r.protein !== null).length,
    highProtein: rows.filter((r) => r.protein !== null && Number(r.protein) >= 20).length,
    newIngredients: ing[0].n,
    newIngredientsWithUsda: ing[0].mapped,
    list: rows.map((r) => `${r.name} [${r.cuisine}; ${r.meal_types.join(", ")}${r.vegan === "compatible" ? "; vegan" : ""}]: ${r.protein === null ? "protein not known" : `${Number(r.protein).toFixed(1)} g protein per serving`}`),
  };
}
