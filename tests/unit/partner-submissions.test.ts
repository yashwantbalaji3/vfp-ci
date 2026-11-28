import { describe, expect, it } from "vitest";
import { readExport } from "../../scripts/menu-export-import.mjs";
import { toPartnerItems } from "../../scripts/partner-submissions.mjs";

// Restaurant submission files (docs/48): only an exact "vegan" or "vegetarian" label becomes a dietary
// statement; every other label is left for a person. Blanks stay out, never zero.

describe("toPartnerItems", () => {
  it("keeps the restaurant's words, maps only exact labels and never fills in nutrition", () => {
    const csv = "name,labels,ingredients,allergens,serving,protein_g,calories_kcal\n" +
      "Tofu bowl,Vegan;Gluten free,tofu; rice,soy,1 bowl,24 g,520\n" +
      "Cheese pizza,vegetarian,,milk,,,\n" +
      "Salad,Vegan option available;V;constructor,greens,,,,\n";
    const { items, unmapped } = toPartnerItems(readExport(csv, "csv").items);
    expect(items[0]).toMatchObject({ name: "Tofu bowl", dietary: [{ claim: "vegan", words: "Vegan" }], allergens: "soy", serving: "1 bowl",
      nutrition: { protein_g: { amount: 24, unit: "g", per: "serving" }, energy_kcal: { amount: 520, unit: "kcal", per: "serving" } } });
    expect(items[1]).toEqual({ name: "Cheese pizza", dietary: [{ claim: "vegetarian", words: "vegetarian" }], nutrition: {}, allergens: "milk" });
    expect(items[2].dietary).toEqual([]);
    expect(items[2]).not.toHaveProperty("allergens");
    expect(unmapped.map((u) => u.label)).toEqual(["Gluten free", "Vegan option available", "V", "constructor"]);
  });
});
