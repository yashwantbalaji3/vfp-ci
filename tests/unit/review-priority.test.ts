import { describe, expect, it } from "vitest";
import { prioritise, reviewPriority } from "@/contracts/tester-meals";

// Founder review order (owner directive 24 Nov 2026 14:59 UTC, 2C): variety and evidence first, never a decision.
const base = { placeId: "a", area: "Chinatown", veganStated: false, eggFreeStated: false, ingredientsListed: false, proteinPrinted: false, checkedOn: null, label: "x" };
const ctx = (placeA = 0, areaN = 0) => ({ includedByPlace: new Map([["a", placeA]]), includedByArea: new Map([["Chinatown", areaN]]), today: "2026-11-24" });

describe("review priority", () => {
  it("puts a restaurant and an area testers don't have yet first, with the reasons", () => {
    expect(reviewPriority(base, ctx(0, 0))).toEqual({ score: 60, reasons: ["new restaurant for testers", "few meals in Chinatown yet"] });
    expect(reviewPriority(base, ctx(3, 9)).score).toBe(0);
  });
  it("adds the restaurant's own vegan and no-egg words, listed ingredients, printed protein and a fresh menu", () => {
    const p = reviewPriority({ ...base, veganStated: true, eggFreeStated: true, ingredientsListed: true, proteinPrinted: true, checkedOn: "2026-11-20" }, ctx(3, 9));
    expect(p.score).toBe(55);
    expect(p.reasons).toEqual(["says no egg", "says vegan", "ingredients listed", "protein printed", "menu checked this week"]);
    expect(reviewPriority({ ...base, checkedOn: "2026-11-01" }, ctx(3, 9)).reasons).not.toContain("menu checked this week");
  });
  it("orders by points and keeps at most N per restaurant, so one restaurant cannot fill the list", () => {
    const meals = [
      ...Array.from({ length: 5 }, (_, i) => ({ ...base, placeId: "big", label: `big ${i}`, proteinPrinted: true })),
      { ...base, placeId: "small", label: "small 1" },
    ];
    const c = { includedByPlace: new Map([["big", 10]]), includedByArea: new Map([["Chinatown", 9]]), today: "2026-11-24" };
    const out = prioritise(meals, c, 2);
    expect(out.map((m) => m.label)).toEqual(["small 1", "big 0", "big 1"]);
  });
});

describe("the first review set", () => {
  it("interleaves restaurants and areas instead of listing one restaurant's meals first, and stops at the limit", () => {
    const meals = [
      ...Array.from({ length: 4 }, (_, i) => ({ ...base, placeId: "big", area: "Harvard Square", label: `big ${i}`, veganStated: true, proteinPrinted: true })),
      ...Array.from({ length: 3 }, (_, i) => ({ ...base, placeId: "pho", area: "Chinatown", label: `pho ${i}` })),
      { ...base, placeId: "eth", area: "Central Square", label: "eth 0" },
    ];
    const c = { includedByPlace: new Map<string, number>(), includedByArea: new Map<string, number>(), today: "2026-11-24" };
    const out = prioritise(meals, c, 6, 5);
    // The three restaurants come first, best evidence first; only then a second meal from any of them.
    expect(out.slice(0, 3).map((m) => m.placeId)).toEqual(["big", "eth", "pho"]);
    expect(out).toHaveLength(5);
    expect(out[0].priority.reasons).toContain("new restaurant for testers");
    expect(out[3].priority.reasons).not.toContain("new restaurant for testers");
  });
});
