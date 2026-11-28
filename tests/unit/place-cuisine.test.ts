import { describe, expect, it } from "vitest";
import { CUISINE_BY_CATEGORY, cuisinesFromTaxonomy, DIET_CATEGORIES, parseTaxonomyRows } from "../../scripts/lib/cuisine.mjs";
import { cuisineWords } from "@/contracts/places";

// Cuisine from Overture Maps' own categories (CAT-CUISINE, docs/49): only explicit categories, primary kept apart
// from "possibly", generic categories give nothing, diet words are never a cuisine.

describe("cuisine from Overture's taxonomy", () => {
  it("Overture's primary category gives a sourced cuisine", () => {
    expect(cuisinesFromTaxonomy({ primary: "indian_restaurant", alternates: [] })).toEqual([
      { cuisine: "Indian", basis: "dataset_primary", category: "indian_restaurant" },
    ]);
  });

  it("a cuisine found only among alternates is 'possibly', never sourced", () => {
    expect(cuisinesFromTaxonomy({ primary: "restaurant", alternates: ["thai_restaurant"] })).toEqual([
      { cuisine: "Thai", basis: "dataset_alternate", category: "thai_restaurant" },
    ]);
  });

  it("generic categories, unknown categories and empty records give no cuisine", () => {
    for (const primary of ["restaurant", "cafe", "coffee_shop", "bakery", "fast_food_restaurant", "food_court", "made_up_restaurant", ""]) {
      expect(cuisinesFromTaxonomy({ primary, alternates: [] })).toEqual([]);
    }
    expect(cuisinesFromTaxonomy({})).toEqual([]);
  });

  it("diet words are never a cuisine, as primary or alternate", () => {
    for (const c of DIET_CATEGORIES) {
      expect(cuisinesFromTaxonomy({ primary: c, alternates: [c] })).toEqual([]);
      expect(Object.hasOwn(CUISINE_BY_CATEGORY, c)).toBe(false);
    }
    expect(Object.values(CUISINE_BY_CATEGORY).join(" ")).not.toMatch(/vegan|vegetarian|halal|kosher|gluten|health/i);
  });

  it("a long alternates list adds at most one 'possibly' to a sourced cuisine, and duplicates collapse", () => {
    const out = cuisinesFromTaxonomy({ primary: "sushi_restaurant", alternates: ["sushi_restaurant", "japanese_restaurant", "korean_restaurant", "thai_restaurant"] });
    expect(out.map((c) => [c.cuisine, c.basis])).toEqual([
      ["Sushi", "dataset_primary"],
      ["Japanese", "dataset_alternate"],
    ]);
  });

  it("an inherited object key is not a category", () => {
    expect(cuisinesFromTaxonomy({ primary: "constructor", alternates: ["toString", "__proto__"] })).toEqual([]);
  });

  it("parses the extractor's rows", () => {
    const m = parseTaxonomyRows([{ id: "a", primary: "pizza_restaurant", alternates: "italian_restaurant|" }, { id: "", primary: "x", alternates: "" }]);
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")).toEqual({ primary: "pizza_restaurant", alternates: ["italian_restaurant"] });
  });
});

describe("cuisine words on screen", () => {
  it("says 'possibly' for an alternate and nothing when unknown", () => {
    expect(cuisineWords([])).toBeNull();
    expect(cuisineWords([{ cuisine: "Italian", basis: "dataset_primary" }])).toBe("Italian");
    expect(cuisineWords([{ cuisine: "Pizza", basis: "dataset_primary" }, { cuisine: "Italian", basis: "dataset_alternate" }])).toBe("Pizza (possibly Italian)");
    expect(cuisineWords([{ cuisine: "Thai", basis: "dataset_alternate" }])).toBe("Possibly Thai");
  });
});
