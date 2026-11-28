import { describe, expect, it } from "vitest";
import { correctionValue, factLabel, factWords, rowConfirmable, rowDecisions, type MenuDish, type MenuFact, LADDER_STEPS, ladderCounts, ladderReached } from "@/contracts/menu-review";

// The founder's batch menu review (docs/58): row choices become explicit per-fact decisions, and a
// correction must fit the shape of its kind. Pure functions; the database checks everything again.

const fact = (p: Partial<MenuFact>): MenuFact => ({
  factId: crypto.randomUUID(),
  kind: "price",
  subject: null,
  value: { usd: "12.00" },
  unknown: false,
  unknownReason: null,
  status: "submitted",
  confidence: "high",
  sourceId: crypto.randomUUID(),
  checkedOn: "2026-11-18",
  access: "cleared",
  confirmAs: "verify",
  canConfirm: true,
  canReject: true,
  statuses: { extracted: true, transcriptionConfirmed: false, dietaryVerified: false, nutritionVerified: false, reuseEligible: true, publicationApproved: false },
  ...p,
});
const dish = (facts: MenuFact[]): MenuDish => ({ dishId: crypto.randomUUID(), label: "Test bowl", structure: null, options: [], estimate: null, facts, corrections: [] });

describe("row choices", () => {
  it("confirm covers only facts that can be confirmed; reject covers waiting facts; later adds nothing", () => {
    const a = dish([fact({}), fact({ status: "verified", canConfirm: false, canReject: false })]);
    const b = dish([fact({}), fact({ canConfirm: false })]);
    const c = dish([fact({})]);
    const out = rowDecisions([a, b, c], { [a.dishId]: "confirm", [b.dishId]: "reject", [c.dishId]: "later" }, "checked on the menu page");
    expect(out).toEqual([
      { factId: a.facts[0].factId, decision: "verify", note: "checked on the menu page" },
      { factId: b.facts[0].factId, decision: "reject", note: "checked on the menu page" },
      { factId: b.facts[1].factId, decision: "reject", note: "checked on the menu page" },
    ]);
    expect(rowDecisions([a], {})).toEqual([]);
  });

  it("a row can be confirmed only when every waiting fact in it can be", () => {
    expect(rowConfirmable(dish([fact({}), fact({})]))).toBe(true);
    expect(rowConfirmable(dish([fact({}), fact({ canConfirm: false })]))).toBe(false);
    expect(rowConfirmable(dish([fact({ status: "verified", canConfirm: false })]))).toBe(false);
  });
});

describe("corrections", () => {
  it("builds a value of the right shape, or refuses", () => {
    expect(correctionValue("price", null, { usd: "12.95" })).toEqual({ usd: "12.95" });
    expect(correctionValue("price", null, { usd: "12.9" })).toBeNull();
    expect(correctionValue("listed_ingredients", null, { items: "chickpeas, tahini,\nrice, " })).toEqual({ items: ["chickpeas", "tahini", "rice"] });
    expect(correctionValue("listed_ingredients", null, { items: " , " })).toBeNull();
    expect(correctionValue("dietary_status", "vegan", { status: "yes" })).toEqual({ claim: "vegan", status: "yes" });
    expect(correctionValue("dietary_status", "vegan", { status: "maybe" })).toBeNull();
    expect(correctionValue("published_nutrition", "protein_g", { amount: "21", per: "serving" })).toEqual({ nutrient: "protein_g", amount: "21", per: "serving" });
    expect(correctionValue("published_nutrition", "protein_g", { amount: "-1", per: "serving" })).toBeNull();
    expect(correctionValue("serving_size", null, { grams: "0" })).toBeNull();
    expect(correctionValue("menu_item", null, { listed: "false" })).toEqual({ listed: false });
    expect(correctionValue("address", null, {})).toBeNull();
  });
});

describe("plain words", () => {
  it("shows drafted values as drafted, and unknown as not stated", () => {
    expect(factWords(fact({ kind: "price", value: { usd: "13.95" } }))).toBe("$13.95");
    expect(factWords(fact({ kind: "dietary_status", subject: "vegan", value: null, unknown: true, unknownReason: "The menu does not say" }))).toBe("Not stated (The menu does not say)");
    expect(factWords(fact({ kind: "published_nutrition", subject: "protein_g", value: { nutrient: "protein_g", amount: "21", per: "serving" } }))).toBe(
      "Protein 21 g per serving (published)",
    );
    expect(factLabel({ kind: "dietary_status", subject: "vegetarian" })).toBe("Vegetarian");
    expect(factLabel({ kind: "published_nutrition", subject: "protein_g" })).toBe("Protein (published)");
  });
});

describe("the six publication states (D1)", () => {
  const none = { extracted: true, autoCompared: "not_checked" as const, independentlyReviewed: false, founderConfirmed: false, rightsEligible: false, published: false };
  it("counts each state on its own and never adds them together", () => {
    const facts = [
      { ladder: none },
      { ladder: { ...none, autoCompared: "found" as const } },
      { ladder: { ...none, autoCompared: "not_found" as const, founderConfirmed: true } },
      { ladder: { ...none, founderConfirmed: true, rightsEligible: true, independentlyReviewed: true, published: true } },
      {},
    ];
    expect(ladderCounts(facts)).toEqual({ extracted: 5, autoCompared: 1, independentlyReviewed: 1, founderConfirmed: 2, rightsEligible: 1, published: 1 });
  });
  it("a fact without ladder data has reached only 'extracted', and 'not found' is not compared", () => {
    expect(LADDER_STEPS.map((s) => ladderReached({}, s.key))).toEqual([true, false, false, false, false, false]);
    expect(ladderReached({ ladder: { ...none, autoCompared: "not_found" } }, "autoCompared")).toBe(false);
  });
});
