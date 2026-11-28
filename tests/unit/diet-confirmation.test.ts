import { describe, expect, it } from "vitest";
import { dietConfirmationInputSchema, evidenceCategories, type DietConfirmation } from "@/contracts/diet-confirmation";
import type { DietEvidence } from "@/contracts/meal-eligibility";

// Owner decision 24 Nov 2026 21:20 UTC, decision 2: restaurant-published, staff-confirmed, ingredient-supported and
// unknown stay separate; nothing is converted automatically.
const ev = (o: Partial<DietEvidence> = {}): DietEvidence => ({ veganClaim: null, vegetarianClaim: null, ingredients: null, allergens: null, found: [], unclear: [], namesMeat: false, ...o });
const rec = (o: Partial<DietConfirmation> = {}): DietConfirmation => ({
  id: "00000000-0000-4000-8000-000000000001", placeId: "00000000-0000-4000-8000-000000000002", dishId: "00000000-0000-4000-8000-000000000003",
  claim: "vegetarian", answer: "suitable", topics: ["whole_dish"], answerNote: "No meat or fish stock", method: "staff_in_person", methodNote: null,
  sourceRole: "Manager", sourceIdentity: null, scope: "This dish", limitations: "Verbal", obtainedOn: "2026-11-24", expiresOn: "2027-03-24",
  recordedAt: "2026-11-24T22:00:00Z", state: "current", withdrawnAt: null, withdrawnReason: null, ...o,
});

describe("evidence categories", () => {
  it("with no record, clear ingredients are only an ingredient-supported classification, and no ingredients is unknown", () => {
    expect(evidenceCategories(ev({ ingredients: ["chickpeas", "onion"] }), [])).toMatchObject({ vegetarian: "ingredient_supported", vegan: "ingredient_supported" });
    expect(evidenceCategories(ev(), [])).toMatchObject({ vegetarian: "unknown", vegan: "unknown" });
  });
  it("the restaurant's own label stays restaurant-published even when a record agrees", () => {
    expect(evidenceCategories(ev({ vegetarianClaim: "yes" }), [rec()]).vegetarian).toBe("restaurant_published");
  });
  it("a current suitable record makes exactly its own claim staff-confirmed: vegetarian never becomes vegan", () => {
    const c = evidenceCategories(ev({ ingredients: ["chickpeas"] }), [rec()]);
    expect(c.vegetarian).toBe("staff_confirmed");
    expect(c.records.vegetarian?.id).toBe(rec().id);
    expect(c.vegan).toBe("ingredient_supported");
    // A vegan answer does not stand in for vegetarian either.
    expect(evidenceCategories(ev(), [rec({ claim: "vegan" })])).toMatchObject({ vegetarian: "unknown", vegan: "staff_confirmed" });
  });
  it("lapsed, withdrawn and unclear records change nothing", () => {
    for (const r of [rec({ state: "expired" }), rec({ state: "menu_changed" }), rec({ state: "withdrawn" }), rec({ answer: "unclear" })])
      expect(evidenceCategories(ev(), [r]).vegetarian).toBe("unknown");
  });
  it("a 'not suitable' answer is a conflict and beats a suitable one; a listed conflict is never overridden by a record", () => {
    expect(evidenceCategories(ev(), [rec(), rec({ id: "00000000-0000-4000-8000-000000000009", answer: "not_suitable" })]).vegetarian).toBe("conflict");
    expect(evidenceCategories(ev({ namesMeat: true, ingredients: ["chicken"] }), [rec()]).vegetarian).toBe("conflict");
    const dairy = ev({ ingredients: ["paneer"], found: [{ family: "dairy", word: "paneer", from: "ingredients" }] });
    expect(evidenceCategories(dairy, [rec({ claim: "vegan" })]).vegan).toBe("conflict");
  });
});

describe("record form input", () => {
  const ok = {
    dishId: "00000000-0000-4000-8000-000000000003", claim: "vegan", answer: "suitable", topics: ["dairy", "egg"], answerNote: "No dairy or egg",
    method: "staff_in_person", methodNote: "", sourceRole: "Chef", sourceIdentity: "", scope: "This dish", limitations: "Verbal only", obtainedOn: "2026-11-24",
  };
  it("accepts a complete answer and turns empty optional fields into null", () => {
    const p = dietConfirmationInputSchema.parse(ok);
    expect(p.methodNote).toBeNull();
    expect(p.sourceIdentity).toBeNull();
  });
  it("refuses a missing topic, limitation or source role, an unknown topic, and 'other' without detail", () => {
    for (const bad of [{ topics: [] }, { limitations: " " }, { sourceRole: "" }, { topics: ["cuisine"] }, { method: "other_documented" }])
      expect(dietConfirmationInputSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
  });
});
