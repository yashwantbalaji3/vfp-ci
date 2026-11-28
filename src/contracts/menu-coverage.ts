import { cleanGroups, isException, rowFlags } from "./menu-prechecks";
import { hasRestaurantProtein, isGroupPlatter, rowWaiting, type MenuDish, type MenuPlace } from "./menu-review";

/**
 * Coverage of the private drafted menus (owner direction 18 Nov 2026 20:56 UTC): what kinds of rows
 * there are, where each meal's protein figure comes from, what dietary evidence the menus give, and how
 * much review is left. Every count stays separate: complete meals are never mixed with build-your-own
 * meals or their parts, published nutrition is never mixed with estimates, and an estimate never counts
 * as dietary evidence. These are counts of drafts, not of anything checked or published.
 */
export type Coverage = {
  rows: number;
  completeMeals: number;
  /** Complete dishes made for a group (catering trays): counted here, never as one person's meal. */
  groupPlatters: number;
  customizableMeals: number;
  parts: number;
  sidesDrinksDesserts: number;
  unclassified: number;
  /** Complete meals by where their protein figure comes from (each meal in exactly one bucket). */
  protein: {
    publishedValue: number;
    publishedRange: number;
    restaurantEstimate: number;
    usdaEstimate: number;
    usdaUnknown: number;
    none: number;
  };
  /** Complete meals with any nutrition figure printed by the restaurant (any nutrient, any basis). */
  mealsWithPublishedNutrition: number;
  /**
   * Complete meals only, by the menu's own dietary statements; each complete meal is in exactly one
   * bucket, so the buckets add up to completeMeals. (Until 18 Nov 23:20 UTC this also counted the
   * build-your-own meals, which made it add up to 102 against 100 complete meals.)
   */
  dietary: Diet;
  /** Build-your-own meals, counted on their own. */
  dietaryBuildYourOwn: Diet;
  /** Complete meals whose menu says nothing about diet but whose name or listed ingredients name meat or fish. */
  namesMeatWithoutClaim: number;
  review: { exceptions: number; cleanWaiting: number; cleanGroups: number; waitingRows: number; transcriptionsConfirmed: number };
};

type Diet = { veganStated: number; vegetarianStated: number; notVegetarian: number; notStated: number; noEvidence: number };
const PART_TYPES = ["component", "base", "protein", "topping_sauce"];
const noDiet = (): Diet => ({ veganStated: 0, vegetarianStated: 0, notVegetarian: 0, notStated: 0, noEvidence: 0 });
/** Which one dietary bucket a meal falls in, from the menu's own statements only. */
export function dietBucket(d: MenuDish): keyof Diet {
  const vegan = status(d, "vegan");
  const veg = status(d, "vegetarian");
  if (vegan === "yes") return "veganStated";
  if (veg === "yes") return "vegetarianStated";
  if (veg === "no") return "notVegetarian";
  if (d.facts.some((f) => f.kind === "dietary_status")) return "notStated";
  return "noEvidence";
}
const status = (d: MenuDish, claim: string) =>
  d.facts.find((f) => f.kind === "dietary_status" && f.subject === claim && !f.unknown)?.value?.status as string | undefined;

/** Where one complete meal's protein figure comes from. */
export function proteinSource(d: MenuDish): keyof Coverage["protein"] {
  if (hasRestaurantProtein(d)) {
    const f = d.facts.find((x) => x.kind === "published_nutrition" && x.subject === "protein_g" && !x.unknown && x.value);
    const basis = (f?.value?.basis as string | undefined) ?? "published";
    return basis === "published_range" ? "publishedRange" : basis === "restaurant_estimate" ? "restaurantEstimate" : "publishedValue";
  }
  const e = d.estimate;
  if (!e) return "none";
  return e.state === "modelled" && e.result.state === "estimated" ? "usdaEstimate" : "usdaUnknown";
}

export function placeCoverage(place: Pick<MenuPlace, "dishes">): Coverage {
  const c: Coverage = {
    rows: place.dishes.length,
    completeMeals: 0,
    groupPlatters: 0,
    customizableMeals: 0,
    parts: 0,
    sidesDrinksDesserts: 0,
    unclassified: 0,
    protein: { publishedValue: 0, publishedRange: 0, restaurantEstimate: 0, usdaEstimate: 0, usdaUnknown: 0, none: 0 },
    mealsWithPublishedNutrition: 0,
    dietary: noDiet(),
    dietaryBuildYourOwn: noDiet(),
    namesMeatWithoutClaim: 0,
    review: { exceptions: 0, cleanWaiting: 0, cleanGroups: cleanGroups(place).length, waitingRows: 0, transcriptionsConfirmed: 0 },
  };
  for (const d of place.dishes) {
    const platter = d.structure?.type === "complete_meal" && isGroupPlatter(d);
    const type = platter ? null : (d.structure?.type ?? null);
    if (platter) c.groupPlatters += 1;
    else if (type === "complete_meal") c.completeMeals += 1;
    else if (type === "customizable_meal") c.customizableMeals += 1;
    else if (type && PART_TYPES.includes(type)) c.parts += 1;
    else if (type) c.sidesDrinksDesserts += 1;
    else if (!platter) c.unclassified += 1;

    if (type === "complete_meal") {
      c.protein[proteinSource(d)] += 1;
      if (d.facts.some((f) => f.kind === "published_nutrition" && !f.unknown && f.value)) c.mealsWithPublishedNutrition += 1;
    }
    if (type === "complete_meal") {
      c.dietary[dietBucket(d)] += 1;
      if (rowFlags(d, place).some((f) => f.code === "names_meat")) c.namesMeatWithoutClaim += 1;
    } else if (type === "customizable_meal") c.dietaryBuildYourOwn[dietBucket(d)] += 1;

    const waiting = rowWaiting(d);
    if (waiting) c.review.waitingRows += 1;
    if (waiting) {
      if (isException(rowFlags(d, place))) c.review.exceptions += 1;
      else c.review.cleanWaiting += 1;
    }
    c.review.transcriptionsConfirmed += d.facts.filter((f) => f.statuses.transcriptionConfirmed).length;
  }
  return c;
}

/** Adds coverage figures together (all counts are additive). */
export function addCoverage(list: Coverage[]): Coverage {
  const add = (a: unknown, b: unknown): unknown =>
    typeof a === "number" ? a + (b as number) : Object.fromEntries(Object.entries(a as object).map(([k, v]) => [k, add(v, (b as Record<string, unknown>)[k])]));
  return list.reduce((a, b) => add(a, b) as Coverage, placeCoverage({ dishes: [] }));
}
