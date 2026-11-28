// Pure reading of an authorized menu export file (docs/45), shared by the export importer, the
// restaurant-submission tool and the app's upload page. No file system, network or database here.
import { parseAmount, parsePrice } from "./menu-readers.mjs";

export const NUTRIENT_COLUMNS = { calories_kcal: ["energy_kcal", "kcal"], protein_g: ["protein_g", "g"], carb_g: ["carb_g", "g"], fat_g: ["fat_g", "g"], fiber_g: ["fiber_g", "g"], sodium_mg: ["sodium_mg", "mg"], sugar_g: ["sugar_g", "g"] };

/** A small RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const blankToNull = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());

/** Items from an export file's text. Unknown columns are ignored; nothing is filled in. */
export function readExport(text, kind) {
  const out = [];
  const push = (x, nutrition) => {
    const name = blankToNull(x.name);
    if (!name) return;
    out.push({
      name, description: blankToNull(x.description), section: blankToNull(x.section),
      labels: Array.isArray(x.labels) ? x.labels.map(String).filter(Boolean) : (blankToNull(x.labels)?.split(";").map((l) => l.trim()).filter(Boolean) ?? []),
      legend: x.legend && typeof x.legend === "object" && !Array.isArray(x.legend) ? x.legend : {},
      ingredients: blankToNull(x.ingredients), allergens: blankToNull(x.allergens),
      price_usd: x.price_usd == null || x.price_usd === "" ? null : parsePrice(x.price_usd),
      serving: blankToNull(x.serving),
      serving_grams: (() => { const a = parseAmount(blankToNull(x.serving_grams), "g"); return a && a.unit === "g" && a.amount > 0 ? a.amount : null; })(),
      nutrition,
    });
  };
  if (kind === "json") {
    const j = JSON.parse(text);
    for (const x of j.items ?? []) {
      const nutrition = {};
      for (const [k, v] of Object.entries(x.nutrition ?? {})) {
        if (v && Number.isFinite(v.amount) && v.amount >= 0 && v.unit) nutrition[k] = { amount: v.amount, unit: v.unit, per: v.per ?? "serving" };
      }
      push(x, nutrition);
    }
    return { documentDate: j.document_date ?? null, items: out };
  }
  const [header, ...rows] = parseCsv(text);
  const cols = (header ?? []).map((h) => h.trim().toLowerCase());
  for (const r of rows) {
    const x = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
    const nutrition = {};
    for (const [col, [code, unit]] of Object.entries(NUTRIENT_COLUMNS)) {
      const a = parseAmount(blankToNull(x[col]), unit);
      if (a && a.unit === unit) nutrition[code] = { amount: a.amount, unit, per: "serving" }; // a different unit is not converted or guessed
    }
    push(x, nutrition);
  }
  return { documentDate: null, items: out };
}

