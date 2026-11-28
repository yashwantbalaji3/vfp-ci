import type { IngredientFamily } from "@/domain/dietary/families";
import { INGREDIENT_FAMILIES } from "@/domain/dietary/families";
import { describeDietChoice, familyWord, hasDietChoice, type DietChoice } from "@/domain/dietary/labels";
import type { MenuDish } from "./menu-review";

/**
 * One diet check for every real-menu screen (owner direction 20 Nov 2026 03:27 UTC, P0; docs/63).
 *
 * The person's saved diet (vegan, vegetarian, none) and ingredient exclusions (egg, dairy, ...) are applied to
 * every real meal the same way: in search (also from a typed or shared address), on Discover, on restaurant
 * pages, in Protein Explorer, in the diary's protein-to-go ideas, on a meal's own page and in saved meals.
 *
 * Three answers, never more hopeful than the evidence:
 *   - "eligible": the restaurant's own words cover the diet, and nothing it lists conflicts with an exclusion.
 *   - "ineligible": the restaurant says it isn't (vegan/vegetarian "no"), its name or ingredients name meat,
 *     or it lists an excluded ingredient (in its ingredient list or its allergen list). A known excluded
 *     ingredient is never a match, even when the restaurant labels the meal vegan: that is a contradiction,
 *     and the ingredient wins.
 *   - "needs_confirmation": the evidence is missing, ambiguous ("creamy sauce" for dairy) or contradictory
 *     (two labels that disagree). Unknown never becomes eligible.
 *
 * Two kinds of evidence stay apart in every answer: what the restaurant states (its diet label), and our own
 * reading of the ingredients and allergens it lists. Our reading only ever removes or holds back a meal; it
 * never adds a diet the restaurant didn't state.
 *
 * Allergens and cross-contact: the restaurant's allergen list is shown as its own words. Nothing here is an
 * allergy guarantee, and cross-contact is never assumed absent.
 */

export type Claim = "yes" | "no" | null;
export type FoundFamily = { family: IngredientFamily; word: string; from: "ingredients" | "allergens" };
export type DietEvidence = {
  veganClaim: Claim;
  vegetarianClaim: Claim;
  /** The restaurant's listed ingredients, as written; null when the menu lists none. */
  ingredients: string[] | null;
  /** The restaurant's own allergen "contains" list; null when the menu gives none. */
  allergens: string[] | null;
  /** Ingredient families the restaurant's own lists name. */
  found: FoundFamily[];
  /** Listed words that may or may not be an ingredient family ("creamy sauce" for dairy). */
  unclear: { family: IngredientFamily; word: string }[];
  /** Its name or listed ingredients name meat or fish with no vegetarian claim. */
  namesMeat: boolean;
};

// Word-bounded, so "Thai eggplant" is never egg and "peanuts" never butter. Plant milks and butters are left out.
const FAMILY_WORDS: [IngredientFamily, RegExp][] = [
  ["egg", /\b(eggs?|egg ?wash|mayo(nnaise)?|aioli|meringue)\b/i],
  ["dairy", /\b(cream|creamed|cheese|cheeses|paneer|yogh?urt|ghee|labn[eé]h?|feta|ricotta|mozzarella|parmesan|cheddar|whey|buttermilk|milk|butter|malai|dahi|raita)\b/i],
  ["honey", /\bhoney\b/i],
  ["gelatin", /\bgelatine?\b/i],
  ["animal_stock", /\b(chicken|beef|pork|bone|fish) (stock|broth)\b/i],
  ["fish_sauce", /\bfish sauce\b/i],
  ["animal_rennet", /\brennet\b/i],
];
const NOT_ANIMAL = /\b(coconut|almond|oat|soy|soya|cashew|rice|plant|vegan|peanut|cocoa|nut|seed|sunflower|apple)[ -](milk|cream|cheese|butter|yogh?urt|mayo(nnaise)?)\b/i;
// Words that can hide a family without naming it. They hold a meal back; they never exclude it.
const UNCLEAR: [IngredientFamily, RegExp][] = [
  ["dairy", /\b(creamy|korma|makhani|tikka masala|naan|bechamel|alfredo)\b/i],
  ["egg", /\b(vegetarian ham|mock meat|noodles?|batter(ed)?|tempura)\b/i],
];
const ALLERGEN_FAMILY: Record<string, IngredientFamily> = { egg: "egg", eggs: "egg", dairy: "dairy", milk: "dairy" };

const claim = (d: MenuDish, subject: string): Claim => {
  const v = d.facts.find((f) => f.kind === "dietary_status" && f.subject === subject && !f.unknown)?.value?.status;
  return v === "yes" || v === "no" ? v : null;
};

/** What the restaurant's own facts say about one dish or part, read the same way everywhere. */
export function dishEvidence(d: MenuDish, namesMeat: boolean): DietEvidence {
  const items = d.facts.find((f) => f.kind === "listed_ingredients" && !f.unknown)?.value?.items;
  const ingredients = Array.isArray(items) ? items.map(String) : null;
  const statement = d.facts.find((f) => f.kind === "allergen_statement" && !f.unknown && f.value?.statement === "contains")?.value?.allergens;
  const allergens = Array.isArray(statement) ? statement.map(String) : null;
  const found: FoundFamily[] = [];
  const unclear: DietEvidence["unclear"] = [];
  for (const word of ingredients ?? []) {
    const plain = word.replace(NOT_ANIMAL, "");
    for (const [family, re] of FAMILY_WORDS) if (re.test(plain)) found.push({ family, word, from: "ingredients" });
    for (const [family, re] of UNCLEAR) if (re.test(plain) && !found.some((f) => f.family === family && f.word === word)) unclear.push({ family, word });
  }
  for (const a of allergens ?? []) {
    const family = ALLERGEN_FAMILY[a.toLowerCase()];
    if (family && !found.some((f) => f.family === family && f.from === "allergens")) found.push({ family, word: a, from: "allergens" });
  }
  return { veganClaim: claim(d, "vegan"), vegetarianClaim: claim(d, "vegetarian"), ingredients, allergens, found, unclear, namesMeat };
}

export type FitStatus = "eligible" | "needs_confirmation" | "ineligible";
export type MealFit = {
  status: FitStatus;
  /** Plain reasons, the strongest first. Empty for an eligible meal with no diet chosen. */
  reasons: string[];
  /** A few words for a card: "Fits: vegan (stated)", "Needs confirmation", "Doesn't fit: lists egg". */
  short: string;
};

const listWord = (f: FoundFamily) => (f.from === "allergens" ? `its allergen list says it contains ${f.word.toLowerCase()}` : `it lists “${f.word}”`);
/** Families the diet itself rules out. Vegan rules out every animal family; vegetarian rules out none of them. */
export const bannedFamilies = (c: DietChoice): IngredientFamily[] =>
  [...new Set([...(c.diet === "vegan" ? INGREDIENT_FAMILIES : []), ...(c.exclusions as IngredientFamily[])])].sort();

/**
 * Whether a meal fits the person's diet choice. Pure, and the only place the answer is decided.
 * With no diet chosen and no exclusions, every meal that isn't left out of discovery is eligible.
 */
export function mealFit(e: DietEvidence, choice: DietChoice): MealFit {
  if (!hasDietChoice(choice)) return { status: "eligible", reasons: [], short: "" };
  const banned = bannedFamilies(choice);
  const no: string[] = [];
  const ask: string[] = [];

  // 1. Meat, and the restaurant's own "no".
  if (e.namesMeat && e.vegetarianClaim !== "yes" && e.veganClaim !== "yes") no.push("its name or ingredients name meat or fish");
  // A vegan "yes" beside a vegetarian "no" is a contradiction (held back below), not a plain "no".
  if (e.vegetarianClaim === "no" && e.veganClaim !== "yes") no.push("the restaurant says it isn't vegetarian");
  if (choice.diet === "vegan" && e.veganClaim === "no") no.push("the restaurant says it isn't vegan");

  // 2. A listed ingredient the person excludes (or the diet rules out). The ingredient wins over a label.
  const conflicts = e.found.filter((f) => banned.includes(f.family));
  for (const f of conflicts) no.push(listWord(f));
  if (conflicts.length && e.veganClaim === "yes") no.push("this contradicts the restaurant's vegan label");

  if (no.length) {
    const first = conflicts[0];
    return {
      status: "ineligible",
      reasons: no.map(cap),
      short: first ? `Doesn't fit: ${first.from === "allergens" ? "contains" : "lists"} ${familyWord(first.family)}` : "Doesn't fit your diet",
    };
  }

  // 3. Labels that disagree.
  if (e.veganClaim === "yes" && e.vegetarianClaim === "no") ask.push("the menu's diet labels contradict each other");

  // 4. The diet itself, by the restaurant's own words only.
  if (choice.diet === "vegan" && e.veganClaim !== "yes")
    ask.push(e.vegetarianClaim === "yes" ? "the restaurant says it's vegetarian but doesn't say it's vegan" : "the restaurant doesn't say it's vegan");
  if (choice.diet === "vegetarian" && e.veganClaim !== "yes" && e.vegetarianClaim !== "yes") ask.push("the restaurant doesn't say it's vegetarian");

  // 5. Each exclusion must be ruled out by the restaurant's words: a vegan label rules out every animal family;
  //    an allergen list that leaves out egg or dairy rules those two out (they are major allergens it must name).
  for (const fam of banned) {
    if (e.veganClaim === "yes") continue;
    if (choice.diet === "vegan") continue; // already held back above unless stated vegan
    const allergenCovered = (fam === "egg" || fam === "dairy") && e.allergens !== null;
    if (!allergenCovered) ask.push(`${familyWord(fam)} isn't ruled out: the restaurant doesn't say`);
  }

  // 6. Ambiguous listed words for a family the person avoids.
  for (const u of e.unclear) if (banned.includes(u.family) && e.veganClaim !== "yes") ask.push(`“${u.word}” may contain ${familyWord(u.family)}`);

  if (ask.length) return { status: "needs_confirmation", reasons: [...new Set(ask)].map(cap), short: "Needs confirmation" };
  return {
    status: "eligible",
    reasons: [stated(e, choice)],
    short: `Fits: ${describeDietChoice(choice).toLowerCase()}`,
  };
}

function stated(e: DietEvidence, c: DietChoice): string {
  const label = e.veganClaim === "yes" ? "vegan" : e.vegetarianClaim === "yes" ? "vegetarian" : null;
  const parts = [label ? `The restaurant says it's ${label}` : "No diet is required"];
  const ex = e.veganClaim === "yes" ? [] : (c.exclusions as IngredientFamily[]);
  if (ex.length && e.allergens) parts.push(`its allergen list doesn't include ${ex.map(familyWord).join(" or ")}`);
  if (e.ingredients && e.found.length === 0) parts.push("our reading of its listed ingredients found nothing it rules out");
  return parts.join("; ");
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The allergen words for a meal page: the restaurant's own list, and never a guarantee. */
export function allergenNote(e: DietEvidence): string {
  const list = e.allergens?.length ? `The restaurant's allergen list says it contains: ${e.allergens.join(", ")}.` : "The restaurant gives no allergen list for this meal.";
  return `${list} Cross-contact isn't stated. This is not an allergy guarantee: ask the restaurant if an allergy matters.`;
}

/** What the restaurant states, kept apart from our reading of its lists. */
export function evidenceWords(e: DietEvidence): { stated: string; ourReading: string } {
  const labels = [e.veganClaim && `vegan: ${e.veganClaim}`, e.vegetarianClaim && `vegetarian: ${e.vegetarianClaim}`].filter(Boolean);
  const stated = labels.length ? `The restaurant's own label (${labels.join(", ")}).` : "The restaurant gives no diet label.";
  const ourReading = e.ingredients
    ? e.found.length || e.unclear.length
      ? `Our reading of its listed ingredients: ${[...e.found.filter((f) => f.from === "ingredients").map((f) => `“${f.word}” is ${familyWord(f.family)}`), ...e.unclear.map((u) => `“${u.word}” may contain ${familyWord(u.family)}`)].join("; ")}. Lists can be incomplete.`
      : "Our reading of its listed ingredients found no egg, dairy, honey or other animal ingredient. Lists can be incomplete."
    : "The menu lists no ingredients, so we can't check them.";
  return { stated, ourReading };
}

/**
 * Which group a meal falls in under the person's diet: shown by default ("match"), shown only in the labelled
 * "Needs confirmation" view, or left out unless the person explicitly broadens to every meal ("hidden").
 */
export type FitGroup = "match" | "needs_confirmation" | "hidden";
export const fitGroup = (f: Pick<MealFit, "status">): FitGroup => (f.status === "eligible" ? "match" : f.status === "ineligible" ? "hidden" : "needs_confirmation");

/** The views a list of real meals offers: the person's diet (default), "Needs confirmation", and every meal. */
export const FIT_VIEWS = ["mine", "check", "all"] as const;
export type FitView = (typeof FIT_VIEWS)[number];
export const readFitView = (raw: unknown): FitView => (FIT_VIEWS.includes(raw as FitView) ? (raw as FitView) : "mine");
export const inFitView = (f: Pick<MealFit, "status">, v: FitView) => (v === "all" ? true : v === "check" ? f.status === "needs_confirmation" : f.status === "eligible");

/**
 * The diet in force on a real-menu list. A saved diet choice always wins: an address's `diet=` can't widen it
 * (so a shared or typed link never silently shows a vegan person egg dishes). With no saved choice, the
 * address's `diet=vegetarian|vegan` is a temporary filter. Broadening is only ever `fit=all` (or `fit=check`),
 * which the page states.
 */
export type MealLens = { choice: DietChoice; saved: boolean; view: FitView };
export function mealLens(pref: DietChoice, dietParam: unknown, fitParam: unknown): MealLens {
  const view = readFitView(fitParam);
  if (hasDietChoice(pref)) return { choice: pref, saved: true, view };
  const d = dietParam === "vegan" || dietParam === "vegetarian" ? dietParam : "none";
  return { choice: { diet: d, exclusions: [], includeConditional: false }, saved: false, view: d === "none" ? "mine" : view };
}

/** Attach each meal's fit and keep the ones in view. Counts are for every view, so the page can offer them. */
export function applyLens<T extends { evidence: DietEvidence; excluded?: string | null }>(meals: T[], lens: Pick<MealLens, "choice" | "view">) {
  const all = meals.filter((m) => !m.excluded).map((m) => ({ ...m, fit: mealFit(m.evidence, lens.choice) }));
  const counts: Record<FitView, number> = { mine: all.filter((m) => m.fit.status === "eligible").length, check: all.filter((m) => m.fit.status === "needs_confirmation").length, all: all.length };
  return { shown: all.filter((m) => inFitView(m.fit, lens.view)), counts };
}

/**
 * A build-your-own combination fits only when every chosen part fits: one part that doesn't fit rules the
 * combination out, and one that needs confirmation holds it back. Reasons name the part.
 */
export function combinationFit(parts: { label: string; evidence: DietEvidence }[], choice: DietChoice): MealFit {
  if (!hasDietChoice(choice) || parts.length === 0) return { status: "eligible", reasons: [], short: "" };
  const fits = parts.map((p) => ({ p, f: mealFit(p.evidence, choice) }));
  const no = fits.filter((x) => x.f.status === "ineligible");
  const ask = fits.filter((x) => x.f.status === "needs_confirmation");
  if (no.length) return { status: "ineligible", reasons: no.map((x) => `${x.p.label}: ${x.f.reasons[0]?.toLowerCase() ?? "doesn't fit"}`), short: `Doesn't fit: ${no[0].p.label}` };
  if (ask.length) return { status: "needs_confirmation", reasons: ask.map((x) => `${x.p.label}: ${x.f.reasons[0]?.toLowerCase() ?? "needs confirmation"}`), short: "Needs confirmation" };
  return { status: "eligible", reasons: [`Every chosen item fits ${describeDietChoice(choice).toLowerCase()} by the restaurant's own words`], short: `Fits: ${describeDietChoice(choice).toLowerCase()}` };
}

/** Counts for the temporary diet tabs offered when no diet is saved: meals that fit each diet by the shared check. */
export function dietTabCounts<T extends { evidence: DietEvidence; excluded?: string | null }>(meals: T[]): Record<"any" | "vegetarian" | "vegan", number> {
  const n = (diet: "none" | "vegetarian" | "vegan") => applyLens(meals, { choice: { diet, exclusions: [] }, view: "mine" }).counts.mine;
  return { any: n("none"), vegetarian: n("vegetarian"), vegan: n("vegan") };
}
