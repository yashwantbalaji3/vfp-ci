/**
 * Shared nutrition types (docs/07). Unknown values are `null` with a reason, never 0.
 */
export const NUTRIENT_CODES = [
  "energy_kcal",
  "protein_g",
  "carb_g",
  "fat_g",
  "fiber_g",
  "sodium_mg",
] as const;
export type NutrientCode = (typeof NUTRIENT_CODES)[number];

export type NutritionMethod =
  | "published"
  | "calculated"
  | "estimated"
  | "user_entered"
  | "unknown";

export type MissingReason =
  | "not_provided"
  | "unavailable_conversion"
  | "incomplete_recipe"
  | "source_conflict"
  | "not_applicable";

/** A nutrient value stored as a decimal string to avoid binary rounding. */
export type NutrientValue =
  | { value: string; method: Exclude<NutritionMethod, "unknown">; missingReason: null }
  | { value: null; method: NutritionMethod; missingReason: MissingReason };

export type Basis =
  | { kind: "mass"; amount: string; unit: "g" }
  | { kind: "volume"; amount: string; unit: "ml" }
  | { kind: "serving"; amount: string; unit: "serving" };

export type Portion = {
  label: string;
  amount: string;
  unit: string;
  /** Sourced gram weight of the whole portion, if known. */
  grams: string | null;
};
