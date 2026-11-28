import { describe, expect, it } from "vitest";
import type { DietEvidence } from "@/contracts/meal-eligibility";
import { confirmationRow } from "@/contracts/needs-confirmation";

const ev = (o: Partial<DietEvidence> = {}): DietEvidence => ({ veganClaim: null, vegetarianClaim: null, ingredients: null, allergens: null, found: [], unclear: [], namesMeat: false, ...o });

describe("needs-confirmation classes (owner decision 22 Nov 2026, item 2)", () => {
  it("a missing label is insufficient evidence, never a conflict", () => {
    const r = confirmationRow(ev());
    expect(r.vegetarian).toBe("insufficient");
    expect(r.vegan).toBe("insufficient");
    expect(r.lead).toBe("no_ingredients");
    expect(r.missing).toContain("An ingredient list (the menu prints none)");
  });
  it("listed meat is an explicit conflict", () => {
    const r = confirmationRow(ev({ namesMeat: true, ingredients: ["sliced chicken", "cucumber"] }));
    expect(r.vegetarian).toBe("conflict");
    expect(r.vegan).toBe("conflict");
    expect(r.why[0]).toMatch(/meat or fish/);
  });
  it("the restaurant's vegetarian label is stated; vegan stays insufficient, and listed dairy is a vegan conflict", () => {
    expect(confirmationRow(ev({ vegetarianClaim: "yes" }))).toMatchObject({ vegetarian: "stated", vegan: "insufficient" });
    const dairy = confirmationRow(ev({ vegetarianClaim: "yes", ingredients: ["feta"], found: [{ family: "dairy", word: "feta", from: "ingredients" }] }));
    expect(dairy).toMatchObject({ vegetarian: "stated", vegan: "conflict" });
  });
  it("clear listed ingredients make a strong lead but still not a match", () => {
    const r = confirmationRow(ev({ ingredients: ["chickpeas", "onion", "herbs"] }));
    expect(r).toMatchObject({ vegetarian: "insufficient", vegan: "insufficient", lead: "ingredients_clear" });
    expect(r.missing.join(" ")).toMatch(/complete, including stock/);
  });
  it("never produces 'substantiated' without a recorded independent check", () => {
    for (const e of [ev(), ev({ veganClaim: "yes" }), ev({ ingredients: ["rice"] })]) {
      const r = confirmationRow(e);
      expect([r.vegetarian, r.vegan]).not.toContain("substantiated");
    }
  });
});
