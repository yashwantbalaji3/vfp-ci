// Dietary evidence from a restaurant's own words (menu pipeline stage 4, docs/41).
//
// Only what the restaurant prints counts. A dish is vegetarian or vegan only when the restaurant's
// label for that dish says so, read through the page's own legend. Ingredients can raise a warning
// but can never add a label. Pure functions: no network, no database, no guessing.
//
// Result per claim (vegetarian, vegan):
//   stated       the restaurant's own explicit word ("Vegan", "V = Vegetarian")
//   preliminary  a looser word ("Plant-based", "VG = Vegetarian & Vegan-Friendly"): founder-review
//                eligibility only (owner rule 16 Nov 22:26 UTC); never a strict-filter pass
//   option       "can be made vegan", "vegan option available": the dish as listed is NOT vegan
//   stated_no    the restaurant says it is not ("Non-veg", "contains meat")
//   none         nothing printed, or a mark the page never defines

const VEGAN_OPTION = /\b(vegan[\s-]*(friendly|option|options|available|upon request|on request|by request)|can be (made|prepared) vegan|make it vegan|ask (for|about) (a )?vegan|vegan (if|when|with|without)\b|vegan[\s-]*able|veganizable)\b/i;
const VEG_OPTION = /\b(vegetarian[\s-]*(friendly|option|options|available|upon request|on request)|can be (made|prepared) vegetarian|make it vegetarian|vegetarian (if|when|with|without)\b)\b/i;
const NOT_VEGAN = /\b(not vegan|non[\s-]*vegan)\b/i;
const NOT_VEG = /\b(not vegetarian|non[\s-]*veg(etarian)?|contains meat)\b/i;
const VEGAN = /\bvegan\b/i;
const VEGETARIAN = /\b(vegetarian|veggie(?! burger| sandwich| wrap| bowl| roll))\b/i;
const PLANT_BASED = /\b(plant[\s-]*based|100% plants?|made from plants)\b/i;

// Words that show an ingredient a vegetarian (or vegan) label would contradict. A hit is a warning
// for the founder, never a label.
const MEAT_FISH = /\b(chicken|beef|pork|bacon|ham|prosciutto|pancetta|salami|pepperoni|chorizo|sausage|turkey|lamb|veal|duck|goat meat|steak|brisket|meatballs?|anchov(y|ies)|tuna|salmon|shrimp|prawns?|crab|lobster|clams?|mussels?|oysters?|scallops?|squid|calamari|octopus|fish|cod|haddock|tilapia|bonito|dashi|lard|tallow|gelatin|gelatine|bone broth|chicken stock|beef stock|fish sauce|oyster sauce)\b/i;
const ANIMAL_NOT_MEAT = /\b(milk|butter|cream|cheese|cheddar|mozzarella|feta|ricotta|paneer|yogurt|yoghurt|ghee|whey|casein|egg|eggs|mayo|mayonnaise|aioli|honey|raita|tzatziki|labneh|kefir|custard|meringue|brioche)\b/i;
// Words whose meaning depends on the recipe: shown for a person to check, never decided here.
const AMBIGUOUS = /\b(parmesan|parmigiano|pecorino|grana padano|caesar|worcestershire|pesto|kimchi|naan|ranch|bouillon|stock|broth|marshmallows?|caramel color|natural flavors?|mono- and diglycerides|vitamin d3)\b/i;

/** Plain words for a classification, for founder review sheets. */
export const STATUS_WORDS = {
  stated: "Restaurant states it",
  preliminary: "Preliminary restaurant label only",
  option: "Only as a modification; the dish as listed is not",
  stated_no: "Restaurant says it is not",
  none: "Nothing stated",
};

/**
 * What one label means, read with the page's own legend. A short mark ("V", "VG", "(ve)") means
 * nothing unless the legend defines it.
 * @param {string} label
 * @param {Record<string, string>} legend   mark -> the page's own definition
 */
export function readLabel(label, legend = {}) {
  const raw = String(label ?? "").trim();
  const key = raw.replace(/^[([{]|[)\]}]$/g, "").trim();
  const def = Object.entries(legend).find(([k]) => k.replace(/^[([{]|[)\]}]$/g, "").trim().toLowerCase() === key.toLowerCase())?.[1];
  const words = def ?? raw;
  const isShortMark = key.length <= 3 && !def;
  return { label: raw, definition: def ?? null, words: isShortMark ? "" : words, undefinedMark: isShortMark };
}

function classifyWords(words) {
  const out = { vegetarian: "none", vegan: "none" };
  if (!words) return out;
  if (NOT_VEGAN.test(words)) out.vegan = "stated_no";
  if (NOT_VEG.test(words)) { out.vegetarian = "stated_no"; out.vegan = "stated_no"; }
  if (out.vegan === "none") {
    if (VEGAN_OPTION.test(words)) out.vegan = "option";
    else if (VEGAN.test(words.replace(VEGAN_OPTION, ""))) out.vegan = "stated";
    else if (PLANT_BASED.test(words)) out.vegan = "preliminary";
  }
  if (out.vegetarian === "none") {
    if (VEG_OPTION.test(words)) out.vegetarian = "option";
    else if (VEGETARIAN.test(words.replace(VEG_OPTION, ""))) {
      // "VG = Vegetarian & Vegan-Friendly": the restaurant's own looser mark (owner rule 16 Nov).
      out.vegetarian = VEGAN_OPTION.test(words) ? "preliminary" : "stated";
    } else if (out.vegan === "stated") out.vegetarian = "stated"; // a vegan dish is vegetarian by definition
    else if (out.vegan === "preliminary") out.vegetarian = "preliminary";
  }
  return out;
}

const RANK = { stated_no: 4, stated: 3, preliminary: 2, option: 1, none: 0 };

/**
 * Classify one menu item from the restaurant's own words.
 * @param {{ name?: string, description?: string, labels?: string[], legend?: Record<string, string>, ingredients?: string | string[] }} item
 */
export function classifyItem(item) {
  const labels = (item.labels ?? []).map((l) => readLabel(l, item.legend ?? {}));
  const result = { vegetarian: "none", vegan: "none", evidence: [], warnings: [] };
  for (const l of labels) {
    if (l.undefinedMark) { result.warnings.push({ kind: "undefined_mark", text: `The mark "${l.label}" is not defined on the page` }); continue; }
    const c = classifyWords(l.words);
    for (const claim of ["vegetarian", "vegan"]) {
      if (RANK[c[claim]] > RANK[result[claim]]) result[claim] = c[claim];
    }
    if (c.vegetarian !== "none" || c.vegan !== "none") result.evidence.push({ label: l.label, definition: l.definition });
  }
  // The dish name itself can carry the restaurant's word ("Vegan Chili"); a description cannot
  // overrule a label, and "veggie burger" alone is not a statement.
  if (result.vegetarian === "none" && result.vegan === "none" && item.name) {
    const c = classifyWords(item.name);
    if (c.vegan === "stated" || c.vegetarian === "stated") {
      Object.assign(result, { vegetarian: c.vegetarian, vegan: c.vegan });
      result.evidence.push({ label: item.name, definition: null, fromName: true });
    }
  }
  const text = [item.name, item.description, ...[item.ingredients ?? []].flat()].filter(Boolean).join(" ; ");
  const positive = (s) => s === "stated" || s === "preliminary";
  // "Vegan cheese", "oat milk", "Impossible burger", "plant-based chicken": a qualifier right before
  // the word means it is not the animal product.
  const QUALIFIED = /\b(vegan|plant[\s-]*based|dairy[\s-]*free|egg[\s-]*free|meatless|meat[\s-]*free|faux|mock|vegetarian|veggie|beyond|impossible|tofu|seitan|tempeh|soy|oat|almond|coconut|cashew|rice|jackfruit|mushroom)[\s-]+$/i;
  const firstUnqualified = (re) => {
    for (const m of text.matchAll(new RegExp(re.source, "gi"))) if (!QUALIFIED.test(text.slice(0, m.index))) return m[0];
    return null;
  };
  const meat = firstUnqualified(MEAT_FISH);
  if (meat && (positive(result.vegetarian) || positive(result.vegan))) {
    result.warnings.push({ kind: "contradiction", text: `Labelled ${positive(result.vegan) ? "vegan" : "vegetarian"} but mentions "${meat}"` });
  }
  const animal = firstUnqualified(ANIMAL_NOT_MEAT);
  if (animal && positive(result.vegan)) {
    result.warnings.push({ kind: "contradiction", text: `Labelled vegan but mentions "${animal}"` });
  }
  const amb = text.match(AMBIGUOUS);
  if (amb && (positive(result.vegetarian) || positive(result.vegan))) {
    result.warnings.push({ kind: "ambiguous_ingredient", text: `"${amb[0]}" can contain animal products; check with the restaurant's own words` });
  }
  return result;
}

/**
 * Staging fact values for one item (pilot staging format). Only stated, preliminary and stated_no
 * become facts; "option" and "none" stay unknown with the reason.
 */
export function stagingDietaryValues(item, classification = classifyItem(item)) {
  const out = [];
  for (const claim of ["vegetarian", "vegan"]) {
    const s = classification[claim];
    const label = classification.evidence[0];
    if (s === "stated" || s === "stated_no") {
      out.push({ claim, value: { claim, status: s === "stated" ? "yes" : "no", label: label?.label, ...(label?.definition ? { legend: label.definition } : {}) } });
    } else if (s === "preliminary") {
      out.push({ claim, value: { claim, status: "yes", evidence: "preliminary_label", label: label?.label, ...(label?.definition ? { legend: label.definition } : {}) } });
    } else {
      out.push({ claim, unknownReason: s === "option" ? `Only offered as a modification: "${label?.label ?? ""}"` : "The restaurant prints no dietary word for this dish" });
    }
  }
  return out;
}
