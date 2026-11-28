import { describe, expect, it } from "vitest";
import { brandOf, planSittings } from "@/contracts/review-sittings";

// Invented restaurant names, shaped like the founder's queue (33 meals at 8 branches of 7 restaurants).
const many = (place: string, n: number) => Array.from({ length: n }, (_, i) => ({ dishId: `${place}-${i}`, placeName: place }));

describe("review sittings", () => {
  it("treats branches of one restaurant as one", () => {
    expect(brandOf("Lantern Cafe (12 Elm St)")).toBe("Lantern Cafe");
    expect(brandOf("Lantern Cafe")).toBe("Lantern Cafe");
  });

  it("keeps each sitting to at most two restaurants and twelve meals, largest first, and loses no meal", () => {
    const items = [...many("Green Grill", 6), ...many("Pho House", 6), ...many("Sugar Bowl", 6), ...many("Teff Table", 5),
      ...many("Lantern Cafe (12 Elm St)", 2), ...many("Lantern Cafe (9 Oak Ave)", 2), ...many("Flatbread Co", 3), ...many("Dosa Spot", 3)];
    const s = planSittings(items);
    expect(s.map((x) => x.brands.map((b) => `${b.brand} ${b.meals}`))).toEqual([
      ["Green Grill 6", "Pho House 6"],
      ["Sugar Bowl 6", "Teff Table 5"],
      ["Lantern Cafe 4", "Dosa Spot 3"],
      ["Flatbread Co 3"],
    ]);
    expect(s.flatMap((x) => x.dishIds).sort()).toEqual(items.map((i) => i.dishId).sort());
    for (const x of s) expect(x.dishIds.length).toBeLessThanOrEqual(12);
  });

  it("gives a restaurant larger than a sitting its own sitting rather than splitting it", () => {
    expect(planSittings(many("Big Menu", 15)).map((x) => x.dishIds.length)).toEqual([15]);
    expect(planSittings([])).toEqual([]);
  });
});
