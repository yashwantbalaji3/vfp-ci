import type { CategoryRow, EvidenceCategory } from "./diet-confirmation";
import type { ProteinBasis } from "./menu-preview";
import type { MenuFact } from "./menu-review";

/**
 * The founder review queue (owner directive 25 Nov 2026 04:01 UTC, sections 4.1 to 4.3). Pure helpers: what one
 * meal's review rests on, and the separate progress counts. Nothing here decides or records anything.
 */

/**
 * The facts a supported diet claim rests on: the menu item, its price, and the restaurant's own "yes" for that claim.
 * These are the facts a tester sees first, so the founder's source review covers all three (migration 20261125000300).
 */
export function claimFacts(facts: MenuFact[], claim: "vegetarian" | "vegan"): MenuFact[] {
  const item = facts.filter((f) => f.kind === "menu_item" && !f.unknown);
  const price = facts.filter((f) => f.kind === "price" && !f.unknown);
  const diet = facts.filter((f) => f.kind === "dietary_status" && f.subject === claim && !f.unknown && f.value?.status === "yes");
  return diet.length ? [...item, ...price, ...diet] : [];
}

/** Confirmed by the founder against the source: verified (cleared source) or the transcription confirmed (private). */
export const founderChecked = (f: MenuFact) => f.status === "verified" || f.statuses.transcriptionConfirmed;

/**
 * A meal counts as founder-checked for a claim only when its menu item and that claim's "yes" are both checked. This
 * is NOT dietary verification for publication: from a private-pilot source the database records only that the page
 * says so (the six statuses stay separate).
 */
export function founderCheckedClaim(facts: MenuFact[], claim: "vegetarian" | "vegan"): boolean {
  const need = claimFacts(facts, claim);
  return need.some((f) => f.kind === "menu_item") && need.some((f) => f.kind === "dietary_status") && need.every(founderChecked);
}

/*
 * The three review dimensions (owner decision 25 Nov 2026 14:25 UTC). Each is answered on its own and never stands in
 * for another. Only the first is something the founder records; the other two are read from existing records, so no
 * historical record changes meaning.
 *   1. Source review: the founder compared the drafted facts with the restaurant's original evidence.
 *   2. Dietary verification: one claim rests on the restaurant's own published words that the founder source-reviewed,
 *      or on a current documented staff answer. Unknowns and conflicts stay open.
 *   3. Nutrition: the restaurant's printed figures and estimates stay apart; reviewing an estimate leaves it an estimate.
 */
export type SourceReview = "complete" | "partial" | "none";
/** Source review of what a tester sees first: the menu item, the price and the diet label for the claim. */
export function sourceReview(facts: MenuFact[], claim: "vegetarian" | "vegan"): SourceReview {
  const need = claimFacts(facts, claim);
  const done = need.filter(founderChecked).length;
  const covers = ["menu_item", "price", "dietary_status"].every((k) => need.some((f) => f.kind === k));
  if (covers && done === need.length) return "complete";
  return done > 0 ? "partial" : "none";
}

export type DietDimension = "published_reviewed" | "published_unreviewed" | "staff_confirmed" | "ingredient_supported" | "unknown" | "conflict";
export const DIET_DIMENSION_WORDS: Record<DietDimension, string> = {
  published_reviewed: "Dietary-confirmed: the restaurant's own published words, which you checked against the source",
  published_unreviewed: "The restaurant's own published words, not yet checked by you against the source",
  staff_confirmed: "Dietary-confirmed: a current documented staff answer you recorded",
  ingredient_supported: "Not confirmed: no label; the listed ingredients name nothing animal",
  unknown: "Not confirmed: no evidence either way",
  conflict: "Not confirmed: the evidence conflicts",
};
export function dietDimension(cat: EvidenceCategory, facts: MenuFact[], claim: "vegetarian" | "vegan"): DietDimension {
  if (cat !== "restaurant_published") return cat;
  return founderCheckedClaim(facts, claim) ? "published_reviewed" : "published_unreviewed";
}
export const dietConfirmed = (d: DietDimension) => d === "published_reviewed" || d === "staff_confirmed";

export type NutritionDimension = "published_reviewed" | "published_unreviewed" | "restaurant_estimate" | "our_estimate" | "unknown";
export const NUTRITION_DIMENSION_WORDS: Record<NutritionDimension, string> = {
  published_reviewed: "Protein printed by the restaurant, and you checked the figure against the source",
  published_unreviewed: "Protein printed by the restaurant, not yet checked by you",
  restaurant_estimate: "The restaurant's own estimate: it stays an estimate, even after your review",
  our_estimate: "Our labelled estimate from ingredient data: never a measurement, and your review cannot make it one",
  unknown: "Protein unknown",
};
export function nutritionDimension(facts: MenuFact[], basis: ProteinBasis): NutritionDimension {
  if (basis === "published" || basis === "published_range") {
    const protein = facts.filter((f) => f.kind === "published_nutrition" && f.subject === "protein_g" && !f.unknown);
    return protein.length && protein.every(founderChecked) ? "published_reviewed" : "published_unreviewed";
  }
  if (basis === "restaurant_estimate") return "restaurant_estimate";
  if (basis === "usda_range") return "our_estimate";
  return "unknown";
}

/**
 * What approving this meal's claim changes, dimension by dimension, in the founder's words. Approving records one
 * source review per fact; it never verifies nutrition, publishes, or claims allergen safety.
 */
export function approvalChanges(o: { claim: "vegetarian" | "vegan"; diet: DietDimension; nutrition: NutritionDimension; inBeta: boolean; otherChecks: boolean }): {
  sourceReview: string;
  dietary: string;
  nutrition: string;
  testers: string;
} {
  return {
    sourceReview: "Records that the menu item, price and diet label match the restaurant's source (one decision per fact).",
    dietary:
      o.diet === "published_unreviewed"
        ? `The ${o.claim} claim becomes dietary-confirmed, resting on the restaurant's published words. Unlisted ingredients (sauces, stock, frying oil) stay unknown.`
        : o.diet === "staff_confirmed" || o.diet === "published_reviewed"
          ? "No change: the claim is already dietary-confirmed."
          : "No change: there is no restaurant-published claim to confirm.",
    nutrition:
      o.nutrition === "published_unreviewed" || o.nutrition === "published_reviewed"
        ? "No change: the printed protein figure is a separate fact; approve it on its own if it matches."
        : "No change: an estimate stays an estimate.",
    testers: !o.otherChecks
      ? "Not yet includable for testers: another check fails."
      : o.inBeta
        ? "The meal becomes includable for testers. Including it is still a separate choice, and testers see it only while the member beta switch is on."
        : "Still not includable: the restaurant is not enrolled in the beta (your choice).",
  };
}

export type QueueRow = {
  dishId: string;
  cat: CategoryRow;
  /**
   * Every evidence check passes (a complete meal, the restaurant's own words found on the saved page, fresh, priced,
   * open). Whether the restaurant is enrolled in the beta is separate (inBeta): enrolling one is the founder's choice.
   */
  ready: boolean;
  /** The restaurant is in the member beta and linked to its listing. */
  inBeta: boolean;
  /** Every database check passes, enrolment and the founder's source review included: includable for testers now. */
  memberEligible: boolean;
  /** The restaurant's printed protein basis (dimension 3 reads it with the facts). */
  proteinBasis: ProteinBasis;
  includedForTesters: boolean;
  facts: MenuFact[];
  /** Latest meal-level note, if it is still open. */
  openNote: "needs_evidence" | "restaurant_confirmation" | null;
};

export type ReviewCounts = {
  meals: number;
  restaurantLabelled: number;
  sourceBacked: number;
  staffConfirmed: number;
  ingredientSupported: number;
  founderChecked: number;
  sourceReviewed: number;
  sourceReviewPartial: number;
  dietaryConfirmed: number;
  dietaryUnconfirmed: number;
  nutritionPrinted: number;
  nutritionPrintedReviewed: number;
  nutritionEstimate: number;
  nutritionUnknown: number;
  betaEligible: number;
  memberEligible: number;
  approvedForTesters: number;
  published: number;
  awaitingEvidence: number;
  conflicted: number;
  flaggedForRestaurant: number;
  needsEvidence: number;
};

const either = (r: QueueRow, c: CategoryRow["vegetarian"]) => r.cat.vegetarian === c || r.cat.vegan === c;
/** The claim a meal is reviewed under: vegan when the restaurant says vegan, otherwise vegetarian. */
export const reviewClaim = (r: Pick<QueueRow, "facts">): "vegetarian" | "vegan" =>
  r.facts.some((f) => f.kind === "dietary_status" && f.subject === "vegan" && !f.unknown && f.value?.status === "yes") ? "vegan" : "vegetarian";
/** Both claims' dietary dimension for one meal. */
export const dietDimensions = (r: Pick<QueueRow, "cat" | "facts">) => ({
  vegetarian: dietDimension(r.cat.vegetarian, r.facts, "vegetarian"),
  vegan: dietDimension(r.cat.vegan, r.facts, "vegan"),
});

/** The separate counts (section 4.3). Each is its own question; they overlap and are never added together. */
export function reviewCounts(rows: QueueRow[]): ReviewCounts {
  const n = (f: (r: QueueRow) => boolean) => rows.filter(f).length;
  return {
    meals: rows.length,
    restaurantLabelled: n((r) => either(r, "restaurant_published")),
    sourceBacked: n((r) => either(r, "restaurant_published") && r.ready),
    staffConfirmed: n((r) => either(r, "staff_confirmed")),
    ingredientSupported: n((r) => r.cat.vegetarian === "ingredient_supported"),
    founderChecked: n((r) => founderCheckedClaim(r.facts, "vegetarian") || founderCheckedClaim(r.facts, "vegan")),
    sourceReviewed: n((r) => sourceReview(r.facts, reviewClaim(r)) === "complete"),
    sourceReviewPartial: n((r) => sourceReview(r.facts, reviewClaim(r)) === "partial"),
    dietaryConfirmed: n((r) => { const d = dietDimensions(r); return dietConfirmed(d.vegetarian) || dietConfirmed(d.vegan); }),
    dietaryUnconfirmed: n((r) => { const d = dietDimensions(r); return !dietConfirmed(d.vegetarian) && !dietConfirmed(d.vegan); }),
    nutritionPrinted: n((r) => nutritionDimension(r.facts, r.proteinBasis).startsWith("published")),
    nutritionPrintedReviewed: n((r) => nutritionDimension(r.facts, r.proteinBasis) === "published_reviewed"),
    nutritionEstimate: n((r) => nutritionDimension(r.facts, r.proteinBasis).endsWith("estimate")),
    nutritionUnknown: n((r) => nutritionDimension(r.facts, r.proteinBasis) === "unknown"),
    betaEligible: n((r) => r.ready && r.inBeta),
    memberEligible: n((r) => r.memberEligible),
    approvedForTesters: n((r) => r.includedForTesters),
    published: n((r) => r.facts.some((f) => f.kind === "dietary_status" && f.statuses.publicationApproved)),
    awaitingEvidence: n((r) => r.cat.vegetarian === "unknown" || r.cat.vegetarian === "ingredient_supported"),
    conflicted: n((r) => r.cat.vegetarian === "conflict"),
    flaggedForRestaurant: n((r) => r.openNote === "restaurant_confirmation"),
    needsEvidence: n((r) => r.openNote === "needs_evidence"),
  };
}

/** Latest note per meal; "cleared" closes an earlier flag. Notes arrive newest first. */
export function openNotes<T extends { dishId: string; outcome: string }>(notes: T[]): Map<string, T> {
  const out = new Map<string, T>();
  const seen = new Set<string>();
  for (const n of notes) {
    if (seen.has(n.dishId)) continue;
    seen.add(n.dishId);
    if (n.outcome !== "cleared") out.set(n.dishId, n);
  }
  return out;
}

/**
 * Questions that would settle a meal, from its own evidence only (for in-person confirmation, or a written question
 * once outreach is approved). Never inferred from the restaurant's identity or the meal's name.
 */
export function questionsFor(o: { evidenceNote: string | null; ingredients: string[] | null; veganClaim: string | null; vegetarianClaim: string | null; unclear: string[] }): string[] {
  const q: string[] = [];
  const note = (o.evidenceNote ?? "").toLowerCase();
  if (/\bhoney\b/.test(note)) q.push("Do the honey-named flavours (for example Honey Garlic, honey BBQ) contain real honey, or a plant-based substitute?");
  if (o.veganClaim !== "yes" && o.vegetarianClaim !== "yes") q.push("Is this dish vegetarian as served? Is it vegan?");
  else if (o.veganClaim !== "yes") q.push("Is this dish vegan as served, or can it be made vegan?");
  if (!o.ingredients?.length) q.push("What are its ingredients, including sauces, dressings and stock?");
  else q.push("Is the listed ingredient list complete, including sauces, dressings, stock and frying oil?");
  if (o.unclear.length) q.push(`What is in: ${o.unclear.join(", ")}?`);
  q.push("Is it cooked in a shared fryer or on a shared surface with meat or fish? (recorded as a limitation, never as allergen safety)");
  return q;
}
