/**
 * Cuisine or style of a real place from Overture Maps' own taxonomy (CAT-CUISINE, docs/49 "Cuisine").
 *
 * Rules (owner 18 Nov 02:27 UTC, point 4: "Distinguish explicitly sourced categories from inferred or uncertain
 * cuisines, and do not misclassify restaurants"):
 * - Only an explicit Overture category is read. Nothing is guessed from a name, a website or a menu.
 * - Overture's primary category gives basis "dataset_primary" ("Cuisine from Overture Maps").
 *   A cuisine found only among Overture's alternate categories gives basis "dataset_alternate"
 *   ("Possibly …"), shown as uncertain and left out of the cuisine filter unless the visitor asks for it.
 * - Generic categories (restaurant, café, coffee shop, bakery, fast food …) give no cuisine: "Cuisine not known".
 * - Diet words (vegetarian, vegan, halal, kosher, gluten-free, health food) are never a cuisine and never a
 *   dietary claim (CLAUDE.md: never infer suitability from a venue category). They are dropped here.
 * Every mapping is listed below so it can be reviewed; an Overture category not listed gives nothing.
 */

/** Overture category → cuisine or style label. Reviewed by hand; extend only with explicit categories. */
export const CUISINE_BY_CATEGORY = Object.freeze({
  afghan_restaurant: "Afghan",
  afghani_restaurant: "Afghan",
  african_restaurant: "African",
  american_restaurant: "American",
  argentine_restaurant: "Argentinian",
  armenian_restaurant: "Armenian",
  asian_fusion_restaurant: "Asian",
  asian_restaurant: "Asian",
  australian_restaurant: "Australian",
  bagel_shop: "Bagels",
  barbecue_restaurant: "Barbecue",
  brazilian_restaurant: "Brazilian",
  breakfast_and_brunch_restaurant: "Breakfast and brunch",
  burger_restaurant: "Burgers",
  burmese_restaurant: "Burmese",
  cajun_and_creole_restaurant: "Cajun and Creole",
  cajun_creole_restaurant: "Cajun and Creole",
  cambodian_restaurant: "Cambodian",
  cantonese_restaurant: "Chinese",
  caribbean_restaurant: "Caribbean",
  chicken_restaurant: "Chicken",
  chicken_wings_restaurant: "Chicken wings",
  chinese_restaurant: "Chinese",
  colombian_restaurant: "Colombian",
  cuban_restaurant: "Cuban",
  delicatessen: "Deli",
  dim_sum_restaurant: "Chinese",
  diner: "Diner",
  dominican_restaurant: "Dominican",
  dumpling_restaurant: "Dumplings",
  eastern_european_restaurant: "Eastern European",
  egyptian_restaurant: "Egyptian",
  ethiopian_restaurant: "Ethiopian",
  european_restaurant: "European",
  falafel_restaurant: "Middle Eastern",
  filipino_restaurant: "Filipino",
  french_restaurant: "French",
  german_restaurant: "German",
  greek_restaurant: "Greek",
  haitian_restaurant: "Haitian",
  hawaiian_restaurant: "Hawaiian",
  himalayan_nepalese_restaurant: "Nepalese",
  honduran_restaurant: "Honduran",
  hot_dog_restaurant: "Hot dogs",
  hot_pot_restaurant: "Hot pot",
  indian_restaurant: "Indian",
  indonesian_restaurant: "Indonesian",
  irish_restaurant: "Irish",
  israeli_restaurant: "Israeli",
  italian_restaurant: "Italian",
  jamaican_restaurant: "Jamaican",
  japanese_restaurant: "Japanese",
  korean_restaurant: "Korean",
  latin_american_restaurant: "Latin American",
  lebanese_restaurant: "Lebanese",
  malaysian_restaurant: "Malaysian",
  mediterranean_restaurant: "Mediterranean",
  mexican_restaurant: "Mexican",
  middle_eastern_restaurant: "Middle Eastern",
  moroccan_restaurant: "Moroccan",
  nepalese_restaurant: "Nepalese",
  noodles_restaurant: "Noodles",
  pakistani_restaurant: "Pakistani",
  pan_asian_restaurant: "Asian",
  persian_iranian_restaurant: "Persian",
  persian_restaurant: "Persian",
  peruvian_restaurant: "Peruvian",
  pizza_restaurant: "Pizza",
  poke_restaurant: "Poke",
  portuguese_restaurant: "Portuguese",
  puerto_rican_restaurant: "Puerto Rican",
  ramen_restaurant: "Ramen",
  russian_restaurant: "Russian",
  salad_bar: "Salads",
  salvadoran_restaurant: "Salvadoran",
  sandwich_shop: "Sandwiches",
  seafood_restaurant: "Seafood",
  shanghainese_restaurant: "Chinese",
  sichuan_restaurant: "Chinese",
  soul_food: "Soul food",
  soup_restaurant: "Soup",
  southern_american_restaurant: "Southern",
  spanish_restaurant: "Spanish",
  sri_lankan_restaurant: "Sri Lankan",
  steakhouse: "Steakhouse",
  sushi_restaurant: "Sushi",
  szechuan_restaurant: "Chinese",
  taco_restaurant: "Tacos",
  taiwanese_restaurant: "Taiwanese",
  tapas_bar: "Tapas",
  tex_mex_restaurant: "Tex-Mex",
  texmex_restaurant: "Tex-Mex",
  thai_restaurant: "Thai",
  tibetan_restaurant: "Tibetan",
  turkish_restaurant: "Turkish",
  ukrainian_restaurant: "Ukrainian",
  venezuelan_restaurant: "Venezuelan",
  vietnamese_restaurant: "Vietnamese",
  west_african_restaurant: "West African",
  wrap_restaurant: "Wraps",
});

/** Categories that describe a diet, never a cuisine, and never read as a dietary claim. */
export const DIET_CATEGORIES = Object.freeze(new Set([
  "vegetarian_restaurant", "vegan_restaurant", "halal_restaurant", "kosher_restaurant", "gluten_free_restaurant",
  "health_food_restaurant", "raw_food_restaurant", "organic_restaurant",
]));

const cuisineOf = (category) => (Object.hasOwn(CUISINE_BY_CATEGORY, category) ? CUISINE_BY_CATEGORY[category] : null);

/**
 * Cuisines for one place from its Overture taxonomy record.
 * @param {{ primary?: string, alternates?: string[] }} t
 * @returns {{ cuisine: string, basis: "dataset_primary" | "dataset_alternate", category: string }[]}
 */
export function cuisinesFromTaxonomy(t) {
  const out = [];
  const seen = new Set();
  const primary = String(t?.primary ?? "").trim();
  const p = cuisineOf(primary);
  if (p) {
    out.push({ cuisine: p, basis: "dataset_primary", category: primary });
    seen.add(p);
  }
  for (const raw of t?.alternates ?? []) {
    const category = String(raw).trim();
    if (DIET_CATEGORIES.has(category)) continue;
    const c = cuisineOf(category);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push({ cuisine: c, basis: "dataset_alternate", category });
  }
  // At most one "possibly" beyond the primary, so a long alternates list never paints a place as everything.
  const primaries = out.filter((x) => x.basis === "dataset_primary");
  const alternates = out.filter((x) => x.basis === "dataset_alternate");
  return [...primaries, ...alternates.slice(0, primaries.length ? 1 : 2)];
}

/** Parses the taxonomy CSV written by scripts/catalog/overture-taxonomy.py into a map id → record. */
export function parseTaxonomyRows(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.id) continue;
    map.set(r.id, { primary: r.primary || "", alternates: (r.alternates || "").split("|").filter(Boolean) });
  }
  return map;
}
