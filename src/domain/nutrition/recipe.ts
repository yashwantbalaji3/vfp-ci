import Decimal from "decimal.js";

/**
 * Recipe nutrition by ingredient sum (docs/07 "Recipes, cooking and substitutions").
 * A partial sum is never presented as a complete value: when any required ingredient's
 * contribution is unknown, the complete value is null and the known subtotal is kept.
 */
export type IngredientContribution = {
  /** Contribution of this ingredient to the whole batch, or null if unknown. */
  batchValue: Decimal.Value | null;
  optional: boolean;
  /** Optional ingredients count only when explicitly included. */
  included: boolean;
};

export type RecipeNutrient = {
  /** Complete batch value, or null when a required contribution is unknown. */
  batch: Decimal | null;
  perServing: Decimal | null;
  knownSubtotal: Decimal;
  missingIngredients: number;
  method: "calculated";
};

export function calculateRecipeNutrient(
  ingredients: IngredientContribution[],
  yieldServings: Decimal.Value,
  scale: Decimal.Value = 1,
): RecipeNutrient {
  const servings = new Decimal(yieldServings);
  const factor = new Decimal(scale);
  if (servings.lte(0) || factor.lte(0)) throw new Error("INVALID_YIELD");

  let known = new Decimal(0);
  let missing = 0;
  for (const ing of ingredients) {
    if (ing.optional && !ing.included) continue;
    if (ing.batchValue === null) {
      missing += 1;
    } else {
      known = known.plus(ing.batchValue);
    }
  }
  // Scaling multiplies quantities and batch nutrients; servings scale with it,
  // so per-serving values are unchanged under proportional scaling.
  const knownScaled = known.times(factor);
  const batch = missing === 0 ? knownScaled : null;
  return {
    batch,
    perServing: batch ? batch.div(servings.times(factor)) : null,
    knownSubtotal: knownScaled,
    missingIngredients: missing,
    method: "calculated",
  };
}
