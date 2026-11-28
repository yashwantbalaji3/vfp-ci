// NIE V1 slice N-1: turns USDA FoodData Central records into one tidy shape (docs/24 section 3.2).
// Pure functions only (no files, no database), so they are unit-tested on their own.
//
// Rules (docs/07, docs/24):
//   * Every nutrient is mapped explicitly by its USDA nutrient number. Nothing is guessed.
//   * A value whose unit is not the one we expect is refused and reported, never converted by guess.
//   * A missing value stays missing (null later, with the reason "not_provided"). Never zero.
//   * Values are kept as decimal strings exactly as USDA gives them; no rounding here.
import { createHash } from "node:crypto";

export const IMPORTER_VERSION = "nie-n1-1";

/** Our nutrient code -> the USDA nutrient numbers accepted for it, in order of preference, with the unit we expect. */
export const NUTRIENT_MAP = {
  protein_g: { ids: [1003], unit: "g" },
  fat_g: { ids: [1004], unit: "g" },
  carb_g: { ids: [1005], unit: "g" },
  fiber_g: { ids: [1079], unit: "g" },
  sodium_mg: { ids: [1093], unit: "mg" },
  // "Energy" (1008) when USDA gives it; Foundation Foods often give only the Atwater energies,
  // so the specific factors (2048) come next, then the general factors (2047). Which one was used
  // is kept with the value. We never work energy out from protein, fat and carbohydrate ourselves.
  energy_kcal: { ids: [1008, 2048, 2047], unit: "kcal" },
};

const DATA_TYPES = { Foundation: "foundation", foundation_food: "foundation", "SR Legacy": "sr_legacy", sr_legacy_food: "sr_legacy" };

/** "12.30" -> "12.3"; refuses anything that is not a plain non-negative decimal. */
export function decimalString(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined; // undefined = present but not a usable number
  const [i, f = ""] = s.split(".");
  const int = i.replace(/^0+(?=\d)/, "");
  const frac = f.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/**
 * One food: `raw` is { fdcId, dataType, description, category, ndbNumber, publicationDate,
 * nutrients: [{ id, unit, amount, derivation }], portions: [{ id, amount, unit, modifier, description, grams }] }.
 * Returns { record, refused } where refused lists nutrients not taken, with the reason.
 */
export function normalizeFood(raw) {
  const dataType = DATA_TYPES[raw.dataType];
  if (!dataType) throw new Error(`Unexpected USDA data type: ${raw.dataType}`);
  const fdcId = Number(raw.fdcId);
  if (!Number.isInteger(fdcId) || fdcId <= 0) throw new Error(`Bad FDC ID: ${raw.fdcId}`);
  const byId = new Map();
  for (const n of raw.nutrients) if (!byId.has(Number(n.id))) byId.set(Number(n.id), n);
  const nutrients = {};
  const refused = [];
  for (const [code, rule] of Object.entries(NUTRIENT_MAP)) {
    for (const id of rule.ids) {
      const n = byId.get(id);
      if (!n) continue;
      const unit = String(n.unit ?? "").toLowerCase();
      if (unit !== rule.unit) {
        refused.push({ code, usdaNutrientId: id, reason: `unexpected unit "${n.unit}" (expected ${rule.unit})` });
        continue;
      }
      const value = decimalString(n.amount);
      if (value === null) continue;
      if (value === undefined) {
        refused.push({ code, usdaNutrientId: id, reason: `not a usable number: "${n.amount}"` });
        continue;
      }
      nutrients[code] = { value, unit: rule.unit, usdaNutrientId: id, derivation: n.derivation ?? null };
      break;
    }
  }
  // Per 100 g, protein above 100 g or a fraction above the whole is a data error: refuse, report.
  for (const code of ["protein_g", "fat_g", "carb_g", "fiber_g"]) {
    if (nutrients[code] && Number(nutrients[code].value) > 100) {
      refused.push({ code, usdaNutrientId: nutrients[code].usdaNutrientId, reason: "more than 100 g per 100 g" });
      delete nutrients[code];
    }
  }
  const portions = [];
  for (const p of raw.portions ?? []) {
    const grams = decimalString(p.grams);
    const amount = decimalString(p.amount);
    // A portion is only useful with a positive gram weight and a positive amount.
    if (!grams || !amount || Number(grams) <= 0 || Number(amount) <= 0) continue;
    portions.push({
      usdaPortionId: Number(p.id),
      amount,
      unit: (p.unit ?? "").trim() || null,
      modifier: (p.modifier ?? "").trim() || null,
      description: (p.description ?? "").trim() || null,
      grams,
    });
  }
  portions.sort((a, b) => a.usdaPortionId - b.usdaPortionId);
  const record = {
    fdcId,
    dataType,
    description: String(raw.description).trim(),
    category: raw.category ? String(raw.category).trim() : null,
    ndbNumber: raw.ndbNumber ? String(raw.ndbNumber) : null,
    publicationDate: raw.publicationDate ? isoDate(raw.publicationDate) : null,
    nutrients: sortKeys(nutrients),
    portions,
  };
  return { record, refused };
}

/** "10/26/2023" or "2019-04-01" -> "2023-10-26". */
export function isoDate(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  throw new Error(`Unexpected date: ${s}`);
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Canonical JSON (sorted keys at every level) so the same record always gives the same fingerprint. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const recordHash = (record) => sha256(canonical(record));

/** Fingerprint of a whole release: the sorted record fingerprints, hashed together. */
export function releaseHash(records) {
  return sha256(records.map((r) => `${r.fdcId}:${recordHash(r)}`).sort().join("\n"));
}

// ---------------------------------------------------------------------------
// Readers for the two file layouts (already unzipped)
// ---------------------------------------------------------------------------

/** Foundation Foods JSON ({ "FoundationFoods": [...] }). */
export function fromFoundationJson(json) {
  const foods = json.FoundationFoods;
  if (!Array.isArray(foods)) throw new Error("Not a Foundation Foods JSON file");
  return foods.map((f) => ({
    fdcId: f.fdcId,
    dataType: f.dataType,
    description: f.description,
    category: f.foodCategory?.description ?? null,
    ndbNumber: f.ndbNumber ?? null,
    publicationDate: f.publicationDate ?? null,
    nutrients: (f.foodNutrients ?? []).filter((n) => n.nutrient && n.amount !== undefined).map((n) => ({
      id: n.nutrient.id,
      unit: n.nutrient.unitName,
      amount: n.amount,
      derivation: n.foodNutrientDerivation?.code ?? null,
    })),
    portions: (f.foodPortions ?? []).map((p) => ({
      id: p.id,
      amount: p.amount ?? p.value,
      unit: p.measureUnit?.name === "undetermined" ? null : p.measureUnit?.name,
      modifier: p.modifier ?? null,
      description: p.portionDescription ?? null,
      grams: p.gramWeight,
    })),
  }));
}

/** Minimal CSV parser for USDA files (quoted fields, commas and doubled quotes inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** SR Legacy CSV tables (food, food_nutrient, nutrient, food_portion, measure_unit, food_category, sr_legacy_food). */
export function fromSrLegacyCsv(t) {
  const unitOf = new Map(t.nutrient.map((n) => [n.id, n.unit_name]));
  const measure = new Map(t.measure_unit.map((m) => [m.id, m.name]));
  const category = new Map(t.food_category.map((c) => [c.id, c.description]));
  const ndb = new Map(t.sr_legacy_food.map((s) => [s.fdc_id, s.NDB_number]));
  const derivation = new Map((t.food_nutrient_derivation ?? []).map((d) => [d.id, d.code]));
  const nutrients = new Map();
  for (const n of t.food_nutrient) {
    if (!nutrients.has(n.fdc_id)) nutrients.set(n.fdc_id, []);
    nutrients.get(n.fdc_id).push({ id: Number(n.nutrient_id), unit: unitOf.get(n.nutrient_id), amount: n.amount, derivation: derivation.get(n.derivation_id) ?? null });
  }
  const portions = new Map();
  for (const p of t.food_portion) {
    if (!portions.has(p.fdc_id)) portions.set(p.fdc_id, []);
    const unit = measure.get(p.measure_unit_id);
    portions.get(p.fdc_id).push({ id: p.id, amount: p.amount, unit: unit === "undetermined" ? null : unit, modifier: p.modifier, description: p.portion_description, grams: p.gram_weight });
  }
  return t.food.map((f) => ({
    fdcId: f.fdc_id,
    dataType: f.data_type,
    description: f.description,
    category: category.get(f.food_category_id) ?? null,
    ndbNumber: ndb.get(f.fdc_id) ?? null,
    publicationDate: f.publication_date || null,
    nutrients: nutrients.get(f.fdc_id) ?? [],
    portions: portions.get(f.fdc_id) ?? [],
  }));
}
