// NIE N-5: ten SYNTHETIC Boston-style demo dishes, worked through the nutrition engine end to end
// (docs/24 section 4, N-5). Every dish is marked is_demo = true and named "Demo ...": none is a real
// restaurant's dish and no figure is a real restaurant's figure. Ingredient reference values are real
// USDA SR Legacy (2018-04) values, public domain, from tests/fixtures/usda/sr-boston-demo.
//
// The four kinds of protein figure stay apart:
//   calculated       quantities stated by the (demo) restaurant or weighed by us
//   estimated range  a typical recipe, hidden unless the visitor turns estimates on
//   unknown          an ingredient cannot be converted (no yield factor): no number at all
//   published        the (demo) restaurant's own figure; our calculation is compared with it and a
//                    gap over 25 % goes to a person; the published figure is still what is shown
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fromSrLegacyCsv, parseCsv } from "./usda-normalize.mjs";
import { prepareRelease, writeRelease } from "./usda-import-lib.mjs";

// Run from the project folder (as every script and test here is). No import.meta: the browser tests
// load this file through a CommonJS transform.
export const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/usda/sr-boston-demo");
export const FIXTURE_META = {
  dataset: "sr_legacy",
  releaseLabel: "2018-04",
  fileName: "FoodData_Central_sr_legacy_food_csv_2018-04_demo_excerpt.zip",
  sha256: "5".repeat(64),
  sourceUrl: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip",
};

export const VENUES = {
  central: "00000000-0000-4000-8000-00000000c001",
  davis: "00000000-0000-4000-8000-00000000c002",
  backBay: "00000000-0000-4000-8000-00000000c003",
};

// USDA SR Legacy protein per 100 g (fixture values): see the comment beside each line.
const F = {
  chickpeasCooked: 173757, // 8.86
  blackBeansCooked: 173735, // 8.86
  quinoaCooked: 168917, // 4.4
  tempehCooked: 172467, // 19.91
  edamame: 168411, // 11.91
  peanutButter: 172470, // 22.21
  broccoliCooked: 169967, // 2.38
  spinachRaw: 168462, // 2.86
  hummus: 174289, // 7.78
  eggBoiled: 173424, // 12.58
  feta: 173420, // 14.21
  pita: 174916, // 9.8
  sweetPotato: 168483, // 2.01
  tortilla: 173242, // 8.7
  tahini: 168604, // 17.4
  lentilsRaw: 172420, // 24.63
  riceCooked: 168878, // 2.69
  tofuFirm: 172475, // 17.27
};

const line = (label, fdcId, grams, o = {}) => ({ label, fdcId, usdaState: "cooked", weighedAs: "cooked", amountBasis: "stated", grams, ...o });
const raw = { usdaState: "raw", weighedAs: "raw" };

// Each dish: expected protein worked out by hand (grams × protein per 100 g ÷ 100).
export const DISHES = [
  {
    id: "00000000-0000-4000-8000-0000000e5001", name: "Demo chickpea and quinoa bowl", venue: "central",
    model: { quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [
      line("Cooked chickpeas", F.chickpeasCooked, 150), line("Cooked quinoa", F.quinoaCooked, 120),
      line("Hummus", F.hummus, 40, { usdaState: "as_sold", weighedAs: "as_sold" }), line("Tahini", F.tahini, 15, { usdaState: "as_sold", weighedAs: "as_sold" })] },
    // 13.29 + 5.28 + 3.112 + 2.61
    expect: { state: "calculated", value: 24.292 },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5002", name: "Demo black bean burrito", venue: "davis",
    model: { quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [
      line("Flour tortilla", F.tortilla, 70, { usdaState: "as_sold", weighedAs: "as_sold" }), line("Cooked black beans", F.blackBeansCooked, 120),
      line("Cooked white rice", F.riceCooked, 100)] },
    // 6.09 + 10.632 + 2.69
    expect: { state: "calculated", value: 19.412 },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5003", name: "Demo tempeh and broccoli stir-fry", venue: "backBay",
    model: { quantityBasis: "restaurant_verified", servingBasis: "measured", lines: [
      line("Cooked tempeh", F.tempehCooked, 120, { amountBasis: "measured" }), line("Cooked broccoli", F.broccoliCooked, 100, { amountBasis: "measured" }),
      line("Cooked white rice", F.riceCooked, 150, { amountBasis: "measured" })] },
    // 23.892 + 2.38 + 4.035
    expect: { state: "calculated", value: 30.307 },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5004", name: "Demo red lentil and spinach soup", venue: "central",
    model: { quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [
      line("Lentils, weighed cooked", F.lentilsRaw, 250, { usdaState: "raw", weighedAs: "cooked", yieldFactor: 2.5, yieldSource: "USDA yield table (lentils, boiled)" }),
      line("Fresh spinach", F.spinachRaw, 30, raw)] },
    // 250 g cooked ÷ 2.5 = 100 g raw × 24.63 = 24.63; spinach 0.858
    expect: { state: "calculated", value: 25.488 },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5005", name: "Demo lentil and rice plate", venue: "davis",
    model: { quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [
      line("Lentils, weighed cooked (no conversion on file)", F.lentilsRaw, 200, { usdaState: "raw", weighedAs: "cooked" }),
      line("Cooked white rice", F.riceCooked, 150)] },
    // Weighed cooked against a raw reference with no yield factor: unknown, never a guess.
    expect: { state: "unknown", value: null },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5006", name: "Demo edamame side", venue: "backBay",
    model: { quantityBasis: "editorial_typical", servingBasis: "stated", assumptions: "Synthetic typical portion: 80 to 120 g of shelled edamame.",
      lines: [line("Edamame", F.edamame, 100, { amountBasis: "typical", gramsLow: 80, gramsHigh: 120 })] },
    // 11.91 (9.528–14.292); 14.292 ÷ 9.528 = 1.5 → medium
    expect: { state: "estimated_range", value: 11.91, low: 9.528, high: 14.292, confidence: "medium" },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5007", name: "Demo hummus and pita plate", venue: "central",
    model: { quantityBasis: "editorial_typical", servingBasis: "stated", assumptions: "Synthetic typical plate: 60 to 100 g hummus, one or two small pitas.",
      lines: [line("Hummus", F.hummus, 80, { usdaState: "as_sold", weighedAs: "as_sold", amountBasis: "typical", gramsLow: 60, gramsHigh: 100 }),
              line("Whole-wheat pita", F.pita, 64, { usdaState: "as_sold", weighedAs: "as_sold", amountBasis: "typical", gramsLow: 50, gramsHigh: 80 })] },
    // 6.224 + 6.272 = 12.496; low 4.668 + 4.9 = 9.568; high 7.78 + 7.84 = 15.62; ratio 1.63 → low
    expect: { state: "estimated_range", value: 12.496, low: 9.568, high: 15.62, confidence: "low" },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5008", name: "Demo sweet potato and chickpea bowl", venue: "backBay",
    model: { quantityBasis: "editorial_typical", servingBasis: "typical", servingFactorLow: 0.9, servingFactorHigh: 1.1,
      assumptions: "Synthetic typical bowl; chickpeas may be swapped for black beans; bowls vary by about 10 %.",
      lines: [line("Cooked chickpeas", F.chickpeasCooked, 130, { amountBasis: "typical", gramsLow: 110, gramsHigh: 150,
                substitutes: [{ label: "Cooked black beans", fdcId: F.blackBeansCooked, usdaState: "cooked" }] }),
              line("Baked sweet potato", F.sweetPotato, 150)] },
    // 11.518 + 3.015 = 14.533; low (9.746 + 3.015) × 0.9 = 11.4849; high (13.29 + 3.015) × 1.1 = 17.9355; ratio 1.56 → low
    expect: { state: "estimated_range", value: 14.533, low: 11.4849, high: 17.9355, confidence: "low" },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5009", name: "Demo egg, spinach and feta wrap", venue: "davis", published: 22,
    model: { quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [
      line("Flour tortilla", F.tortilla, 70, { usdaState: "as_sold", weighedAs: "as_sold" }), line("Hard-boiled egg", F.eggBoiled, 100),
      line("Fresh spinach", F.spinachRaw, 30, raw), line("Feta", F.feta, 30, { usdaState: "as_sold", weighedAs: "as_sold" })] },
    // Calculated 6.09 + 12.58 + 0.858 + 4.263 = 23.791 vs published 22: gap 8.1 % → no review; 22 g shown
    expect: { state: "restaurant_published", value: 22, calculated: 23.791, needsReview: false },
  },
  {
    id: "00000000-0000-4000-8000-0000000e5010", name: "Demo tofu scramble", venue: "central", published: 18,
    model: { quantityBasis: "restaurant_verified", servingBasis: "stated", lines: [
      line("Firm tofu", F.tofuFirm, 150, raw), line("Fresh spinach", F.spinachRaw, 30, raw)] },
    // Calculated 25.905 + 0.858 = 26.763 vs published 18: gap 48.7 % → a person checks; 18 g still shown
    expect: { state: "restaurant_published", value: 18, calculated: 26.763, needsReview: true },
  },
];

const DEMO_RECORD = "00000000-0000-4000-8000-00000000b201";
const one = async (c, sql, p = []) => (await c.query(`select ${sql} as r`, p)).rows[0].r;

/** An SR Legacy release that holds every reference food the demo dishes use. The real 2018-04
 *  release (imported with scripts/usda-import.mjs) is used when present. Only tests may fall back to
 *  the 23-food excerpt (allowExcerpt): it carries the same release label, so it must never be
 *  committed to a database that will later import the real file. */
export async function demoRelease(client, { allowExcerpt = false } = {}) {
  const ids = [...new Set(DISHES.flatMap((d) => d.model.lines.flatMap((l) => [l.fdcId, ...(l.substitutes ?? []).map((s) => s.fdcId)])))];
  const r = await client.query(
    `select r.id from app.usda_releases r where r.dataset = 'sr_legacy' and r.sealed
        and (select count(distinct f.fdc_id) from app.usda_foods f where f.release_id = r.id and f.fdc_id = any($1::int[])) = $2
      order by r.imported_at limit 1`, [ids, ids.length]);
  if (r.rows[0]) return r.rows[0].id;
  if (!allowExcerpt) throw new Error("Import the USDA SR Legacy 2018-04 release first (node scripts/usda-import.mjs), then run this again.");
  const t = Object.fromEntries(readdirSync(FIXTURE_DIR).map((f) => [f.replace(/\.csv$/, ""), parseCsv(readFileSync(join(FIXTURE_DIR, f), "utf8"))]));
  return (await writeRelease(client, prepareRelease(FIXTURE_META, fromSrLegacyCsv(t)))).releaseId;
}

/** Create the ten demo dishes (skipping any already present). curator and publisher are two
 *  different local accounts; the model needs both (two-person rule). Returns one summary per dish. */
export async function loadDemoDishes(client, { curator, publisher, releaseId }) {
  const out = [];
  for (const d of DISHES) {
    const exists = (await client.query("select 1 from public.food_items where id = $1", [d.id])).rowCount;
    if (exists) { out.push({ id: d.id, name: d.name, skipped: true }); continue; }
    const rev = d.id.replace(/e5(\d{3})$/, "e6$1");
    await client.query("insert into public.food_items (id, kind, visibility, status, is_demo) values ($1, 'dish', 'public', 'draft', true)", [d.id]);
    await client.query(
      `insert into public.food_revisions (id, food_item_id, revision_no, name, description, preparation_state, basis_kind, basis_amount, basis_unit)
       values ($1, $2, 1, $3, 'Synthetic demo dish for the nutrition engine. Not a real restaurant dish.', 'prepared', 'serving', 1, 'serving')`, [rev, d.id, d.name]);
    await client.query("insert into public.portions (revision_id, label, amount, unit) values ($1, '1 serving', 1, 'serving')", [rev]);
    await client.query("insert into public.dishes (food_item_id, venue_id, menu_section) values ($1, $2, 'Demo nutrition engine')", [d.id, VENUES[d.venue]]);
    if (d.published !== undefined) {
      await client.query(
        `insert into public.nutrient_values (revision_id, nutrient_code, value, method, source_record_id, assumptions)
         values ($1, 'protein_g', $2, 'published', $3, 'Synthetic demo figure standing in for a restaurant''s own published figure')`, [rev, d.published, DEMO_RECORD]);
    }
    const lines = d.model.lines.map((l) => ({ ...l, usdaReleaseId: releaseId, substitutes: (l.substitutes ?? []).map((s) => ({ ...s, usdaReleaseId: releaseId })) }));
    const model = await one(client, "app.nie_create_model($1, $2::jsonb)", [curator, JSON.stringify({ label: d.name, ...d.model, lines })]);
    await client.query("select app.nie_publish_model($1, $2)", [publisher, model]);
    const calc = await one(client, "app.nie_calculate($1)", [model]);
    if (d.published === undefined) await client.query("select app.nie_apply_to_revision($1, $2, $3)", [curator, calc, rev]);
    await client.query("update public.food_revisions set published_at = now() where id = $1", [rev]);
    await client.query("update public.food_items set current_revision_id = $1, status = 'published', version = version + 1 where id = $2", [rev, d.id]);
    const check = d.published !== undefined ? await one(client, "app.nie_check_published($1, $2, $3)", [curator, d.id, calc]) : null;
    out.push({ id: d.id, name: d.name, calculationId: calc, check });
  }
  return out;
}
