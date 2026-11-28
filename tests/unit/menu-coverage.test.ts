import { describe, expect, it } from "vitest";
import { addCoverage, placeCoverage, proteinSource } from "@/contracts/menu-coverage";
import type { MenuDish, MenuFact } from "@/contracts/menu-review";

// Coverage of the private drafts (owner direction 18 Nov 2026 20:56 UTC): every count stays separate.

const fact = (p: Partial<MenuFact>): MenuFact => ({
  factId: crypto.randomUUID(),
  kind: "price",
  subject: null,
  value: { usd: "12.00" },
  unknown: false,
  unknownReason: null,
  status: "submitted",
  confidence: "high",
  sourceId: "11111111-1111-4111-8111-111111111111",
  checkedOn: "2026-11-18",
  access: "private_pilot",
  confirmAs: "transcription",
  canConfirm: true,
  canReject: true,
  statuses: { extracted: true, transcriptionConfirmed: false, dietaryVerified: false, nutritionVerified: false, reuseEligible: false, publicationApproved: false },
  ...p,
});
const diet = (claim: string, status: string | null) =>
  fact({ kind: "dietary_status", subject: claim, value: status ? { claim, status } : null, unknown: !status, unknownReason: status ? null : "Not stated" });
const protein = (v: Record<string, unknown>) => fact({ kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", per: "serving", ...v } });
const dish = (type: string | null, facts: MenuFact[], extra: Partial<MenuDish> = {}): MenuDish => ({
  dishId: crypto.randomUUID(),
  label: "Dish",
  structure: type ? { type: type as never, parentDishId: null, section: "Mains", portion: null, basis: "source_section", evidence: null } : null,
  options: [],
  estimate: null,
  facts,
  corrections: [],
  ...extra,
});
const est = (state: "estimated" | "unknown") => ({
  state: "modelled" as const,
  modelId: crypto.randomUUID(),
  evidence: "listed_ingredients" as const,
  at: "x",
  modelStatus: "draft" as const,
  assumptions: "x",
  servingBasis: "typical",
  lines: [],
  result: { state, central: state === "estimated" ? 20 : null, low: state === "estimated" ? 15 : null, high: state === "estimated" ? 25 : null, confidence: state === "estimated" ? ("low" as const) : null, reason: state === "estimated" ? null : "range_too_wide" },
});

describe("menu coverage", () => {
  it("counts a meal that names meat and makes no dietary claim, without calling it anything", () => {
    const place = {
      dishes: [
        dish("complete_meal", [fact({}), diet("vegetarian", null)], { label: "The Classic Chicken Bowl" }),
        dish("complete_meal", [fact({}), diet("vegan", "yes")], { label: "Crispy Chik’n Sandwich" }),
        dish("complete_meal", [fact({}), diet("vegetarian", null)], { label: "Falafel Roll" }),
      ],
    };
    const c = placeCoverage(place);
    expect(c.namesMeatWithoutClaim).toBe(1);
    expect(c.dietary.notStated).toBe(2);
  });
  it("puts each complete meal in exactly one protein bucket, restaurant figures first", () => {
    expect(proteinSource(dish("complete_meal", [protein({ amount: "20" })], { estimate: est("estimated") }))).toBe("publishedValue");
    expect(proteinSource(dish("complete_meal", [protein({ low: "10", high: "14", basis: "published_range" })]))).toBe("publishedRange");
    expect(proteinSource(dish("complete_meal", [protein({ amount: "9", basis: "restaurant_estimate" })]))).toBe("restaurantEstimate");
    expect(proteinSource(dish("complete_meal", [], { estimate: est("estimated") }))).toBe("usdaEstimate");
    expect(proteinSource(dish("complete_meal", [], { estimate: est("unknown") }))).toBe("usdaUnknown");
    expect(proteinSource(dish("complete_meal", [], { estimate: { state: "unknown", reason: "x", at: "x" } }))).toBe("usdaUnknown");
    expect(proteinSource(dish("complete_meal", [fact({ kind: "published_nutrition", subject: "protein_g", value: null, unknown: true, unknownReason: "Not printed" })]))).toBe("none");
  });

  it("keeps meals, build-your-own meals, parts and others apart, and dietary evidence apart from estimates", () => {
    const place = {
      dishes: [
        dish("complete_meal", [fact({}), diet("vegan", "yes")], { estimate: est("estimated") }),
        dish("complete_meal", [fact({}), diet("vegetarian", "yes"), diet("vegan", null)]),
        dish("complete_meal", [fact({}), diet("vegetarian", null)], { estimate: est("estimated") }),
        dish("customizable_meal", [diet("vegan", "yes")]),
        dish("component", [protein({ amount: "5" })]),
        dish("beverage", [fact({})]),
        dish(null, [fact({ confidence: "low" })]),
      ],
    };
    const c = placeCoverage(place);
    expect(c).toMatchObject({ rows: 7, completeMeals: 3, customizableMeals: 1, parts: 1, sidesDrinksDesserts: 1, unclassified: 1 });
    expect(c.protein).toEqual({ publishedValue: 0, publishedRange: 0, restaurantEstimate: 0, usdaEstimate: 2, usdaUnknown: 0, none: 1 });
    expect(c.mealsWithPublishedNutrition).toBe(0);
    // Complete meals only, one bucket each: the buckets add up to the 3 complete meals.
    expect(c.dietary).toEqual({ veganStated: 1, vegetarianStated: 1, notStated: 1, noEvidence: 0, notVegetarian: 0 });
    expect(Object.values(c.dietary).reduce((a, b) => a + b, 0)).toBe(c.completeMeals);
    expect(c.dietaryBuildYourOwn).toEqual({ veganStated: 1, vegetarianStated: 0, notStated: 0, noEvidence: 0, notVegetarian: 0 });
    expect(c.review.waitingRows).toBe(7);
    expect(c.review.exceptions + c.review.cleanWaiting).toBe(7);
    const both = addCoverage([c, c]);
    expect(both.completeMeals).toBe(6);
    expect(both.protein.usdaEstimate).toBe(4);
    expect(both.dietary.veganStated).toBe(2);
    expect(both.dietaryBuildYourOwn.veganStated).toBe(2);
  });
  it("counts a catering platter apart, never as one person's complete meal", () => {
    const tray = dish("complete_meal", [fact({}), diet("vegan", "yes")]);
    tray.structure = { ...tray.structure!, section: "Catering: Salads (platters cater 20 people)" };
    const c = placeCoverage({ dishes: [tray, dish("complete_meal", [fact({})])] });
    expect(c).toMatchObject({ rows: 2, completeMeals: 1, groupPlatters: 1, unclassified: 0 });
    expect(c.dietary.veganStated).toBe(0);
  });
});
