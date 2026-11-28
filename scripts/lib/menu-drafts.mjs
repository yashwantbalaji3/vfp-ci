// Bridge from menu readers to private staging drafts (docs/58). Pure: no network, no database.
// Turns reader items into staging-entry facts. Only what the page states becomes a value; every
// missing dietary claim and protein value is drafted as unknown with a reason, never guessed. A diet
// comes only from the restaurant's own label on that dish, never from a dish name, section or cuisine.

const ALLERGENS = new Set(["dairy", "milk", "egg", "eggs", "wheat", "gluten", "soy", "sesame", "peanut", "peanuts", "tree nuts", "nuts", "fish", "shellfish", "coconut", "legumes"]);
const NUTRIENTS = ["protein_g", "energy_kcal", "fat_g", "carb_g", "fiber_g", "sodium_mg"];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * @param {{ items: any[], source: string, checkedOn: string, menuWideDiet?: "vegan" | "vegetarian" | null }} opts
 *   menuWideDiet: a diet the page states for its whole menu (for example "All American Vegan Menu");
 *   it is drafted at medium confidence because it is not printed on each dish.
 * @returns {{ dishes: {key: string, label: string}[], facts: any[], repeats: string[] }}
 */
export function itemsToDrafts({ items, source, checkedOn, menuWideDiet = null }) {
  const dishes = [];
  const facts = [];
  const repeats = [];
  const add = (f) => facts.push({ checkedOn, source, ...f });
  for (const it of items) {
    const key = slug(it.name);
    if (!key) continue;
    if (dishes.some((d) => d.key === key)) { repeats.push(it.name); continue; }
    dishes.push({ key, label: String(it.name).slice(0, 120) });
    const several = (it.variants?.length ?? 0) > 1;
    add({ dish: key, kind: "menu_item", value: { listed: true }, confidence: "high" });
    if (it.price_usd != null) add({ dish: key, kind: "price", value: { usd: money(it.price_usd) }, confidence: several ? "medium" : "high" });
    const labels = (it.labels ?? []).map((l) => String(l).toLowerCase());
    for (const claim of ["vegan", "vegetarian"]) {
      if (labels.includes(claim) || labels.includes(`${claim}diet`)) add({ dish: key, kind: "dietary_status", subject: claim, value: { claim, status: "yes" }, confidence: "high" });
      else if (menuWideDiet === claim || (menuWideDiet === "vegan" && claim === "vegetarian")) add({ dish: key, kind: "dietary_status", subject: claim, value: { claim, status: "yes" }, confidence: "medium" });
      else add({ dish: key, kind: "dietary_status", subject: claim, unknownReason: "The menu does not label it", confidence: "high" });
    }
    for (const n of NUTRIENTS) {
      const v = it.nutrition?.[n];
      if (v && v.per === "serving") add({ dish: key, kind: "published_nutrition", subject: n, value: { nutrient: n, amount: String(v.amount), per: "serving" }, confidence: several ? "medium" : "high" });
      else if (n === "protein_g") {
        const r = it.published_ranges?.protein_g;
        add({ dish: key, kind: "published_nutrition", subject: n, unknownReason: r ? `The menu prints a range (${r.low}-${r.high} g), not one value` : "The menu does not print protein", confidence: "high" });
      }
    }
    const allergens = [...new Set([...(it.allergens ?? []), ...labels.filter((l) => ALLERGENS.has(l))].map((a) => String(a).toLowerCase().trim()).filter(Boolean))];
    if (allergens.length) add({ dish: key, kind: "allergen_statement", value: { statement: "contains", allergens }, confidence: it.allergens?.length ? "high" : "medium" });
  }
  return { dishes, facts, repeats };
}
