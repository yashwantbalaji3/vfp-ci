/**
 * Ingredient families and dietary presets (docs/08, docs/18 "Vegetarian preference
 * contract"). The database (app.eligibility) is the single source of truth for
 * eligibility; these constants keep UI labels and presets consistent with it.
 */
export const INGREDIENT_FAMILIES = [
  "egg",
  "dairy",
  "honey",
  "gelatin",
  "animal_stock",
  "fish_sauce",
  "animal_rennet",
] as const;
export type IngredientFamily = (typeof INGREDIENT_FAMILIES)[number];

export type Diet = "none" | "vegetarian" | "vegan";

export type EligibilityStatus = "eligible" | "conditional" | "needs_confirmation" | "excluded";

export type DietaryPreset = {
  id: string;
  label: string;
  explanation: string;
  diet: Diet;
  exclusions: IngredientFamily[];
};

/** Shown in onboarding and settings, never hidden in advanced filters. */
export const DIETARY_PRESETS: DietaryPreset[] = [
  {
    id: "vegetarian",
    label: "Vegetarian",
    explanation: "No meat, poultry or fish. Can include eggs, dairy and honey.",
    diet: "vegetarian",
    exclusions: [],
  },
  {
    id: "egg-free-vegetarian",
    label: "Egg-free vegetarian",
    explanation:
      "Vegetarian without eggs, including hidden egg in noodles, egg wash, mayonnaise and binders. Dairy stays allowed unless you also exclude it.",
    diet: "vegetarian",
    exclusions: ["egg"],
  },
  {
    id: "vegan",
    label: "Vegan",
    explanation: "No animal-derived ingredients, including dairy, eggs and honey.",
    diet: "vegan",
    exclusions: [],
  },
];

/**
 * Strict filter rule (owner decision 2026-11-13, docs/18 "Strict dietary filters"):
 * - "match": confirmed compatible. The only group shown by default.
 * - "needs_confirmation": unknown or expired evidence. Never shown as a match; reachable only
 *   through a separate, explicitly labelled "Needs confirmation" view the person chooses to open.
 * - "hidden": confirmed to contain an excluded ingredient, or incompatible. Always excluded.
 * The same function decides grouping for discovery, recipes, substitutions and recommendations.
 */
export type StrictResultGroup = "match" | "needs_confirmation" | "hidden";

export function strictResultGroup(status: EligibilityStatus, includeConditional: boolean): StrictResultGroup {
  if (status === "excluded") return "hidden";
  if (qualifiesForStrictResults(status, includeConditional)) return "match";
  return "needs_confirmation";
}

/** Only "eligible" (and "conditional" when the person opted in) may appear in strict results. */
export function qualifiesForStrictResults(status: EligibilityStatus, includeConditional: boolean): boolean {
  return status === "eligible" || (includeConditional && status === "conditional");
}
