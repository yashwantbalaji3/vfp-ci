import { z } from "zod";
import { dietHintSchema, type DietHint } from "./places";
import { dishEvidence, mealFit, type DietEvidence } from "./meal-eligibility";
import { dietBucket } from "./menu-coverage";
import { normalLabel, rowFlags } from "./menu-prechecks";
import { hasRestaurantProtein, isGroupPlatter, type MenuDish, type MenuEstimate, type MenuFact, type MenuPlace } from "./menu-review";
import { editionOf, isHistoricalEdition } from "./source-editions";

/**
 * The founder-only private beta on real data (owner direction 19 Nov 2026 01:08 UTC, docs/59).
 *
 * The drafted real menus are shown to the founder in Discover, on place pages and in Protein Explorer
 * under an "Unverified preview" label. Nothing here confirms, verifies or publishes anything; a meal is
 * "confirmed by you" only when the founder confirmed every one of its facts, and an accepted automatic
 * comparison is never called the founder's own comparison.
 *
 * Diet: exactly the menu's own words. A meal is vegan or vegetarian only when the restaurant says so;
 * "unknown" never qualifies for a vegetarian or vegan filter. A meal whose name or ingredients name meat
 * or fish with no vegetarian claim is left out of discovery entirely (the three NAYA chicken and beef
 * meals), but stays on its place page in a folded list, with its history kept.
 *
 * Protein: one figure per meal, by the best evidence: the restaurant's printed number, its printed range,
 * its own estimate, a USDA range (with its assumptions and confidence, never called verified), or unknown.
 */

export const previewIndexSchema = z.array(
  z.object({
    placeId: z.string().uuid(),
    label: z.string(),
    listingId: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    street: z.string(),
    area: z.string().nullable(),
    lat: z.number(),
    lon: z.number(),
    /** Cuisine from the open place data (Overture), "possibly" for an alternate category. Says nothing about diet. */
    cuisines: z.array(z.object({ cuisine: z.string(), basis: z.string() }).passthrough()).default([]),
    /** The open map's vegetarian/vegan category for the place (place-level, attributed; never a dish's diet). */
    dietHints: z.array(dietHintSchema).default([]),
    linkMethod: z.enum(["address_match", "website_match", "person"]),
    linkedAt: z.string(),
  }),
);
export type PreviewIndexEntry = z.infer<typeof previewIndexSchema>[number];

/**
 * The open map's place-level diet hints that the restaurant's own menu does not contradict (owner 23 Nov 2026
 * 17:49 UTC, "address misleading vegetarian place hints"). A "vegetarian restaurant" hint is dropped when any meal
 * on the drafted menu doesn't fit vegetarian by the shared check (it names meat, or the restaurant says it isn't
 * vegetarian); a "vegan restaurant" hint likewise for vegan. Dropping a hint never adds a claim: meal diets still
 * come only from the restaurant's own labels.
 */
export function menuAgreedHints(hints: DietHint[], meals: { evidence: DietEvidence }[]): DietHint[] {
  return hints.filter((h) => !meals.some((m) => mealFit(m.evidence, { diet: h.hint, exclusions: [] }).status === "ineligible"));
}

const MEAT_WORDS = /\b(steak|asada|carnitas|chicken|beef|pork|bacon|ham|sausage|chorizo|turkey|lamb|fish|tuna|salmon|shrimp|crab|lobster|meatballs?|pepperoni|wings?)\b/i;
const PLANT_WORDS = /\b(plant[- ]based|vegan|vegetarian|veggie|meatless|meat[- ]free|beyond|impossible|tofu|seitan|tempeh|jackfruit|soy)\b/i;
const DIET_SECTION = /\b(vegetarian|vegan|plant|veggie|meatless)/i;

/**
 * Short notes that stop a card from reading wrongly at a glance (bugs B3 and B6, docs/68). Neither changes the
 * diet: that still comes only from the restaurant's own labels.
 * - A meat word in the name of a meal the restaurant labels vegan or vegetarian ("Steak Asada Burrito" at a
 *   vegan restaurant) gets "Plant-based, as the restaurant labels it".
 * - A section name that sounds like a diet ("Vegetarian Specialties") beside "Diet unknown" gets the reason.
 */
export function cardNotes(m: Pick<PreviewMeal, "label" | "section" | "diet">): { plant: string | null; section: string | null } {
  const stated = m.diet === "vegan_stated" || m.diet === "vegetarian_stated";
  const plant = stated && MEAT_WORDS.test(m.label) && !PLANT_WORDS.test(m.label) ? `Plant-based: the restaurant labels it ${m.diet === "vegan_stated" ? "vegan" : "vegetarian"}` : null;
  const section = m.diet === "unknown" && m.section && DIET_SECTION.test(m.section) ? "A section name is not a diet label, and the menu doesn't label this dish" : null;
  return { plant, section };
}

/**
 * Two branches of one restaurant must not look the same on a card or a chip (bug B2, docs/68): where more than
 * one place in the preview shares a name, each one's name gains its street, as in "Cafe Landwer (653 Boylston St)".
 */
export function distinctBranchNames<T extends { name: string; street: string }>(entries: T[]): T[] {
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.name.toLowerCase(), (count.get(e.name.toLowerCase()) ?? 0) + 1);
  return entries.map((e) => ((count.get(e.name.toLowerCase()) ?? 0) > 1 && e.street ? { ...e, name: `${e.name} (${e.street})` } : e));
}

export type PreviewDiet = "vegan_stated" | "vegetarian_stated" | "unknown" | "not_vegetarian";
export const DIET_WORDS: Record<PreviewDiet, string> = {
  vegan_stated: "Vegan, as the restaurant states",
  vegetarian_stated: "Vegetarian, as the restaurant states",
  unknown: "Diet not stated by the restaurant",
  not_vegetarian: "Not vegetarian, as the restaurant states",
};
export const DIET_SHORT: Record<PreviewDiet, string> = {
  vegan_stated: "Vegan (stated)",
  vegetarian_stated: "Vegetarian (stated)",
  unknown: "Diet unknown",
  not_vegetarian: "Not vegetarian",
};

export type ProteinBasis = "published" | "published_range" | "restaurant_estimate" | "usda_range" | "unknown";
export const PROTEIN_BASIS_WORDS: Record<ProteinBasis, string> = {
  published: "Printed by the restaurant",
  published_range: "Range printed by the restaurant",
  restaurant_estimate: "The restaurant's own estimate",
  usda_range: "USDA estimate, not the restaurant's figure",
  unknown: "Protein unknown",
};

export type PreviewProtein = {
  basis: ProteinBasis;
  /** Grams for one serving as the menu describes it. A single value has low = high. Null when unknown. */
  low: number | null;
  high: number | null;
  /** Sorting uses the low end, so a range never outranks a printed figure on hope. */
  sortValue: number | null;
  words: string;
  portion: string | null;
  usda: null | {
    confidence: "high" | "medium" | "low" | null;
    assumptions: string | null;
    servingBasis: string;
    modelReviewed: boolean;
    lines: { label: string; usda: string; gramsLow: number; gramsHigh: number; amountBasis: string }[];
  };
  unknownReason: string | null;
};

export type AutoCheck = {
  code: "dish_to_value" | "serving_basis" | "option_dependent" | "duplicate_listing" | "conflicting_nutrition" | "source_age";
  level: "check" | "note";
  words: string;
};

export type PreviewMeal = {
  dishId: string;
  placeId: string;
  label: string;
  section: string | null;
  diet: PreviewDiet;
  /** Left out of discovery (Discover, Protein Explorer); still listed on the place page. */
  excluded: string | null;
  /** The restaurant's own diet labels, ingredient and allergen lists, read once for the shared diet check. */
  evidence: DietEvidence;
  protein: PreviewProtein;
  kcal: number | null;
  /** A current price only: null when the menu states an old edition (see source-editions.ts). */
  priceUsd: string | null;
  /** The price on an old menu edition, kept as source evidence and never shown as current. */
  historicalPrice: { usd: string; edition: string } | null;
  sourceUrl: string | null;
  checkedOn: string | null;
  /** Every fact of the meal was confirmed by the founder (their own comparison or an accepted automatic one). */
  confirmed: boolean;
  confirmedAutomatically: boolean;
  /** The automatic comparison with the saved page: counts of the meal's facts. Never a check by the founder. */
  machine: { found: number; notFound: number; notChecked: number; boundedByNextDish: number };
  autoChecks: AutoCheck[];
  /** The founder pre-check flags that need a look (exceptions on the review page). */
  exceptions: string[];
};

const live = (d: MenuDish) => d.facts.filter((f) => !f.unknown && f.value);
const val = (f: MenuFact) => (f.value ?? {}) as Record<string, unknown>;
const num = (x: unknown) => (x === null || x === undefined || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
const nutrient = (d: MenuDish, n: string) => live(d).find((f) => f.kind === "published_nutrition" && f.subject === n);
const g = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function previewDiet(d: MenuDish): PreviewDiet {
  const b = dietBucket(d);
  return b === "veganStated" ? "vegan_stated" : b === "vegetarianStated" ? "vegetarian_stated" : b === "notVegetarian" ? "not_vegetarian" : "unknown";
}

function usdaPart(e: Extract<MenuEstimate, { state: "modelled" }>): PreviewProtein["usda"] {
  return {
    confidence: e.result.confidence,
    assumptions: e.assumptions,
    servingBasis: e.servingBasis,
    modelReviewed: e.modelStatus === "published",
    lines: e.lines.map((l) => ({ label: l.label, usda: l.usda, gramsLow: l.gramsLow, gramsHigh: l.gramsHigh, amountBasis: l.amountBasis })),
  };
}

const ESTIMATE_REASONS: Record<string, string> = {
  range_too_wide: "the likely USDA range is too wide to be useful",
  missing_reference_value: "an ingredient has no USDA protein value",
  missing_yield_factor: "an ingredient needs a cooked-to-raw conversion that is not on file",
};

export function previewProtein(d: MenuDish): PreviewProtein {
  const none = { usda: null, unknownReason: null, portion: null } as const;
  if (hasRestaurantProtein(d)) {
    const f = nutrient(d, "protein_g")!;
    const v = val(f);
    const portion = v.per === "100g" ? "per 100 g" : v.portion ? `per serving (“${String(v.portion)}” on the menu)` : "per serving";
    const basis = (v.basis as string | undefined) ?? "published";
    if (basis === "published_range") {
      const lo = num(v.low);
      const hi = num(v.high);
      return { ...none, basis: "published_range", low: lo, high: hi, sortValue: lo, portion, words: `${g(lo ?? 0)} to ${g(hi ?? 0)} g protein ${portion}, a range printed by the restaurant` };
    }
    const a = num(v.amount);
    if (basis === "restaurant_estimate")
      return { ...none, basis: "restaurant_estimate", low: a, high: a, sortValue: a, portion, words: `About ${g(a ?? 0)} g protein ${portion}, the restaurant's own estimate` };
    return { ...none, basis: "published", low: a, high: a, sortValue: a, portion, words: `${g(a ?? 0)} g protein ${portion}, printed by the restaurant` };
  }
  const e = d.estimate;
  if (e?.state === "modelled" && e.result.state === "estimated" && e.result.low !== null && e.result.high !== null) {
    const lo = Math.floor(e.result.low);
    const hi = Math.ceil(e.result.high);
    return {
      basis: "usda_range",
      low: lo,
      high: hi,
      sortValue: lo,
      portion: e.servingBasis,
      usda: usdaPart(e),
      unknownReason: null,
      words: `USDA estimate: about ${lo} to ${hi} g protein, ${e.result.confidence ?? "low"} confidence. Not the restaurant's figure and not verified`,
    };
  }
  const reason =
    e?.state === "unknown"
      ? e.reason
      : e?.state === "modelled"
        ? `A USDA estimate was tried, but ${ESTIMATE_REASONS[e.result.reason ?? ""] ?? "the model is incomplete"}`
        : "The menu prints no protein figure and no USDA estimate was made";
  return { basis: "unknown", low: null, high: null, sortValue: null, portion: null, usda: e?.state === "modelled" ? usdaPart(e) : null, unknownReason: reason, words: `Protein unknown: ${reason}` };
}

const DAY = 86_400_000;
/**
 * Automatic checks on the drafted data (owner direction 19 Nov 01:08 UTC, item 3). They are evidence for
 * the founder to weigh, never a confirmation, and they change no status.
 */
export function autoChecks(d: MenuDish, place: Pick<MenuPlace, "dishes" | "sources">, now = Date.now()): AutoCheck[] {
  const out: AutoCheck[] = [];
  const facts = live(d);
  const nut = facts.filter((f) => f.kind === "published_nutrition");

  // Dish-to-value: values the comparison found under this dish, or found only under the next dish.
  const misplaced = d.facts.filter((f) => f.machineCheck?.result === "not_found" && /belong to that dish/.test(f.machineCheck.detail));
  if (misplaced.length)
    out.push({ code: "dish_to_value", level: "check", words: `${misplaced.length} drafted ${misplaced.length === 1 ? "value appears" : "values appear"} on the saved page only under the next dish, so ${misplaced.length === 1 ? "it" : "they"} may belong to that dish` });

  // Serving sizes: every nutrition figure should rest on the same serving.
  const bases = new Set(nut.map((f) => (val(f).per === "100g" ? "100 g" : String(val(f).portion ?? "serving"))));
  if (bases.size > 1)
    out.push({ code: "serving_basis", level: "check", words: `Nutrition figures rest on different servings (${[...bases].join(", ")}), so they can't be added up or compared as one` });

  // Configuration options: sizes or swaps change the figures.
  const sizes = d.options.filter((o) => o.kind === "size");
  const swaps = d.options.filter((o) => o.kind === "swap" || o.kind === "add");
  const protein = nutrient(d, "protein_g");
  if (sizes.length && protein && val(protein).basis !== "published_range")
    out.push(
      val(protein).portion
        ? { code: "option_dependent", level: "note", words: `The protein figure is for the ${String(val(protein).portion)} size; the menu also offers ${sizes.map((o) => o.label).join(", ")}, with no figure drafted` }
        : { code: "option_dependent", level: "check", words: `The menu offers ${sizes.length + 1} sizes but one protein figure is drafted; it may be for one size only` },
    );
  else if (swaps.length && (protein || d.estimate))
    out.push({ code: "option_dependent", level: "note", words: `The protein figure is for the meal as listed; ${swaps.length} add-on or swap ${swaps.length === 1 ? "choice changes" : "choices change"} it` });

  // Duplicate listings and conflicting figures: the same dish name drafted twice at this place.
  const twins = place.dishes.filter((o) => o.dishId !== d.dishId && normalLabel(o.label) === normalLabel(d.label));
  for (const t of twins) {
    const diffs: string[] = [];
    for (const n of ["protein_g", "energy_kcal"]) {
      const a = nutrient(d, n);
      const b = nutrient(t, n);
      if (a && b && JSON.stringify([val(a).amount, val(a).low, val(a).high]) !== JSON.stringify([val(b).amount, val(b).low, val(b).high]))
        diffs.push(n === "protein_g" ? "protein" : "calories");
    }
    const pa = facts.find((f) => f.kind === "price");
    const pb = live(t).find((f) => f.kind === "price");
    if (pa && pb && val(pa).usd !== val(pb).usd) diffs.push("price");
    out.push(
      diffs.length
        ? { code: "conflicting_nutrition", level: "check", words: `Listed again as “${t.label}” with a different ${diffs.join(" and ")}` }
        : { code: "duplicate_listing", level: "note", words: `Also listed as “${t.label}”, with the same figures` },
    );
  }
  // Two figures for one nutrient from different source pages.
  const bySubject = new Map<string, Set<string>>();
  for (const f of nut) bySubject.set(String(f.subject), (bySubject.get(String(f.subject)) ?? new Set()).add(JSON.stringify([val(f).amount, val(f).low, val(f).high])));
  const twice = [...bySubject].filter(([, s]) => s.size > 1).map(([k]) => k.replace(/_(g|mg|kcal)$/, ""));
  if (twice.length) out.push({ code: "conflicting_nutrition", level: "check", words: `Two different figures were drafted for ${twice.join(", ")}` });

  // Freshness: the age of the saved copy each value was read from.
  const used = new Set(d.facts.map((f) => f.sourceId));
  const oldest = place.sources.filter((s) => used.has(s.sourceId)).map((s) => Date.parse(s.retrievedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (oldest !== undefined) {
    const days = Math.floor((now - oldest) / DAY);
    if (days > 90) out.push({ code: "source_age", level: "check", words: `The menu was read ${days} days ago; prices and dishes may have changed` });
    else if (days > 30) out.push({ code: "source_age", level: "note", words: `The menu was read ${days} days ago` });
  }
  return out;
}

/** The complete meals of one researched place, as the founder-only preview shows them. A group platter is left out. */
export function previewMeals(place: MenuPlace, now = Date.now()): PreviewMeal[] {
  return place.dishes
    .filter((d) => d.structure?.type === "complete_meal" && !isGroupPlatter(d))
    .map((d) => {
      const flags = rowFlags(d, place);
      const diet = previewDiet(d);
      const namesMeat = flags.some((f) => f.code === "names_meat");
      const price = live(d).find((f) => f.kind === "price");
      const kcal = nutrient(d, "energy_kcal");
      const kcalValue = kcal && (val(kcal).basis ?? "published") !== "published_range" && val(kcal).per !== "100g" ? num(val(kcal).amount) : null;
      const main = price ?? d.facts.find((f) => f.kind === "menu_item") ?? d.facts[0];
      const src = main ? place.sources.find((s) => s.sourceId === main.sourceId) : undefined;
      const priceSrc = price ? place.sources.find((s) => s.sourceId === price.sourceId) : undefined;
      const oldEdition = price && isHistoricalEdition(priceSrc?.url, now) ? editionOf(priceSrc?.url) : null;
      const waiting = d.facts.filter((f) => f.status === "submitted" || f.status === "verified");
      const confirmed = waiting.length > 0 && waiting.every((f) => f.statuses.transcriptionConfirmed);
      const mc = d.facts.map((f) => f.machineCheck).filter(Boolean);
      return {
        dishId: d.dishId,
        placeId: place.placeId,
        label: d.label,
        section: d.structure?.section ?? null,
        diet,
        excluded:
          diet === "not_vegetarian"
            ? "The restaurant says it is not vegetarian"
            : namesMeat
              ? "Its name or listed ingredients name meat, and the menu makes no vegetarian claim"
              : null,
        evidence: dishEvidence(d, namesMeat || diet === "not_vegetarian"),
        protein: previewProtein(d),
        kcal: kcalValue,
        priceUsd: price && !oldEdition ? String(val(price).usd) : null,
        historicalPrice: price && oldEdition ? { usd: String(val(price).usd), edition: oldEdition.label } : null,
        sourceUrl: src?.url ?? null,
        checkedOn: main?.checkedOn ?? null,
        confirmed,
        confirmedAutomatically: confirmed && waiting.some((f) => f.confirmationBasis === "automatic_comparison"),
        machine: {
          found: mc.filter((m) => m!.result === "found").length,
          notFound: mc.filter((m) => m!.result === "not_found").length,
          notChecked: mc.filter((m) => m!.result === "not_checked").length,
          boundedByNextDish: mc.filter((m) => m!.result === "found" && /before the next dish starts/.test(m!.detail)).length,
        },
        autoChecks: autoChecks(d, place, now),
        exceptions: flags.filter((f) => f.level === "check").map((f) => f.words),
      };
    });
}

export const DIET_FILTERS = ["any", "vegetarian", "vegan"] as const;
export type DietFilter = (typeof DIET_FILTERS)[number];
/** Highest protein first by the low end; unknown last; ties by name. */
export function byProtein(a: Pick<PreviewMeal, "protein" | "label">, b: Pick<PreviewMeal, "protein" | "label">) {
  const x = a.protein.sortValue;
  const y = b.protein.sortValue;
  if (x === null && y === null) return a.label.localeCompare(b.label);
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x || a.label.localeCompare(b.label);
}

/** Protein per 100 kcal, only where the restaurant prints calories for the same serving and a protein figure exists. */
export function proteinPer100kcal(m: Pick<PreviewMeal, "protein" | "kcal">): { low: number; high: number } | null {
  if (!m.kcal || m.protein.low === null || m.protein.high === null || m.protein.basis === "usda_range") return null;
  return { low: (m.protein.low / m.kcal) * 100, high: (m.protein.high / m.kcal) * 100 };
}
