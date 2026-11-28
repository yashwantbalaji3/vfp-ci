import { describe, expect, it } from "vitest";
import { dietHintWords } from "@/contracts/places";

// Place-level hints from the open map's category (docs/64); read in SQL by staging.place_diet_hints (tests/db/place-cuisine.test.ts).
describe("place-level diet hints from the open map's category", () => {
  it("words the strongest hint with its source, and an alternate as only possible", () => {
    expect(dietHintWords([])).toBeNull();
    expect(dietHintWords(undefined)).toBeNull();
    expect(dietHintWords([{ hint: "vegetarian", basis: "dataset_primary" }])).toBe("Listed as a vegetarian restaurant in Overture Maps");
    expect(dietHintWords([{ hint: "vegetarian", basis: "dataset_alternate" }, { hint: "vegan", basis: "dataset_primary" }])).toBe("Listed as a vegan restaurant in Overture Maps");
    expect(dietHintWords([{ hint: "vegan", basis: "dataset_alternate" }])).toBe("Overture Maps also lists it as a possible vegan restaurant");
  });
});
