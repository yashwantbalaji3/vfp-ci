import { describe, expect, it } from "vitest";
import { builderFor, combine, readSelection } from "@/contracts/meal-builder";
import type { MenuDish, MenuFact, MenuPlace } from "@/contracts/menu-review";

// Build-your-own meals (docs/60): a total only when every chosen part has a printed protein figure for the
// portion served, never from a range, an estimate or a per-100 g figure; the diet of a combination from the
// restaurant's own words for every part. Invented dishes only.

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
const place = (dishes: MenuDish[], retrievedAt = "2026-11-18T12:00:00Z"): MenuPlace => ({
  placeId: crypto.randomUUID(),
  label: "Test Kitchen",
  area: "back_bay",
  city: "Boston",
  sources: [{ sourceId: SRC, url: "https://test.example/menu", host: "test.example", kind: "restaurant_site", publisher: "Test", retrievedAt, access: "private_pilot" }],
  placeFacts: [],
  dishes,
});

const part = (label: string, type: "base" | "protein" | "topping_sauce", parent: string, facts: MenuFact[], portion: string | null = null) =>
  dish(label, facts, { structure: { type, parentDishId: parent, section: "Build", portion, basis: "source_section", evidence: null } as MenuDish["structure"] });

function bowl() {
  const b = dish("Build your own bowl", [fact({ kind: "menu_item", value: { name: "Build your own bowl" } })], { structure: { ...meal, type: "customizable_meal" } as MenuDish["structure"] });
  const rice = part("Rice", "base", b.dishId, [nut("protein_g", { amount: 4 }), nut("energy_kcal", { amount: 200 }), diet("vegan")]);
  const greens = part("Greens", "base", b.dishId, [nut("protein_g", { amount: 2 }), diet("vegan")]);
  const falafel = part("Falafel", "protein", b.dishId, [nut("protein_g", { amount: 9.5 }), nut("energy_kcal", { amount: 300 }), diet("vegan")]);
  const halloumi = part("Halloumi", "protein", b.dishId, [nut("protein_g", { amount: 14 }), diet("vegetarian")]);
  const chicken = part("Chicken", "protein", b.dishId, [nut("protein_g", { amount: 30 })]);
  const tahini = part("Tahini", "topping_sauce", b.dishId, [nut("protein_g", { amount: 3 }), nut("energy_kcal", { amount: 90 }), diet("vegan")]);
  const ranged = part("Hummus", "topping_sauce", b.dishId, [nut("protein_g", { basis: "published_range", low: 2, high: 4, amount: null }), diet("vegan")]);
  const per100 = part("Pickles", "topping_sauce", b.dishId, [nut("protein_g", { amount: 1, per: "100g" }), diet("vegan")]);
  const p = place([b, rice, greens, falafel, halloumi, chicken, tahini, ranged, per100]);
  return { p, b, rice, greens, falafel, halloumi, chicken, tahini, ranged, per100 };
}

describe("build-your-own meals", () => {
  it("collects the parts by group with meat last, and is null for a meal that isn't build-your-own", () => {
    const x = bowl();
    const b = builderFor(x.p, x.b.dishId)!;
    expect(b.groups.base.map((p) => p.label)).toEqual(["Greens", "Rice"]);
    expect(b.groups.protein.map((p) => p.label)).toEqual(["Falafel", "Halloumi", "Chicken"]);
    expect(b.groups.protein.at(-1)!.namesMeat).toBe(true);
    expect(builderFor(x.p, x.rice.dishId)).toBeNull();
    expect(builderFor(x.p, crypto.randomUUID())).toBeNull();
  });

  it("reads a selection from the address, keeping only this meal's parts in the right group", () => {
    const x = bowl();
    const b = builderFor(x.p, x.b.dishId)!;
    expect(readSelection(b, { base: x.falafel.dishId, protein: x.falafel.dishId, top: [x.tahini.dishId, x.tahini.dishId, x.rice.dishId, "nope"] })).toEqual({
      wrap: null,
      base: null,
      protein: x.falafel.dishId,
      toppings: [x.tahini.dishId],
    });
  });

  it("adds up printed figures only, and says it is added up, not printed", () => {
    const x = bowl();
    const b = builderFor(x.p, x.b.dishId)!;
    const c = combine(b, { wrap: null, base: x.rice.dishId, protein: x.falafel.dishId, toppings: [x.tahini.dishId] });
    expect(c.total.protein).toBe(16.5);
    expect(c.total.kcal).toBe(590);
    expect(c.total.fat).toBeNull(); // not printed for any part: unknown, never zero
    expect(c.complete).toBe(true);
    expect(c.diet).toBe("vegan_stated");
    expect(c.words).toMatch(/Added up from the restaurant's own per-item figures/);
    expect(c.words).toMatch(/doesn't print a figure for this combination/);
  });

  it("leaves the total unknown when any chosen part has only a range or a per-100 g figure", () => {
    const x = bowl();
    const b = builderFor(x.p, x.b.dishId)!;
    for (const top of [x.ranged, x.per100]) {
      const c = combine(b, { wrap: null, base: x.rice.dishId, protein: x.falafel.dishId, toppings: [top.dishId] });
      expect(c.total.protein).toBeNull();
      expect(c.missing.map((p) => p.label)).toEqual([top.label]);
      expect(c.words).toMatch(/^Total unknown/);
    }
  });

  it("calls a combination vegan only when every part says vegan, and never vegetarian with meat", () => {
    const x = bowl();
    const b = builderFor(x.p, x.b.dishId)!;
    expect(combine(b, { wrap: null, base: x.rice.dishId, protein: x.halloumi.dishId, toppings: [] }).diet).toBe("vegetarian_stated");
    expect(combine(b, { wrap: null, base: x.rice.dishId, protein: x.chicken.dishId, toppings: [] }).diet).toBe("not_vegetarian");
    expect(combine(b, { wrap: null, base: null, protein: null, toppings: [] })).toMatchObject({ diet: "unknown", complete: false, total: { protein: null } });
    expect(combine(b, { wrap: null, base: x.rice.dishId, protein: null, toppings: [] }).complete).toBe(false);
  });

  it("adds a figure only when it was printed for the portion this meal serves, and never scales it", () => {
    const b0 = dish("Build your own bowl", [], { structure: { ...meal, type: "customizable_meal" } as MenuDish["structure"] });
    const rice = part("Rice", "base", b0.dishId, [nut("protein_g", { amount: 4, portion: "5 oz" })], "5 oz");
    const falafel = part("Falafel", "protein", b0.dishId, [nut("protein_g", { amount: 13, portion: "6 each" })], "6 each");
    const baba = part("Baba Ghannouj", "topping_sauce", b0.dishId, [nut("protein_g", { amount: 2, portion: "2 oz" })], "1 oz");
    const b = builderFor(place([b0, rice, falafel, baba]), b0.dishId)!;
    expect(b.parts.find((p) => p.label === "Rice")!.printed.protein).toBe(4);
    expect(b.parts.find((p) => p.label === "Baba Ghannouj")!.printed.protein).toBeNull();
    const c = combine(b, { wrap: null, base: rice.dishId, protein: falafel.dishId, toppings: [baba.dishId] });
    expect(c.total.protein).toBeNull();
    expect(c.missing.map((p) => p.label)).toEqual(["Baba Ghannouj"]);
    expect(combine(b, { wrap: null, base: rice.dishId, protein: falafel.dishId, toppings: [] }).total.protein).toBe(17);
  });

  it("wraps a roll in exactly one bread; its filling base is optional", () => {
    const r = dish("Build your own roll", [], { structure: { ...meal, type: "customizable_meal" } as MenuDish["structure"] });
    const pita = part("White Pita", "base", r.dishId, [nut("protein_g", { amount: 10 }), diet("vegan")], "1 each");
    const wheat = part("Whole Wheat Pita", "base", r.dishId, [nut("protein_g", { amount: 11 })], "1 each");
    const rice = part("Vermicelli Rice (in a roll)", "base", r.dishId, [nut("protein_g", { amount: 3 })], "5 oz");
    const falafel = part("Falafel (in a roll)", "protein", r.dishId, [nut("protein_g", { amount: 13 }), diet("vegan")], "6 each");
    const b = builderFor(place([r, pita, wheat, rice, falafel]), r.dishId)!;
    expect(b.groups.wrap.map((p) => p.label)).toEqual(["White Pita", "Whole Wheat Pita"]);
    expect(b.groups.base.map((p) => p.label)).toEqual(["Vermicelli Rice (in a roll)"]);
    expect(b.rules).toMatchObject({ wrap: { min: 1, max: 1 }, base: { min: 0, max: 1 }, protein: { min: 1, max: 1 } });
    const noBread = combine(b, { wrap: null, base: rice.dishId, protein: falafel.dishId, toppings: [] });
    expect(noBread.complete).toBe(false);
    expect(noBread.needs).toEqual(["wrap"]);
    const c = combine(b, readSelection(b, { wrap: pita.dishId, protein: falafel.dishId }));
    expect(c).toMatchObject({ complete: true, total: { protein: 23 }, diet: "vegan_stated" });
    // A bread is never taken as a protein or a filling, and a bowl has no bread step.
    expect(readSelection(b, { base: pita.dishId, protein: pita.dishId })).toMatchObject({ base: null, protein: null });
    const x = bowl();
    expect(builderFor(x.p, x.b.dishId)!.groups.wrap).toEqual([]);
  });
});
