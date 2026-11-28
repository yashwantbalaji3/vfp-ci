import { describe, expect, it } from "vitest";
import { menuAgreedHints } from "@/contracts/menu-preview";
import { dishEvidence } from "@/contracts/meal-eligibility";

const veg = { hint: "vegetarian" as const, basis: "dataset_primary" as const, category: "vegetarian_restaurant" };
const vegan = { hint: "vegan" as const, basis: "dataset_alternate" as const, category: "vegan_restaurant" };
const ev = (facts: Parameters<typeof dishEvidence>[0], namesMeat = false) => ({ evidence: dishEvidence(facts, namesMeat) });

describe("open-map diet hints that the restaurant's own menu contradicts are dropped", () => {
  it("keeps the hint when the menu has no meal that names meat", () => {
    expect(menuAgreedHints([veg], [])).toEqual([veg]);
  });
  it("drops a vegetarian-restaurant hint when a meal names meat", () => {
    expect(menuAgreedHints([veg, vegan], [ev({ facts: [] } as never, true)])).toEqual([]);
  });
});

describe("a vegan-restaurant hint", () => {
  it("is dropped when the menu lists dairy, and the vegetarian hint stays", () => {
    const cheese = ev({ facts: [{ kind: "listed_ingredients", unknown: false, value: { items: ["cheddar cheese", "bun"] } }] } as never);
    expect(menuAgreedHints([veg, vegan], [cheese])).toEqual([veg]);
  });
});
