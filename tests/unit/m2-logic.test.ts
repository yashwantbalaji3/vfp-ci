import { describe, expect, it } from "vitest";
import { confidenceLabel, describeDietChoice, hiddenReasonText, presenceLabel } from "@/domain/dietary/labels";
import { correctionSchema, dietPreferenceSchema, nearbySchema, searchFiltersSchema, type ProteinFacts } from "@/contracts/catalog";
import { formatAmount, formatDistance, methodLabel, proteinFor, safeReturnPath } from "@/lib/format";
import { hrefWith, parseDiscoverParams, parseProteinParams, toggleCompare } from "@/lib/search-params";
import { illustrationStyleFor } from "@/components/food-illustration";

// M2 · T-DISCOVERY and T-PROTEIN logic that runs without a database (docs/14).
const eggFree = { diet: "vegetarian" as const, exclusions: ["egg"] };
const A = "00000000-0000-4000-8000-000000000101";
const B = "00000000-0000-4000-8000-000000001001";
const C = "00000000-0000-4000-8000-000000001101";
const D = "00000000-0000-4000-8000-000000001201";

describe("dietary confidence wording (owner rule 2026-11-13, R-D08)", () => {
  it("names the filter in plain words", () => {
    expect(describeDietChoice(eggFree)).toBe("Egg-free vegetarian");
    expect(describeDietChoice({ diet: "vegan", exclusions: ["honey"] })).toBe("Vegan, no honey");
    expect(describeDietChoice({ diet: "none", exclusions: ["egg", "dairy"] })).toBe("No egg, no dairy");
    expect(describeDietChoice({ diet: "none", exclusions: [] })).toBe("No dietary filter");
  });

  it("only a stated match is worded as a match", () => {
    expect(confidenceLabel("eligible", [], eggFree)).toEqual({ tone: "ok", text: "No egg · stated" });
    expect(confidenceLabel("eligible", [], { diet: "vegan", exclusions: [] })).toEqual({ tone: "ok", text: "Vegan · stated" });
  });

  it("unknown is never worded as safe, and names the unresolved ingredient", () => {
    const l = confidenceLabel("needs_confirmation", [{ code: "unconfirmed_excluded_family", family: "egg" }], eggFree);
    expect(l).toEqual({ tone: "ask", text: "Egg unconfirmed" });
    for (const code of ["no_dietary_claim", "dietary_claim_expired", "dietary_claim_disputed", "dietary_evidence_insufficient", "something_new"]) {
      const label = confidenceLabel("needs_confirmation", [{ code }], eggFree);
      expect(label.tone).toBe("ask");
      expect(label.text.toLowerCase()).not.toContain("stated");
    }
  });

  it("a required change is shown with its wording", () => {
    const reasons = [{ code: "requires_modification", modifications: "Ask for no fish sauce." }];
    expect(confidenceLabel("conditional", reasons, eggFree)).toEqual({ tone: "ask", text: "Only with a change", detail: "Ask for no fish sauce." });
    expect(confidenceLabel("needs_confirmation", reasons, eggFree).detail).toBe("Ask for no fish sauce.");
  });

  it("a contained ingredient is a stop", () => {
    expect(confidenceLabel("excluded", [{ code: "contains_excluded_family", family: "egg" }], eggFree)).toEqual({ tone: "no", text: "Contains egg" });
    expect(confidenceLabel("excluded", [{ code: "diet_incompatible" }], eggFree)).toEqual({ tone: "no", text: "Not vegetarian" });
    expect(hiddenReasonText("contains_family", "fish_sauce", 1)).toBe("1 item with fish sauce");
    expect(hiddenReasonText("contains_excluded_family", "egg", 2)).toBe("2 items with egg");
  });

  it("ingredient presence has three distinct wordings", () => {
    expect(presenceLabel("absent_by_statement", "Eggs").tone).toBe("ok");
    expect(presenceLabel("present", "Eggs")).toEqual({ tone: "no", text: "Contains eggs" });
    expect(presenceLabel("unknown", "Eggs")).toEqual({ tone: "ask", text: "Eggs not confirmed" });
    expect(presenceLabel("anything_else", "Eggs").tone).toBe("ask");
  });
});

describe("protein display (R-P02, R-P03, R-005)", () => {
  const facts: ProteinFacts = {
    method: "published", basis: { kind: "serving", amount: 1, unit: "serving" }, basisValue: 21, servingLabel: "1 burger", servingGrams: null,
    perServing: 21, perServingReason: null, per100g: null, per100gReason: "serving_weight_unknown", per100kcal: null,
    per100kcalReason: "energy_not_provided", energyKcalPerServing: null, energyMethod: null,
  };
  it("each basis carries its own words, and a missing basis stays missing with a reason", () => {
    expect(proteinFor(facts, "serving")).toEqual({ value: 21, reason: null, per: "per burger" });
    expect(proteinFor(facts, "100g")).toEqual({ value: null, reason: "serving_weight_unknown", per: "per 100 g" });
    expect(proteinFor(facts, "100kcal").value).toBeNull();
  });
  it("formats amounts without inventing precision", () => {
    expect(formatAmount(12.1428)).toBe("12.1");
    expect(formatAmount(24)).toBe("24");
    expect(formatAmount(8.3333)).toBe("8.3");
    expect(methodLabel(null)).toBe("Not provided");
    expect(methodLabel("estimated")).toBe("Estimated");
    expect(formatDistance(null)).toBeNull();
    expect(formatDistance(1609.344)).toBe("1.0 mi");
  });
});

describe("page address parameters", () => {
  it("drops values that are not valid instead of passing them on", () => {
    const f = parseDiscoverParams({ q: "  tofu ", view: "everything", price: "9", protein: "-4", type: "casino", offset: "abc", hood: "", est: "yes" });
    expect(f).toMatchObject({ q: "tofu", view: "matches", kinds: ["dish"], includeEstimates: false, offset: 0 });
    expect(f.maxPriceBand).toBeUndefined();
    expect(f.minProtein).toBeUndefined();
    expect(f.venueType).toBeUndefined();
    expect(f.neighborhood).toBeUndefined();
  });
  it("keeps valid filters", () => {
    const f = parseDiscoverParams({ view: "needs_confirmation", price: "2", protein: "20", type: "cafe", hood: "Allston", cuisine: "thai", est: "1", offset: "12" });
    expect(f).toMatchObject({ view: "needs_confirmation", maxPriceBand: 2, minProtein: 20, venueType: "cafe", neighborhood: "Allston", cuisine: "thai", includeEstimates: true, offset: 12 });
  });
  it("search text is cut to the limit", () => {
    expect(parseDiscoverParams({ q: "x".repeat(500) }).q).toHaveLength(120);
  });
  it("compare keeps at most three valid, distinct foods (R-P04)", () => {
    const p = parseProteinParams({ compare: [A, A, "not-an-id", B, C, D].join(","), basis: "100g", kind: "recipe" });
    expect(p.compare).toEqual([A, B, C]);
    expect(p.filters).toMatchObject({ basis: "100g", kinds: ["recipe"], sort: "protein" });
    expect(parseProteinParams({ basis: "per-cup", kind: "drink" })).toMatchObject({ kind: "all", compare: [] });
    expect(toggleCompare([A, B], C)).toEqual([A, B, C]);
    expect(toggleCompare([A, B, C], D)).toEqual([A, B, C]);
    expect(toggleCompare([A, B, C], B)).toEqual([A, C]);
  });
  it("builds addresses that keep the other filters", () => {
    expect(hrefWith("/protein", { basis: "100g", compare: A }, { kind: "dish" })).toBe(`/protein?basis=100g&compare=${A}&kind=dish`);
    expect(hrefWith("/protein", { basis: "100g" }, { basis: null })).toBe("/protein");
  });
  it("return paths stay on this site", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "", null, "javascript:alert(1)"]) {
      expect(safeReturnPath(bad)).toBe("/discover");
    }
    expect(safeReturnPath("/foods/abc?est=1")).toBe("/foods/abc?est=1");
  });
});

describe("input contracts", () => {
  it("dietary preference accepts only known diets and ingredient families", () => {
    expect(dietPreferenceSchema.safeParse({ diet: "keto" }).success).toBe(false);
    expect(dietPreferenceSchema.safeParse({ diet: "vegan", exclusions: ["peanut"] }).success).toBe(false);
    expect(dietPreferenceSchema.parse({})).toEqual({ diet: "none", exclusions: [], includeConditional: false });
  });
  it("search limits are enforced before the database is called", () => {
    expect(searchFiltersSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(searchFiltersSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(searchFiltersSchema.safeParse({ venueId: "1 or 1=1" }).success).toBe(false);
    expect(searchFiltersSchema.safeParse({ q: "x".repeat(121) }).success).toBe(false);
  });
  it("a location must be a real point and a bounded radius", () => {
    expect(nearbySchema.safeParse({ lat: 91, lon: 0 }).success).toBe(false);
    expect(nearbySchema.safeParse({ lat: 42.36, lon: -71.1, radiusM: 50001 }).success).toBe(false);
    expect(nearbySchema.parse({ lat: 42.36, lon: -71.1 }).radiusM).toBe(5000);
  });
  it("a correction targets exactly one thing and says what should change", () => {
    expect(correctionSchema.safeParse({ foodItemId: A, field: "egg", proposedValue: "Contains egg wash" }).success).toBe(true);
    expect(correctionSchema.safeParse({ foodItemId: A, venueId: B, field: "egg", proposedValue: "Contains egg wash" }).success).toBe(false);
    expect(correctionSchema.safeParse({ field: "egg", proposedValue: "Contains egg wash" }).success).toBe(false);
    expect(correctionSchema.safeParse({ foodItemId: A, field: "password", proposedValue: "x y z" }).success).toBe(false);
    expect(correctionSchema.safeParse({ foodItemId: A, field: "egg", proposedValue: "no" }).success).toBe(false);
  });
});

describe("illustrations", () => {
  it("every name maps to a drawn style", () => {
    expect(illustrationStyleFor("Demo paneer tikka")).toBe("paneer");
    expect(illustrationStyleFor("Something unheard of")).toBe("bowl");
  });
});
