import { describe, expect, it } from "vitest";
import { autoChecks, byProtein, previewMeals, proteinPer100kcal, type PreviewMeal } from "@/contracts/menu-preview";
import { applyLens, mealFit } from "@/contracts/meal-eligibility";

const fits = (m: PreviewMeal, diet: "none" | "vegetarian" | "vegan") => !m.excluded && mealFit(m.evidence, { diet, exclusions: [] }).status === "eligible";
import type { MenuDish, MenuEstimate, MenuFact, MenuPlace } from "@/contracts/menu-review";
import { compareFact, otherDishStarts } from "../../scripts/lib/source-compare.mjs";

// The founder-only private beta on real data (docs/59): diet categories from the restaurant's own words
// only, one protein figure per meal by its basis, meals that name meat left out of discovery, and the
// automatic checks. Invented dishes only.

const SRC = "11111111-1111-4111-8111-111111111111";
const fact = (p: Partial<MenuFact>): MenuFact => ({
  factId: crypto.randomUUID(),
  kind: "price",
  subject: null,
  value: { usd: "12.00" },
  unknown: false,
  unknownReason: null,
  status: "submitted",
  confidence: "high",
  sourceId: SRC,
  checkedOn: "2026-11-18",
  access: "private_pilot",
  confirmAs: "transcription",
  canConfirm: true,
  canReject: true,
  statuses: { extracted: true, transcriptionConfirmed: false, dietaryVerified: false, nutritionVerified: false, reuseEligible: false, publicationApproved: false },
  ...p,
});
const diet = (claim: "vegan" | "vegetarian", status = "yes") => fact({ kind: "dietary_status", subject: claim, value: { claim, status } });
const nut = (nutrient: string, value: Record<string, unknown>) => fact({ kind: "published_nutrition", subject: nutrient, value: { nutrient, per: "serving", ...value } });
const meal = { type: "complete_meal" as const, parentDishId: null, section: "Bowls", portion: null, basis: "source_section" as const, evidence: null };
const dish = (label: string, facts: MenuFact[], extra: Partial<MenuDish> = {}): MenuDish => ({
  dishId: crypto.randomUUID(),
  label,
  structure: meal,
  options: [],
  estimate: null,
  facts,
  corrections: [],
  ...extra,
});
const usda = (low: number | null, high: number | null, state: "estimated" | "unknown" = "estimated"): MenuEstimate => ({
  state: "modelled",
  modelId: crypto.randomUUID(),
  evidence: "listed_ingredients",
  at: "2026-11-18T00:00:00Z",
  modelStatus: "draft",
  assumptions: "Typical restaurant portion of cooked lentils",
  servingBasis: "one bowl as listed",
  lines: [{ label: "Lentils, cooked", fdcId: 172421, usda: "SR Legacy 172421", release: "SR Legacy", grams: 200, gramsLow: 150, gramsHigh: 250, amountBasis: "typical_portion" }],
  result: { state, central: low && high ? (low + high) / 2 : null, low, high, confidence: "medium", reason: state === "unknown" ? "range_too_wide" : null },
});
const place = (dishes: MenuDish[], retrievedAt = "2026-11-18T12:00:00Z"): MenuPlace => ({
  placeId: crypto.randomUUID(),
  label: "Test Kitchen",
  area: "back_bay",
  city: "Boston",
  sources: [{ sourceId: SRC, url: "https://test.example/menu", host: "test.example", kind: "restaurant_site", publisher: "Test", retrievedAt, access: "private_pilot" }],
  placeFacts: [],
  dishes,
});
const NOW = Date.parse("2026-11-19T12:00:00Z");

describe("diet in the preview", () => {
  it("uses only the restaurant's own words, and an unknown diet never qualifies for vegetarian or vegan", () => {
    const [v, vg, u, nv] = previewMeals(
      place([
        dish("A vegan bowl", [fact({}), diet("vegan")]),
        dish("B vegetarian bowl", [fact({}), diet("vegetarian")]),
        dish("C lentil bowl", [fact({})]),
        dish("D not veg", [fact({}), diet("vegetarian", "no")]),
      ]),
      NOW,
    );
    expect([v.diet, vg.diet, u.diet, nv.diet]).toEqual(["vegan_stated", "vegetarian_stated", "unknown", "not_vegetarian"]);
    expect([v, vg, u, nv].map((m) => fits(m, "vegan"))).toEqual([true, false, false, false]);
    expect([v, vg, u, nv].map((m) => fits(m, "vegetarian"))).toEqual([true, true, false, false]);
    expect([v, vg, u, nv].map((m) => fits(m, "none"))).toEqual([true, true, true, false]);
    expect(nv.excluded).toMatch(/not vegetarian/);
  });
  it("leaves a meal that names meat with no vegetarian claim out of discovery", () => {
    const [m] = previewMeals(place([dish("Classic Chicken Bowl", [fact({})])]), NOW);
    expect(m.diet).toBe("unknown");
    expect(m.excluded).toMatch(/name meat/);
    expect(applyLens([m], { choice: { diet: "none", exclusions: [] }, view: "all" }).shown).toEqual([]);
  });
  it("lists complete meals only", () => {
    const side = dish("Side of rice", [fact({})], { structure: { ...meal, type: "side" } });
    expect(previewMeals(place([side, dish("Bowl", [fact({})])]), NOW).map((m) => m.label)).toEqual(["Bowl"]);
  });
  it("leaves out platters for a group: a catering tray is not one person's meal", () => {
    const tray = dish("Falafel platter", [fact({})], { structure: { ...meal, section: "Catering: Entrees (platters cater 20 people)" } });
    const serves = dish("Veggie tray", [fact({})], { structure: { ...meal, section: "Trays", portion: "serves 12" } });
    expect(previewMeals(place([tray, serves, dish("Falafel plate", [fact({})])]), NOW).map((m) => m.label)).toEqual(["Falafel plate"]);
  });
});

describe("protein in the preview", () => {
  const one = (d: MenuDish) => previewMeals(place([d]), NOW)[0].protein;
  it("labels each basis, and the restaurant's own figure wins over a USDA estimate", () => {
    expect(one(dish("P", [nut("protein_g", { amount: "21" })], { estimate: usda(10, 15) }))).toMatchObject({ basis: "published", low: 21, high: 21 });
    expect(one(dish("R", [nut("protein_g", { low: "24", high: "27", basis: "published_range" })]))).toMatchObject({ basis: "published_range", low: 24, high: 27, sortValue: 24 });
    expect(one(dish("E", [nut("protein_g", { amount: "10", basis: "restaurant_estimate" })])).words).toMatch(/restaurant's own estimate/);
  });
  it("shows a USDA range with its assumptions and confidence, and never as verified or as the restaurant's figure", () => {
    const p = one(dish("U", [], { estimate: usda(14.2, 22.6) }));
    expect(p).toMatchObject({ basis: "usda_range", low: 14, high: 23, sortValue: 14 });
    expect(p.words).toMatch(/Not the restaurant's figure and not verified/);
    expect(p.usda).toMatchObject({ confidence: "medium", assumptions: "Typical restaurant portion of cooked lentils", modelReviewed: false });
  });
  it("keeps unknown protein unknown, with the reason, never zero", () => {
    expect(one(dish("W", [], { estimate: usda(null, null, "unknown") }))).toMatchObject({ basis: "unknown", low: null, sortValue: null, unknownReason: expect.stringMatching(/too wide/) });
    expect(one(dish("N", []))).toMatchObject({ basis: "unknown", low: null });
  });
  it("sorts by the low end, unknown last, and gives per 100 kcal only from the restaurant's own figures", () => {
    const m = (label: string, low: number | null, high = low, basis: PreviewMeal["protein"]["basis"] = "published") =>
      ({ label, protein: { basis, low, high, sortValue: low } }) as PreviewMeal;
    const sorted = [m("a", null), m("b", 20, 30, "usda_range"), m("c", 25)].sort(byProtein).map((x) => x.label);
    expect(sorted).toEqual(["c", "b", "a"]);
    expect(proteinPer100kcal({ ...m("x", 30), kcal: 600 })).toEqual({ low: 5, high: 5 });
    expect(proteinPer100kcal({ ...m("y", 20, 30, "usda_range"), kcal: 600 })).toBeNull();
    expect(proteinPer100kcal({ ...m("z", 30), kcal: null })).toBeNull();
  });
});

describe("automatic checks", () => {
  const codes = (d: MenuDish, all = [d], at?: string) => autoChecks(d, place(all, at), NOW).map((c) => `${c.code}:${c.level}`);
  it("flags nutrition on different servings and sizes with one figure", () => {
    expect(codes(dish("S", [nut("protein_g", { amount: "10" }), nut("energy_kcal", { amount: "200", per: "100g" })]))).toContain("serving_basis:check");
    const sized = dish("Salad", [nut("protein_g", { amount: "10" })], { options: [{ kind: "size", label: "Large", componentDishId: null, priceDeltaUsd: "3.00", sourceId: SRC }] });
    expect(codes(sized)).toContain("option_dependent:check");
  });
  it("tells a duplicate listing from a conflicting one", () => {
    const a = dish("Falafel Plate", [fact({}), nut("protein_g", { amount: "20" })]);
    const same = dish("falafel plate", [fact({}), nut("protein_g", { amount: "20" })]);
    const diff = dish("The Falafel Plate", [fact({ value: { usd: "15.00" } }), nut("protein_g", { amount: "25" })]);
    expect(codes(a, [a, same])).toContain("duplicate_listing:note");
    expect(autoChecks(a, place([a, diff]), NOW).find((c) => c.code === "conflicting_nutrition")?.words).toMatch(/different protein and price/);
  });
  it("flags a value found only under the next dish, and an old saved page", () => {
    const d = dish("T", [fact({ machineCheck: { result: "not_found", detail: "$9 does not appear. It appears only after the next dish begins, so it may belong to that dish.", pageSavedAt: null, at: "2026-11-18" } })]);
    expect(codes(d)).toContain("dish_to_value:check");
    expect(codes(dish("Old", [fact({})]), undefined, "2026-07-01T00:00:00Z")).toContain("source_age:check");
    expect(codes(dish("Fresh", [fact({})]))).not.toContain("source_age:check");
  });
});

describe("dish-to-value comparison with the saved page", () => {
  const text = "menu lentil bowl lentils rice greens $12.95 tofu bowl crispy tofu rice $14.95 brown rice $3.00";
  const others = [{ label: "Tofu bowl", usd: "14.95" }, { label: "Brown rice", usd: "3.00" }, { label: "Rice", usd: null }];
  it("credits a value only before the next dish starts", () => {
    const starts = otherDishStarts(text, "Lentil bowl", others);
    expect(compareFact(text, { kind: "price", dish: "Lentil bowl", value: { usd: "12.95" } }, starts)).toMatchObject({ result: "found", detail: expect.stringMatching(/before the next dish starts/) });
    const r = compareFact(text, { kind: "price", dish: "Lentil bowl", value: { usd: "14.95" } }, starts);
    expect(r).toMatchObject({ result: "not_found", detail: expect.stringMatching(/may belong to that dish/) });
  });
  it("counts another dish as a start only where its own price follows it", () => {
    // "rice" inside the lentil bowl's description is not the side called "Rice", which has no drafted price.
    const starts = otherDishStarts(text, "Lentil bowl", others);
    expect(starts).toEqual([text.indexOf(" tofu bowl"), text.indexOf(" brown rice")]);
  });
});

describe("distinctBranchNames (bug B2, docs/68)", () => {
  it("adds the street only where two preview places share a name", async () => {
    const { distinctBranchNames } = await import("@/contracts/menu-preview");
    const out = distinctBranchNames([
      { name: "Cafe Landwer", street: "653 Boylston St" },
      { name: "cafe landwer", street: "383 Chestnut Hill Ave" },
      { name: "NAYA", street: "500 Boylston St" },
    ]);
    expect(out.map((e) => e.name)).toEqual(["Cafe Landwer (653 Boylston St)", "cafe landwer (383 Chestnut Hill Ave)", "NAYA"]);
  });
});

describe("cardNotes (bugs B3 and B6, docs/68)", () => {
  it("explains a meat word on a meal the restaurant labels vegan, and never changes the diet", async () => {
    const { cardNotes } = await import("@/contracts/menu-preview");
    expect(cardNotes({ label: "Steak Asada Burrito", section: "Burritos", diet: "vegan_stated" }).plant).toBe("Plant-based: the restaurant labels it vegan");
    expect(cardNotes({ label: "Plant-based Chicken Sandwich", section: null, diet: "vegan_stated" }).plant).toBeNull();
    expect(cardNotes({ label: "Steak Asada Burrito", section: null, diet: "unknown" }).plant).toBeNull();
    expect(cardNotes({ label: "Falafel bowl", section: null, diet: "vegan_stated" }).plant).toBeNull();
  });
  it("says why a diet-sounding section sits beside an unknown diet", async () => {
    const { cardNotes } = await import("@/contracts/menu-preview");
    expect(cardNotes({ label: "Pad Thai", section: "Vegetarian Specialties", diet: "unknown" }).section).toMatch(/section name is not a diet label/);
    expect(cardNotes({ label: "Pad Thai", section: "Vegetarian Specialties", diet: "vegetarian_stated" }).section).toBeNull();
    expect(cardNotes({ label: "Pad Thai", section: "Noodles", diet: "unknown" }).section).toBeNull();
  });
});

describe("prices from an old menu edition (owner decision 28 Nov 2026)", () => {
  const OLD = "https://phopasteurboston.net/Boston%20Full%20Menu-2024-September.pdf";
  it("keeps the price as a historical record and never shows it as current", () => {
    const p = place([dish("Tofu Pho", [fact({ value: { usd: "15.00" } })])]);
    p.sources = [{ ...p.sources[0], url: OLD }];
    const [m] = previewMeals(p, NOW);
    expect(m.priceUsd).toBeNull();
    expect(m.historicalPrice).toEqual({ usd: "15.00", edition: "September 2024" });
  });
  it("leaves a price from an undated or recent menu as the current price", () => {
    const [m] = previewMeals(place([dish("Bowl", [fact({})])]), NOW);
    expect(m.priceUsd).toBe("12.00");
    expect(m.historicalPrice).toBeNull();
  });
});
