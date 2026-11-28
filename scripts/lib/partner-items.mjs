// Pure mapping from a parsed menu export (scripts/lib/menu-export.mjs) to the dish rows that
// partner.submit_menu takes (docs/48). Shared by the CLI and the app's upload page.
//
// Dietary labels: only a label that is exactly "vegan" or "vegetarian" (any case) becomes a dietary
// statement, kept in the restaurant's own words. Anything else ("vegan option", "plant-based", "V")
// is returned as unmapped for a person to read, because "vegan-friendly" never becomes "vegan".
import { readExport } from "./menu-export.mjs";

export const EXACT_DIETARY_LABELS = { vegan: "vegan", vegetarian: "vegetarian" };

/** Partner items from parsed export items. Nothing is filled in; blanks stay out. */
export function toPartnerItems(parsedItems) {
  const unmapped = [];
  const items = parsedItems.map((it, i) => {
    const dietary = [];
    for (const label of it.labels ?? []) {
      const key = String(label).trim().toLowerCase();
      const claim = Object.hasOwn(EXACT_DIETARY_LABELS, key) ? EXACT_DIETARY_LABELS[key] : null;
      if (claim) dietary.push({ claim, words: String(label).trim().slice(0, 300) });
      else unmapped.push({ position: i, name: it.name, label });
    }
    const out = { name: it.name, dietary, nutrition: it.nutrition ?? {} };
    for (const k of ["description", "section", "ingredients", "allergens", "serving", "price_usd", "serving_grams"]) {
      if (it[k] != null) out[k] = it[k];
    }
    return out;
  });
  return { items, unmapped };
}


/** A file's text (CSV or JSON) to partner rows. Throws on JSON that cannot be parsed. */
export function partnerItemsFromText(text, kind) {
  const parsed = readExport(text, kind);
  return { documentDate: parsed.documentDate, ...toPartnerItems(parsed.items) };
}
