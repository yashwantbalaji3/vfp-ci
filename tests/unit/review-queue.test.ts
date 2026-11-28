import { describe, expect, it } from "vitest";
import type { CategoryRow } from "@/contracts/diet-confirmation";
import type { MenuFact } from "@/contracts/menu-review";
import {
  approvalChanges,
  claimFacts,
  dietConfirmed,
  dietDimension,
  founderCheckedClaim,
  nutritionDimension,
  openNotes,
  questionsFor,
  reviewCounts,
  sourceReview,
  type QueueRow,
} from "@/contracts/review-queue";

// Founder review queue (owner directive 25 Nov 2026 04:01 UTC, section 4): separate counts, per-claim facts, questions.
let seq = 0;
const fact = (o: Partial<MenuFact> & Pick<MenuFact, "kind">): MenuFact => ({
  factId: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  subject: null, value: { listed: true }, unknown: false, unknownReason: null, status: "submitted", confidence: "high",
  sourceId: "00000000-0000-4000-8000-999999999999", checkedOn: "2026-11-24", access: "private_pilot", confirmAs: "transcription", canConfirm: true, canReject: true,
  statuses: { extracted: true, transcriptionConfirmed: false, dietaryVerified: false, nutritionVerified: false, reuseEligible: false, publicationApproved: false },
  ...o,
});
const vegan = (confirmed = false) => fact({ kind: "dietary_status", subject: "vegan", value: { claim: "vegan", status: "yes" }, statuses: { ...fact({ kind: "menu_item" }).statuses, transcriptionConfirmed: confirmed } });
const item = (confirmed = false) => fact({ kind: "menu_item", statuses: { ...fact({ kind: "menu_item" }).statuses, transcriptionConfirmed: confirmed } });
const price = (confirmed = false) => fact({ kind: "price", value: { usd: "15.00" }, statuses: { ...fact({ kind: "menu_item" }).statuses, transcriptionConfirmed: confirmed } });
const protein = (confirmed = false) =>
  fact({ kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", amount: 21 }, statuses: { ...fact({ kind: "menu_item" }).statuses, transcriptionConfirmed: confirmed } });
const cat = (v: CategoryRow["vegetarian"], g: CategoryRow["vegan"] = v): CategoryRow => ({ vegetarian: v, vegan: g, records: {} });
const row = (o: Partial<QueueRow>): QueueRow => ({ dishId: String(++seq), cat: cat("unknown"), ready: false, inBeta: true, memberEligible: false, proteinBasis: "unknown", includedForTesters: false, facts: [], openNote: null, ...o });

describe("review queue", () => {
  it("a claim rests on the menu item, its price and that claim's yes; with no yes there is nothing to approve", () => {
    const facts = [item(), vegan(), price()];
    expect(claimFacts(facts, "vegan").map((f) => f.kind)).toEqual(["menu_item", "price", "dietary_status"]);
    expect(claimFacts(facts, "vegetarian")).toEqual([]);
  });
  it("founder-checked needs both the menu item and the claim checked", () => {
    expect(founderCheckedClaim([item(true), vegan(false)], "vegan")).toBe(false);
    expect(founderCheckedClaim([item(true), vegan(true)], "vegan")).toBe(true);
    expect(founderCheckedClaim([item(true), vegan(true), price(false)], "vegan")).toBe(false);
  });
  it("dimension 1, source review: complete only when the menu item, price and label are all checked", () => {
    expect(sourceReview([item(), price(), vegan()], "vegan")).toBe("none");
    expect(sourceReview([item(true), price(), vegan(true)], "vegan")).toBe("partial");
    expect(sourceReview([item(true), price(true), vegan(true)], "vegan")).toBe("complete");
    // No price on the menu: never complete (the tester check needs a price).
    expect(sourceReview([item(true), vegan(true)], "vegan")).toBe("partial");
  });
  it("dimension 2, dietary: published words count once source-reviewed; staff answers count; unknowns and conflicts stay open", () => {
    expect(dietDimension("restaurant_published", [item(), price(), vegan()], "vegan")).toBe("published_unreviewed");
    expect(dietDimension("restaurant_published", [item(true), price(true), vegan(true)], "vegan")).toBe("published_reviewed");
    expect(dietDimension("staff_confirmed", [], "vegan")).toBe("staff_confirmed");
    // Reviewing the facts never turns an ingredient reading, an unknown or a conflict into a confirmation.
    for (const c of ["ingredient_supported", "unknown", "conflict"] as const) {
      const d = dietDimension(c, [item(true), price(true), vegan(true)], "vegan");
      expect(d).toBe(c);
      expect(dietConfirmed(d)).toBe(false);
    }
  });
  it("dimension 3, nutrition: printed figures and estimates stay apart, and review never makes an estimate a measurement", () => {
    expect(nutritionDimension([protein(false)], "published")).toBe("published_unreviewed");
    expect(nutritionDimension([protein(true)], "published")).toBe("published_reviewed");
    expect(nutritionDimension([protein(true)], "restaurant_estimate")).toBe("restaurant_estimate");
    expect(nutritionDimension([item(true), price(true), vegan(true)], "usda_range")).toBe("our_estimate");
    expect(nutritionDimension([], "unknown")).toBe("unknown");
  });
  it("says what approving changes per dimension, and never promises testers a meal at an unenrolled restaurant", () => {
    const a = approvalChanges({ claim: "vegan", diet: "published_unreviewed", nutrition: "our_estimate", inBeta: false, otherChecks: true });
    expect(a.dietary).toMatch(/becomes dietary-confirmed/);
    expect(a.nutrition).toMatch(/estimate stays an estimate/);
    expect(a.testers).toMatch(/not enrolled/);
    expect(approvalChanges({ claim: "vegan", diet: "conflict", nutrition: "unknown", inBeta: true, otherChecks: false }).dietary).toMatch(/No change/);
  });
  it("counts are separate questions: labelled, source-backed, staff, ingredient-supported, checked, eligible, published, awaiting, conflicted", () => {
    const c = reviewCounts([
      row({ cat: cat("restaurant_published"), ready: true, memberEligible: true, proteinBasis: "published", facts: [item(true), price(true), vegan(true), protein(false)] }),
      row({ cat: cat("restaurant_published"), ready: false }),
      row({ cat: cat("restaurant_published", "unknown"), ready: true, inBeta: false }),
      row({ cat: cat("staff_confirmed", "unknown") }),
      row({ cat: cat("ingredient_supported") }),
      row({ cat: cat("unknown"), openNote: "restaurant_confirmation" }),
      row({ cat: cat("conflict"), openNote: "needs_evidence" }),
    ]);
    expect(c).toMatchObject({
      meals: 7, restaurantLabelled: 3, sourceBacked: 2, staffConfirmed: 1, ingredientSupported: 1, founderChecked: 1, betaEligible: 1,
      approvedForTesters: 0, published: 0, awaitingEvidence: 2, conflicted: 1, flaggedForRestaurant: 1, needsEvidence: 1,
      sourceReviewed: 1, sourceReviewPartial: 0, dietaryConfirmed: 2, dietaryUnconfirmed: 5, memberEligible: 1,
      nutritionPrinted: 1, nutritionPrintedReviewed: 0, nutritionEstimate: 0, nutritionUnknown: 6,
    });
  });
  it("the latest note per meal wins, and 'cleared' closes a flag", () => {
    const m = openNotes([
      { dishId: "a", outcome: "cleared" },
      { dishId: "a", outcome: "restaurant_confirmation" },
      { dishId: "b", outcome: "needs_evidence" },
    ]);
    expect([...m.keys()]).toEqual(["b"]);
  });
  it("questions come from the meal's own evidence: honey flavours, missing labels and ingredients", () => {
    const q = questionsFor({ evidenceNote: "Comes in a flavour of choice, including Honey Garlic and honey BBQ", ingredients: null, veganClaim: "yes", vegetarianClaim: null, unclear: [] });
    expect(q[0]).toMatch(/real honey/);
    expect(q.join(" ")).toMatch(/What are its ingredients/);
    expect(q.join(" ")).not.toMatch(/Is it vegan as served/);
    expect(questionsFor({ evidenceNote: null, ingredients: ["tofu"], veganClaim: null, vegetarianClaim: null, unclear: ["naan"] }).join(" ")).toMatch(/vegetarian as served[\s\S]*complete[\s\S]*naan/);
  });
});
