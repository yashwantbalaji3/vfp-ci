import { describe, expect, it } from "vitest";
import type { ProteinFacts } from "@/contracts/catalog";
import { amountText, proteinRangeFor } from "@/lib/format";

// Owner 18:17 UTC 16 Nov: "Estimated protein must never be displayed as an exact measurement."
describe("amountText: an estimate is never worded as a measurement", () => {
  it("shows an exact figure as it is", () => {
    expect(amountText(24, "g", "published")).toBe("24 g");
    expect(amountText(21.04, "g", "calculated")).toBe("21 g");
    expect(amountText(12, "g", "user_entered")).toBe("12 g");
    expect(amountText(12, "g", null)).toBe("12 g");
  });
  it("says 'about' and gives the range for an estimate", () => {
    expect(amountText(28, "g", "estimated", 24, 32)).toBe("about 28 g (estimate 24–32 g)");
    expect(amountText(28, "kcal", "estimated", 24.25, 32)).toBe("about 28 kcal (estimate 24.3–32 kcal)");
  });
  it("still says 'about … (estimate)' when the range is not at hand", () => {
    expect(amountText(28, "g", "estimated")).toBe("about 28 g (estimate)");
    expect(amountText(28, "g", "estimated", 24, null)).toBe("about 28 g (estimate)");
    expect(amountText(28, "g", "estimated")).not.toMatch(/^28/);
  });
});

const facts = (over: Partial<ProteinFacts>): ProteinFacts => ({
  method: "estimated", basis: { kind: "serving", amount: 1, unit: "serving" }, basisValue: 28, servingLabel: "1 bowl", servingGrams: 400,
  perServing: 28, perServingReason: null, per100g: 7, per100gReason: null, per100kcal: null, per100kcalReason: "energy_not_provided",
  energyKcalPerServing: null, energyMethod: null, estimateLow: 24, estimateHigh: 32, ...over,
});

describe("proteinRangeFor: an estimate's range on every basis", () => {
  it("scales the range by the same factor as the value", () => {
    expect(proteinRangeFor(facts({}), "serving")).toEqual({ low: 24, high: 32 });
    expect(proteinRangeFor(facts({}), "100g")).toEqual({ low: 6, high: 8 });
  });
  it("has no range for an exact figure, an unknown value or a missing basis value", () => {
    expect(proteinRangeFor(facts({ method: "published", estimateLow: null, estimateHigh: null }), "serving")).toBeNull();
    expect(proteinRangeFor(facts({}), "100kcal")).toBeNull();
    expect(proteinRangeFor(facts({ perServing: null, perServingReason: "estimate_hidden" }), "serving")).toBeNull();
    expect(proteinRangeFor(facts({ estimateLow: undefined, estimateHigh: undefined }), "serving")).toBeNull();
  });
});
