import { mealFit, type DietEvidence } from "./meal-eligibility";

/**
 * The founder-only "Needs confirmation" group (owner decision 22 Nov 2026 15:26 UTC, item 2).
 *
 * Every real meal falls in exactly one evidence class, judged for vegetarian and for vegan separately, and the
 * classes are never merged:
 *   - "stated": the restaurant's own words say it is vegetarian (or vegan) and nothing it lists conflicts.
 *   - "conflict": explicit evidence against: the restaurant says it isn't, its name or listed ingredients name meat
 *     or fish, or (for vegan) it lists an animal ingredient. Only explicit evidence: a missing label never lands here.
 *   - "insufficient": no diet statement and no explicit conflict. A missing vegetarian label is NOT evidence that a
 *     dish contains meat, so these are not "not vegetarian"; they stay out of strict matches and suitable counts.
 *   - "substantiated": never produced here. Documented answers are the founder's dietary confirmation records
 *     (docs/89), kept as their own category by evidenceCategories in ./diet-confirmation.
 * Each insufficient meal says what evidence exists (listed ingredients, our reading of them) and what is missing.
 */
export type EvidenceClass = "stated" | "conflict" | "insufficient" | "substantiated";
export type ConfirmationRow = {
  vegetarian: EvidenceClass;
  vegan: EvidenceClass;
  /** Why it is in the class, the strongest reason first. */
  why: string[];
  /** What would be needed to move it to "stated" or "substantiated". */
  missing: string[];
  /** The strength of what is already known, for sorting the founder's queue. */
  lead: "ingredients_clear" | "ingredients_unclear" | "no_ingredients";
};

const NO = { diet: "none" as const, exclusions: [] as string[], includeConditional: false };

export function confirmationRow(e: DietEvidence): ConfirmationRow {
  const vegFit = mealFit(e, { ...NO, diet: "vegetarian" });
  const veganFit = mealFit(e, { ...NO, diet: "vegan" });
  const cls = (f: typeof vegFit): EvidenceClass => (f.status === "eligible" ? "stated" : f.status === "ineligible" ? "conflict" : "insufficient");
  const vegetarian = cls(vegFit);
  const vegan = cls(veganFit);
  const why: string[] = [];
  const missing: string[] = [];
  if (vegetarian === "conflict") why.push(...vegFit.reasons);
  else if (vegan === "conflict") why.push(...veganFit.reasons.map((r) => `For vegan: ${r.charAt(0).toLowerCase()}${r.slice(1)}`));
  if (vegetarian === "insufficient") why.push(...vegFit.reasons);
  if (vegan === "insufficient" && vegetarian !== "conflict") why.push(...veganFit.reasons.filter((r) => !why.includes(r)));

  const animal = e.found.filter((f) => f.from === "ingredients");
  const lead: ConfirmationRow["lead"] = !e.ingredients ? "no_ingredients" : e.unclear.length ? "ingredients_unclear" : "ingredients_clear";
  if (vegetarian === "insufficient") {
    missing.push("The restaurant's own statement that it is vegetarian");
    if (!e.ingredients) missing.push("An ingredient list (the menu prints none)");
    else missing.push("Confirmation that the listed ingredients are complete, including stock, sauces and frying oil");
  }
  if (vegan === "insufficient" && vegetarian !== "conflict") {
    if (animal.length === 0 && e.ingredients) missing.push("The restaurant's statement that it is vegan (no animal ingredient is listed, but lists can be incomplete)");
    else if (!e.ingredients) missing.push("The restaurant's statement that it is vegan");
  }
  return { vegetarian, vegan, why: [...new Set(why)], missing: [...new Set(missing)], lead };
}

export const LEAD_WORDS: Record<ConfirmationRow["lead"], string> = {
  ingredients_clear: "Ingredients listed; none name meat or fish",
  ingredients_unclear: "Ingredients listed; some words are unclear",
  no_ingredients: "No ingredients listed",
};
