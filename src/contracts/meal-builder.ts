import { dietBucket } from "./menu-coverage";
import { dishEvidence, type DietEvidence } from "./meal-eligibility";
import { namesMeat } from "./menu-prechecks";
import type { MenuDish, MenuFact, MenuPlace } from "./menu-review";
import type { PreviewDiet } from "./menu-preview";

/**
 * Build-your-own meals in the founder's private preview (owner direction 19 Nov 2026 04:27 UTC, item 4; docs/60).
 *
 * A build-your-own meal (NAYA's bowl or salad, and its roll) lists its parts: bases, proteins, toppings and
 * sauces. Each part carries the restaurant's own nutrition figures when the restaurant prints them.
 *
 * A total is shown only when it can be added up reliably: every chosen part has a printed protein figure
 * from the restaurant, for the portion the restaurant serves in this meal. The total is labelled as added up
 * from the restaurant's per-item figures; it is never called the restaurant's figure for the combination,
 * which the restaurant does not print. If any chosen part has no printed figure, the total is unknown.
 *
 * Diet of a combination: vegan only when every chosen part is stated vegan; vegetarian only when every
 * chosen part is stated vegetarian or vegan; otherwise unknown, or not vegetarian when a part names meat.
 *
 * Portions and combination rules (owner direction 19 Nov 2026 23:11 UTC, item 4; docs/61):
 *   - A printed figure is added only when it was printed for the portion this meal serves: when the figure
 *     names a portion and the part names its portion in this meal, the two must match. The same topping in a
 *     roll (1 oz) and in a bowl (2 oz) are separate parts with their own figures; nothing is ever scaled.
 *   - A roll is wrapped in exactly one bread (a pita): its pita parts form their own "wrap" step (pick one,
 *     required); the roll's fillings from the nutrition guide stay a "base" step that is optional (pick one or
 *     none), because the menu does not say a filling base is required.
 *   - Exactly one protein; toppings and sauces are unlimited, as the menu says. No double portions are offered,
 *     because the menu offers none.
 */

export type PartGroup = "wrap" | "base" | "protein" | "topping_sauce";
export const PART_GROUPS: readonly PartGroup[] = ["wrap", "base", "protein", "topping_sauce"];
export type GroupRule = { min: number; max: number | null };
export const PART_GROUP_WORDS: Record<PartGroup, { title: string }> = {
  wrap: { title: "Bread" },
  base: { title: "Base" },
  protein: { title: "Protein" },
  topping_sauce: { title: "Toppings and sauces" },
};
export const ruleWords = (r: GroupRule) => (r.max === null ? "Add any" : r.min === 0 ? "Pick one, or none" : "Pick one");
const BREAD = /\b(pita|wrap|tortilla|flatbread|lavash)\b/i;
const isRoll = (label: string) => /\b(roll|wrap|sandwich)\b/i.test(label);

export type Nutrients = { protein: number | null; kcal: number | null; carb: number | null; fat: number | null; fiber: number | null };
export type Part = {
  dishId: string;
  label: string;
  group: PartGroup;
  section: string | null;
  portion: string | null;
  diet: PreviewDiet;
  namesMeat: boolean;
  /** The restaurant's own diet labels and allergen list for this part, for the shared diet check. */
  evidence: DietEvidence;
  /** The restaurant's own printed figures for the portion it serves; null where not printed. */
  printed: Nutrients;
  sourceId: string | null;
  checkedOn: string | null;
};

export type Builder = {
  dishId: string;
  label: string;
  section: string | null;
  parts: Part[];
  /** Parts per group, plant parts first, then alphabetical; meat parts come last and are marked. */
  groups: Record<PartGroup, Part[]>;
  /** How many parts each step takes (an empty step is not shown). */
  rules: Record<PartGroup, GroupRule>;
  sourceUrl: string | null;
  checkedOn: string | null;
};

const live = (d: MenuDish) => d.facts.filter((f) => !f.unknown && f.value);
const num = (x: unknown) => (x === null || x === undefined || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
const portionKey = (p: unknown) => (typeof p === "string" ? p.toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "").trim() : null);
const printedValue = (d: MenuDish, subject: string): number | null => {
  const f: MenuFact | undefined = live(d).find((x) => x.kind === "published_nutrition" && x.subject === subject);
  if (!f) return null;
  const v = f.value as Record<string, unknown>;
  // Only a single printed amount for the served portion can be added up; a range, an estimate or a per-100 g
  // figure cannot.
  if ((v.basis ?? "published") !== "published" || v.per === "100g") return null;
  // A figure printed for another portion than the one this meal serves is never added (nor scaled).
  const printedFor = portionKey(v.portion);
  const served = portionKey(d.structure?.portion);
  if (printedFor && served && printedFor !== served) return null;
  return num(v.amount);
};

const dietOf = (d: MenuDish): PreviewDiet => {
  const b = dietBucket(d);
  return b === "veganStated" ? "vegan_stated" : b === "vegetarianStated" ? "vegetarian_stated" : b === "notVegetarian" ? "not_vegetarian" : "unknown";
};

/** The build-your-own meal with this id at this place, with its parts, or null when it isn't one. */
export function builderFor(place: MenuPlace, dishId: string): Builder | null {
  const meal = place.dishes.find((d) => d.dishId === dishId);
  if (!meal || meal.structure?.type !== "customizable_meal") return null;
  const roll = isRoll(meal.label);
  const parts: Part[] = place.dishes
    .filter((d) => d.structure?.parentDishId === dishId && (["base", "protein", "topping_sauce"] as string[]).includes(d.structure.type))
    .map((d) => {
      const main = d.facts.find((f) => f.kind === "published_nutrition") ?? d.facts[0];
      const type = d.structure!.type as PartGroup;
      return {
        dishId: d.dishId,
        label: d.label,
        group: roll && type === "base" && BREAD.test(d.label) ? "wrap" : type,
        section: d.structure!.section,
        portion: d.structure!.portion,
        diet: dietOf(d),
        namesMeat: namesMeat(d.label),
        evidence: dishEvidence(d, namesMeat(d.label)),
        printed: {
          protein: printedValue(d, "protein_g"),
          kcal: printedValue(d, "energy_kcal"),
          carb: printedValue(d, "carb_g"),
          fat: printedValue(d, "fat_g"),
          fiber: printedValue(d, "fiber_g"),
        },
        sourceId: main?.sourceId ?? null,
        checkedOn: main?.checkedOn ?? null,
      };
    });
  const order = (a: Part, b: Part) => Number(a.namesMeat) - Number(b.namesMeat) || a.label.localeCompare(b.label);
  const groups = Object.fromEntries(PART_GROUPS.map((g) => [g, parts.filter((p) => p.group === g).sort(order)])) as Record<PartGroup, Part[]>;
  const hasWrap = groups.wrap.length > 0;
  const rules: Record<PartGroup, GroupRule> = {
    wrap: { min: hasWrap ? 1 : 0, max: 1 },
    // In a roll the bread is the base; a filling base is optional. Otherwise the base is required.
    base: { min: hasWrap ? 0 : 1, max: 1 },
    protein: { min: 1, max: 1 },
    topping_sauce: { min: 0, max: null },
  };
  const main = meal.facts.find((f) => f.kind === "menu_item") ?? meal.facts[0];
  const src = main ? place.sources.find((s) => s.sourceId === main.sourceId) : undefined;
  return { dishId, label: meal.label, section: meal.structure?.section ?? null, parts, groups, rules, sourceUrl: src?.url ?? null, checkedOn: main?.checkedOn ?? null };
}

export type Selection = { wrap: string | null; base: string | null; protein: string | null; toppings: string[] };
export type Combination = {
  chosen: Part[];
  complete: boolean;
  /** Added up from the restaurant's per-item figures; null unless every chosen part has a printed figure. */
  total: Nutrients;
  missing: Part[];
  /** Required steps not picked yet. */
  needs: PartGroup[];
  /**
   * What the figure may be called (owner direction 20 Nov 2026 03:27 UTC, P1): nothing picked; a subtotal of
   * the selected items while a required step is missing; or a calculated meal total only when the meal is
   * complete and every chosen item has a printed figure. A complete meal with a missing figure is "unknown".
   */
  totalKind: "none" | "subtotal" | "meal_total" | "unknown";
  diet: PreviewDiet;
  words: string;
};

/** Read a selection from the page address, keeping only parts of this meal and one base and protein at most. */
export function readSelection(b: Builder, raw: { wrap?: string; base?: string; protein?: string; top?: string | string[] }): Selection {
  const ids = new Set(b.parts.map((p) => p.dishId));
  const inGroup = (id: string | undefined, g: PartGroup) => (id && ids.has(id) && b.parts.find((p) => p.dishId === id)!.group === g ? id : null);
  const tops = (Array.isArray(raw.top) ? raw.top : raw.top ? [raw.top] : []).filter((id) => inGroup(id, "topping_sauce"));
  return { wrap: inGroup(raw.wrap, "wrap"), base: inGroup(raw.base, "base"), protein: inGroup(raw.protein, "protein"), toppings: [...new Set(tops)].slice(0, 40) };
}

const sum = (parts: Part[], k: keyof Nutrients) => (parts.every((p) => p.printed[k] !== null) ? Math.round(parts.reduce((s, p) => s + p.printed[k]!, 0) * 10) / 10 : null);

/** The total for the chosen parts, and its diet. */
export function combine(b: Builder, s: Selection): Combination {
  const byId = new Map(b.parts.map((p) => [p.dishId, p]));
  const chosen = [s.wrap, s.base, s.protein, ...s.toppings].filter((x): x is string => !!x).map((id) => byId.get(id)!);
  const picked: Record<PartGroup, number> = { wrap: s.wrap ? 1 : 0, base: s.base ? 1 : 0, protein: s.protein ? 1 : 0, topping_sauce: s.toppings.length };
  const needs = PART_GROUPS.filter((g) => b.groups[g].length > 0 && picked[g] < b.rules[g].min);
  const complete = needs.length === 0;
  const missing = chosen.filter((p) => p.printed.protein === null);
  const total: Nutrients = chosen.length
    ? { protein: sum(chosen, "protein"), kcal: sum(chosen, "kcal"), carb: sum(chosen, "carb"), fat: sum(chosen, "fat"), fiber: sum(chosen, "fiber") }
    : { protein: null, kcal: null, carb: null, fat: null, fiber: null };
  const diet: PreviewDiet = !chosen.length
    ? "unknown"
    : chosen.some((p) => p.namesMeat || p.diet === "not_vegetarian")
      ? "not_vegetarian"
      : chosen.every((p) => p.diet === "vegan_stated")
        ? "vegan_stated"
        : chosen.every((p) => p.diet === "vegan_stated" || p.diet === "vegetarian_stated")
          ? "vegetarian_stated"
          : "unknown";
  const words = !chosen.length
    ? `Pick ${needWords(b, PART_GROUPS.filter((g) => b.groups[g].length > 0 && b.rules[g].min > 0))} to see a total.`
    : missing.length
      ? `Total unknown: the restaurant prints no protein figure for ${missing.map((p) => p.label).join(", ")}.`
      : `Added up from the restaurant's own per-item figures for ${chosen.length} ${chosen.length === 1 ? "item" : "items"}. The restaurant doesn't print a figure for this combination, and portions can vary.`;
  const totalKind = !chosen.length ? "none" : !complete ? "subtotal" : missing.length ? "unknown" : "meal_total";
  return { chosen, complete, needs, total, missing, diet, words, totalKind };
}

/** "a bread and a protein", "a base and a protein". */
export function needWords(b: Builder, groups: PartGroup[]) {
  const w = groups.map((g) => (g === "wrap" ? "a bread" : g === "base" ? "a base" : g === "protein" ? "a protein" : "toppings"));
  return w.length <= 1 ? (w[0] ?? "") : `${w.slice(0, -1).join(", ")} and ${w.at(-1)}`;
}
