import {
  estimateWords,
  hasRestaurantProtein,
  MEAL_TYPES,
  rowConfirmable,
  rowWaiting,
  type MenuDish,
  type MenuFact,
  type MenuPlace,
} from "./menu-review";

/**
 * Automatic pre-checks on a drafted menu (docs/58, owner direction 18 Nov 19:19 UTC). They only sort
 * rows so the founder looks at the doubtful ones first. A pre-check never confirms, verifies or
 * publishes anything, and a row with no flags still needs the founder's own look at the source.
 *
 * "check" flags make a row an exception: it cannot be confirmed in a group. "note" flags are shown
 * but leave the row clean.
 */
export type Flag = { code: FlagCode; level: "check" | "note"; words: string };
export type FlagCode =
  | "possible_duplicate"
  | "dietary_conflict"
  | "ingredient_conflict"
  | "implausible_nutrition"
  | "missing_price"
  | "no_dietary_evidence"
  | "unclassified"
  | "low_confidence"
  | "published_range"
  | "restaurant_estimate"
  | "unknown_value"
  | "part_of_meal"
  | "price_outlier"
  | "estimate_and_published"
  | "usda_estimate"
  | "estimate_unknown"
  | "diet_not_stated"
  | "names_meat"
  | "automatic_not_found"
  | "automatic_found";

const ANIMAL = [
  "chicken", "beef", "pork", "bacon", "ham", "lamb", "turkey", "duck", "fish", "salmon", "tuna", "shrimp",
  "prawn", "crab", "lobster", "anchovy", "anchovies", "gelatin", "lard", "steak", "sausage", "prosciutto",
  // Added 27 Nov 2026 (Boston audit: "6 oz. Filet Mignon", "California BLT" and sushi bar fish were showing among
  // meals): words that always mean meat or fish on a menu. Ambiguous words (kebab, kofta, sushi, goat) are left out;
  // a vegan, vegetarian or plant word beside any of these still wins, and the restaurant's own label always does.
  "filet mignon", "veal", "ribs", "short rib", "brisket", "oxtail", "liver", "tripe", "wagyu", "bison", "venison", "rabbit", "quail", "mutton",
  "meat", "meats", "meatball", "meatballs", "pepperoni", "salami", "pastrami", "pancetta", "guanciale", "mortadella", "capicola", "soppressata",
  "nduja", "chorizo", "kielbasa", "bratwurst", "andouille", "hot dog", "blt", "birria", "al pastor", "carnitas", "keema", "tonkotsu", "foie gras",
  "seafood", "clam", "clams", "oyster", "oysters", "scallop", "scallops", "mussel", "mussels", "calamari", "squid", "octopus", "crawfish",
  "cod", "haddock", "halibut", "tilapia", "trout", "swordfish", "catfish", "snapper", "branzino", "sea bass", "ceviche", "lox", "caviar", "roe",
  "eel", "unagi", "hamachi", "yellowtail", "sashimi", "toro", "uni", "ikura", "tobiko", "saba", "poke", "gyro", "gyros",
];
const DAIRY_EGG_HONEY = [
  "cheese", "feta", "mozzarella", "parmesan", "ricotta", "paneer", "yogurt", "yoghurt", "butter", "ghee",
  "milk", "cream", "egg", "eggs", "honey", "mayo", "mayonnaise", "aioli",
];
// Words that make a listed ingredient plant-based even when it names an animal product.
const PLANT = /\b(vegan|vegetarian|veggie|plant[- ]based|oat|soy|almond|coconut|cashew|peanut|nut|seitan|tofu|impossible|beyond|vegetable)\b/;
const has = (items: string[], words: string[]) =>
  items.filter((i) => {
    const s = i.toLowerCase();
    return !PLANT.test(s) && words.some((w) => new RegExp(`\\b${w}\\b`).test(s));
  });

export const normalLabel = (label: string) =>
  label
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const live = (d: MenuDish) => d.facts.filter((f) => !f.unknown && f.value);
const value = (f: MenuFact) => (f.value ?? {}) as Record<string, unknown>;
const single = (d: MenuDish, nutrient: string): number | null => {
  const f = live(d).find(
    (x) =>
      x.kind === "published_nutrition" &&
      x.subject === nutrient &&
      (value(x).basis ?? "published") !== "published_range" &&
      value(x).per === "serving",
  );
  return f ? Number(value(f).amount) : null;
};

/** The flags for one row. */
export function rowFlags(d: MenuDish, place: Pick<MenuPlace, "dishes">): Flag[] {
  const out: Flag[] = [];
  const facts = live(d);
  const type = d.structure?.type ?? null;

  const twin = place.dishes.find(
    (o) =>
      o.dishId !== d.dishId &&
      normalLabel(o.label) === normalLabel(d.label) &&
      (o.structure?.type ?? null) === (d.structure?.type ?? null) &&
      (o.structure?.parentDishId ?? null) === (d.structure?.parentDishId ?? null),
  );
  if (twin) out.push({ code: "possible_duplicate", level: "check", words: `Looks like the same dish as “${twin.label}”` });

  const diet = (claim: string) => facts.find((f) => f.kind === "dietary_status" && f.subject === claim);
  const vegan = diet("vegan");
  const veg = diet("vegetarian");
  const eggFree = diet("egg_free");
  if (vegan && value(vegan).status === "yes" && veg && value(veg).status === "no")
    out.push({ code: "dietary_conflict", level: "check", words: "Marked vegan but also not vegetarian" });

  const ingredients = facts.find((f) => f.kind === "listed_ingredients");
  const items = ingredients && Array.isArray(value(ingredients).items) ? (value(ingredients).items as unknown[]).map(String) : [];
  const meat = has(items, ANIMAL);
  const animalProducts = has(items, DAIRY_EGG_HONEY);
  if ((vegan && value(vegan).status === "yes") || (veg && value(veg).status === "yes")) {
    if (meat.length) out.push({ code: "ingredient_conflict", level: "check", words: `Listed ingredients include ${meat.join(", ")}` });
  }
  if (vegan && value(vegan).status === "yes" && animalProducts.length)
    out.push({ code: "ingredient_conflict", level: "check", words: `Marked vegan but lists ${animalProducts.join(", ")}` });
  if (eggFree && value(eggFree).status === "yes" && has(items, ["egg", "eggs", "mayo", "mayonnaise", "aioli"]).length)
    out.push({ code: "ingredient_conflict", level: "check", words: "Marked egg-free but lists egg or mayonnaise" });

  const kcal = single(d, "energy_kcal");
  const protein = single(d, "protein_g");
  const carb = single(d, "carb_g");
  const fat = single(d, "fat_g");
  const fiber = single(d, "fiber_g");
  const sodium = single(d, "sodium_mg");
  const odd: string[] = [];
  if (kcal !== null && protein !== null && carb !== null && fat !== null) {
    const fromParts = protein * 4 + carb * 4 + fat * 9;
    if (fromParts > kcal * 1.3 + 30 || fromParts < kcal * 0.6 - 30)
      odd.push(`calories (${kcal}) don't fit protein, carbs and fat (about ${Math.round(fromParts)})`);
  }
  if (fiber !== null && carb !== null && fiber > carb * 0.5 && fiber > 5) odd.push(`fiber ${fiber} g is high for ${carb} g of carbs`);
  if (protein !== null && kcal !== null && protein * 4 > kcal * 1.05 + 10) odd.push("more calories from protein than in total");
  if (protein !== null && protein > 150) odd.push(`protein ${protein} g`);
  if (kcal !== null && kcal > 3000) odd.push(`${kcal} kcal`);
  if (sodium !== null && sodium > 6000) odd.push(`sodium ${sodium} mg`);
  if (odd.length) out.push({ code: "implausible_nutrition", level: "check", words: `Nutrition looks odd: ${odd.join("; ")}` });

  const isMeal = type === null || MEAL_TYPES.includes(type);
  if (isMeal && type !== null && !facts.some((f) => f.kind === "price"))
    out.push({ code: "missing_price", level: "note", words: "No price drafted" });
  if (isMeal && !d.facts.some((f) => f.kind === "dietary_status"))
    out.push({ code: "no_dietary_evidence", level: "check", words: "No vegetarian or vegan evidence drafted" });
  if (type === null) out.push({ code: "unclassified", level: "check", words: "Not sorted into meal, part, side or drink yet" });
  if (d.facts.some((f) => f.status === "submitted" && f.confidence === "low"))
    out.push({ code: "low_confidence", level: "check", words: "The drafter was unsure about part of this row" });
  if (facts.some((f) => value(f).basis === "published_range"))
    out.push({ code: "published_range", level: "note", words: "Nutrition is a published range, kept as a range" });
  if (facts.some((f) => value(f).basis === "restaurant_estimate"))
    out.push({ code: "restaurant_estimate", level: "note", words: "Nutrition is the restaurant's own estimate" });
  if (d.facts.some((f) => f.unknown)) out.push({ code: "unknown_value", level: "note", words: "Some values are not stated and stay unknown" });
  // A meal priced far from the place's other meals is often a misread price (a size, a combo or a typo).
  const price = (x: MenuDish) => {
    const f = live(x).find((y) => y.kind === "price");
    const n = f ? Number(value(f).usd) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const mine = type !== null && MEAL_TYPES.includes(type) ? price(d) : null;
  if (mine !== null) {
    const others = place.dishes
      .filter((o) => o.dishId !== d.dishId && o.structure && MEAL_TYPES.includes(o.structure.type))
      .map(price)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    if (others.length >= 4) {
      const median = others[Math.floor(others.length / 2)];
      if (mine > median * 2.5 || mine < median / 2.5)
        out.push({ code: "price_outlier", level: "check", words: `Price $${mine.toFixed(2)} is far from this menu's usual $${median.toFixed(2)} for a meal` });
    }
  }
  const e = d.estimate ?? null;
  if (e && hasRestaurantProtein(d))
    out.push({ code: "estimate_and_published", level: "check", words: "Has both a USDA estimate and the restaurant's own protein figure; the restaurant's figure wins" });
  else if (e?.state === "modelled" && e.result.state === "estimated")
    out.push({ code: "usda_estimate", level: "note", words: `${estimateWords(e)}. Assumptions not reviewed yet` });
  else if (e) out.push({ code: "estimate_unknown", level: "note", words: estimateWords(e) });
  if (isMeal && type !== null && d.facts.some((f) => f.kind === "dietary_status") && !d.facts.some((f) => f.kind === "dietary_status" && !f.unknown))
    out.push({ code: "diet_not_stated", level: "note", words: "The menu does not say whether this is vegetarian or vegan; it stays unknown" });
  // A meal with no vegetarian or vegan claim whose own name or listed ingredients name meat or fish.
  // This changes no dietary status; it asks the founder whether the row belongs in a vegetarian catalog.
  const claimed = (vegan && value(vegan).status === "yes") || (veg && value(veg).status === "yes");
  const named = [...has([d.label], ANIMAL), ...meat];
  if (isMeal && type !== null && !claimed && named.length)
    out.push({ code: "names_meat", level: "check", words: "Its name or ingredients name meat or fish and the menu makes no vegetarian claim: probably not a vegetarian meal" });
  // The automatic comparison with the saved source page (never a check by the founder).
  const auto = automaticState(d);
  if (auto.notFound.length) {
    const first = auto.notFound[0].machineCheck?.detail ?? "";
    out.push({ code: "automatic_not_found", level: "check", words: `The automatic comparison couldn't find this on the saved page: ${first}${auto.notFound.length > 1 ? ` (and ${auto.notFound.length - 1} more)` : ""}` });
  } else if (auto.allFound)
    out.push({ code: "automatic_found", level: "note", words: "An automatic comparison found every drafted value on the saved page. That is not a check by you" });
  if (d.structure?.parentDishId) {
    const parent = place.dishes.find((p) => p.dishId === d.structure?.parentDishId);
    out.push({ code: "part_of_meal", level: "note", words: `Part of “${parent?.label ?? "a build-your-own meal"}”, not counted as a meal` });
  }
  return out;
}

export const isException = (flags: Flag[]) => flags.some((f) => f.level === "check");

/**
 * Where the automatic comparison stands for a row's waiting facts. allFound only when every waiting
 * fact, including any recorded as unknown, was found on the saved page: the comparison cannot show
 * that a menu leaves something out, so a row with an unknown value is never "all found".
 */
export function automaticState(d: MenuDish) {
  const waiting = d.facts.filter((f) => f.status === "submitted" && !f.statuses.transcriptionConfirmed);
  const notFound = waiting.filter((f) => f.machineCheck?.result === "not_found");
  const allFound = waiting.length > 0 && waiting.every((f) => f.machineCheck?.result === "found");
  return { notFound, allFound };
}

/**
 * Clean rows that can be confirmed together: their waiting facts come from the same set of sources
 * (for example a menu page and the restaurant's nutrition guide), sit in the same menu section and all
 * get the same kind of confirmation. Rows with any "check" flag are left out and reviewed one at a time.
 */
export type CleanGroup = {
  key: string;
  sourceIds: string[];
  method: "verify" | "transcription";
  /** The menu section the rows come from, when they were sorted by section. */
  section: string | null;
  dishIds: string[];
  facts: number;
  /** Every waiting fact in every row was found by the automatic comparison (not a check by the founder). */
  automaticAllFound: boolean;
};
export function cleanGroups(place: Pick<MenuPlace, "dishes">): CleanGroup[] {
  const groups = new Map<string, CleanGroup>();
  for (const d of place.dishes) {
    if (!rowWaiting(d) || !rowConfirmable(d) || isException(rowFlags(d, place))) continue;
    const waiting = d.facts.filter((f) => f.canConfirm && f.confirmAs);
    const sourceIds = [...new Set(waiting.map((f) => f.sourceId))].sort();
    const methods = new Set(waiting.map((f) => f.confirmAs));
    if (sourceIds.length === 0 || methods.size !== 1) continue;
    const method = [...methods][0] as "verify" | "transcription";
    // Rows from one part of the menu are compared together, so each group is one stretch of the page.
    const section = d.structure?.section ?? null;
    const key = `${sourceIds.join("+")}:${method}:${section ?? ""}`;
    const g = groups.get(key) ?? { key, sourceIds, method, section, dishIds: [], facts: 0, automaticAllFound: true };
    g.dishIds.push(d.dishId);
    g.automaticAllFound = g.automaticAllFound && automaticState(d).allFound;
    g.facts += waiting.length;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.dishIds.length - a.dishIds.length);
}

/** Whether a name names meat or fish (the same words as the "names meat" pre-check). */
export const namesMeat = (label: string) => has([label], ANIMAL).length > 0;
