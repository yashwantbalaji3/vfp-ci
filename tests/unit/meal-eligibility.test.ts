import { describe, expect, it } from "vitest";
import { applyLens, combinationFit, dishEvidence, evidenceWords, fitGroup, mealFit, mealLens, allergenNote, type DietEvidence } from "@/contracts/meal-eligibility";
import type { MenuDish } from "@/contracts/menu-review";

// The one diet check for every real-menu screen (docs/63). Invented dishes only.

type Spec = { vegan?: "yes" | "no"; vegetarian?: "yes" | "no"; ingredients?: string[]; allergens?: string[]; meat?: boolean; unknownVegan?: string };
const ev = (s: Spec): DietEvidence => {
  const facts: Record<string, unknown>[] = [];
  if (s.vegan) facts.push({ kind: "dietary_status", subject: "vegan", unknown: false, value: { claim: "vegan", status: s.vegan } });
  if (s.unknownVegan) facts.push({ kind: "dietary_status", subject: "vegan", unknown: true, unknownReason: s.unknownVegan, value: null });
  if (s.vegetarian) facts.push({ kind: "dietary_status", subject: "vegetarian", unknown: false, value: { claim: "vegetarian", status: s.vegetarian } });
  if (s.ingredients) facts.push({ kind: "listed_ingredients", subject: null, unknown: false, value: { items: s.ingredients } });
  if (s.allergens) facts.push({ kind: "allergen_statement", subject: null, unknown: false, value: { statement: "contains", allergens: s.allergens } });
  return dishEvidence({ facts } as unknown as MenuDish, s.meat ?? false);
};
const VEGAN = { diet: "vegan" as const, exclusions: [] };
const VEG = { diet: "vegetarian" as const, exclusions: [] };
const EGG_FREE = { diet: "vegetarian" as const, exclusions: ["egg"] };
const NONE = { diet: "none" as const, exclusions: [] };

describe("the shared diet check", () => {
  it("never shows a vegan an egg dish the restaurant calls vegetarian (the fried rice case)", () => {
    const friedRice = ev({ vegetarian: "yes", vegan: "no", ingredients: ["rice", "vegetables", "egg"] });
    const f = mealFit(friedRice, VEGAN);
    expect(f.status).toBe("ineligible");
    expect(f.reasons.join(" ")).toMatch(/isn't vegan/);
    expect(f.reasons.join(" ")).toMatch(/lists “egg”/);
    expect(fitGroup(f)).toBe("hidden");
  });

  it("rules out an egg dish for an egg-free vegetarian even though it is stated vegetarian", () => {
    const padThai = ev({ vegetarian: "yes", ingredients: ["rice noodles", "vegetables", "egg", "tofu", "peanuts"] });
    expect(mealFit(padThai, VEG).status).toBe("eligible");
    const f = mealFit(padThai, EGG_FREE);
    expect(f.status).toBe("ineligible");
    expect(f.short).toBe("Doesn't fit: lists egg");
  });

  it("keeps a listed tea egg out of vegan and egg-free results, and leaves the stated vegetarian label as stated (Gene's Xi'an Cold Noodles, 26 Nov review)", () => {
    // The ingredient list exactly as recorded from the saved page; the vegan fact is recorded as unknown.
    const coldNoodles = ev({
      vegetarian: "yes",
      unknownVegan: "The menu does not say",
      ingredients: ["hand-rolled thin noodles", "cucumbers", "bean sprouts", "carrots", "cilantro", "one tea egg", "chilly oil", "vinegar", "garlic sauce"],
    });
    expect(coldNoodles.found).toEqual([{ family: "egg", word: "one tea egg", from: "ingredients" }]);
    for (const choice of [VEGAN, EGG_FREE]) {
      const f = mealFit(coldNoodles, choice);
      expect(f.status).toBe("ineligible");
      expect(fitGroup(f)).toBe("hidden");
      expect(f.reasons.join(" ")).toMatch(/lists “one tea egg”/);
    }
    // Vegetarian: the restaurant's own label, never upgraded or downgraded by us.
    expect(mealFit(coldNoodles, VEG).status).toBe("eligible");
    expect(evidenceWords(coldNoodles).stated).toMatch(/vegetarian/i);
  });

  it("lets the ingredient win over a vegan label that contradicts it", () => {
    const f = mealFit(ev({ vegan: "yes", ingredients: ["chickpeas", "paneer"] }), VEGAN);
    expect(f.status).toBe("ineligible");
    expect(f.reasons.join(" ")).toMatch(/contradicts the restaurant's vegan label/);
  });

  it("uses the restaurant's allergen list as evidence of dairy or egg", () => {
    const dosa = ev({ vegetarian: "yes", allergens: ["dairy"] });
    expect(mealFit(dosa, VEGAN).status).toBe("ineligible");
    expect(mealFit(dosa, VEGAN).short).toBe("Doesn't fit: contains dairy");
    expect(mealFit(dosa, { diet: "vegetarian", exclusions: ["dairy"] }).status).toBe("ineligible");
    // An allergen list that names no egg rules egg out for an egg-free vegetarian.
    expect(mealFit(dosa, EGG_FREE).status).toBe("eligible");
  });

  it("never reads 'Thai eggplant' as egg, or coconut milk and peanut butter as dairy", () => {
    const e = ev({ vegetarian: "yes", ingredients: ["Thai eggplant", "coconut milk", "peanut butter", "basil"] });
    expect(e.found).toEqual([]);
    expect(mealFit(e, { diet: "vegetarian", exclusions: ["egg", "dairy"] }).status).toBe("needs_confirmation"); // no allergen list: not ruled out
  });

  it("holds back an unknown diet and missing evidence, and never makes them eligible", () => {
    const unknown = ev({ ingredients: ["lentils", "spices"] });
    expect(mealFit(unknown, VEG).status).toBe("needs_confirmation");
    expect(mealFit(unknown, VEGAN).status).toBe("needs_confirmation");
    expect(mealFit(ev({}), VEGAN).status).toBe("needs_confirmation");
    // Stated vegetarian, no vegan word: a vegan must confirm.
    expect(mealFit(ev({ vegetarian: "yes" }), VEGAN).reasons[0]).toMatch(/vegetarian but doesn't say it's vegan/);
  });

  it("holds back an ambiguous word for a family the person avoids", () => {
    const korma = ev({ vegetarian: "yes", ingredients: ["mixed vegetables", "creamy sauce"] });
    expect(mealFit(korma, VEG).status).toBe("eligible");
    const f = mealFit(korma, { diet: "vegetarian", exclusions: ["dairy"] });
    expect(f.status).toBe("needs_confirmation");
    expect(f.reasons.join(" ")).toMatch(/“creamy sauce” may contain dairy/);
  });

  it("holds back labels that contradict each other", () => {
    const f = mealFit(ev({ vegan: "yes", vegetarian: "no" }), VEGAN);
    expect(f.status).toBe("needs_confirmation");
    expect(f.reasons[0]).toMatch(/contradict each other/);
    expect(mealFit(ev({ vegan: "yes" }), VEGAN).status).toBe("eligible");
  });

  it("rules out a meal that names meat for any diet, and applies exclusions with no diet", () => {
    expect(mealFit(ev({ meat: true }), VEG).status).toBe("ineligible");
    expect(mealFit(ev({ ingredients: ["egg", "rice"] }), { diet: "none", exclusions: ["egg"] }).status).toBe("ineligible");
    expect(mealFit(ev({ ingredients: ["rice"] }), { diet: "none", exclusions: ["egg"] }).status).toBe("needs_confirmation");
  });

  it("with no diet chosen, every meal is eligible and nothing is said", () => {
    expect(mealFit(ev({ ingredients: ["egg"] }), NONE)).toEqual({ status: "eligible", reasons: [], short: "" });
  });

  it("keeps what the restaurant states apart from our reading, and never promises allergy safety", () => {
    const w = evidenceWords(ev({ vegetarian: "yes", ingredients: ["rice", "egg"] }));
    expect(w.stated).toMatch(/restaurant's own label \(vegetarian: yes\)/);
    expect(w.ourReading).toMatch(/“egg” is egg/);
    expect(allergenNote(ev({ allergens: ["soy"] }))).toMatch(/not an allergy guarantee/);
    expect(allergenNote(ev({}))).toMatch(/gives no allergen list.*Cross-contact isn't stated/);
  });
});

describe("the diet in force on a list", () => {
  it("a saved diet can't be widened by the address; only fit=all or fit=check change the view", () => {
    expect(mealLens(VEGAN, "any", undefined)).toEqual({ choice: VEGAN, saved: true, view: "mine" });
    expect(mealLens(VEGAN, "vegetarian", "all").view).toBe("all");
    expect(mealLens(VEGAN, undefined, "nonsense").view).toBe("mine");
  });
  it("with no saved diet, the address can set a temporary one", () => {
    expect(mealLens(NONE, "vegan", "check")).toMatchObject({ choice: { diet: "vegan" }, saved: false, view: "check" });
    expect(mealLens(NONE, undefined, "check").view).toBe("mine");
  });
  it("counts every view and keeps only the one in force, never a meal left out of discovery", () => {
    const meals = [
      { id: "a", excluded: null, evidence: ev({ vegan: "yes" }) },
      { id: "b", excluded: null, evidence: ev({ vegetarian: "yes" }) },
      { id: "c", excluded: null, evidence: ev({ vegetarian: "yes", ingredients: ["egg"] }) },
      { id: "d", excluded: "names meat", evidence: ev({ meat: true }) },
    ];
    const r = applyLens(meals, { choice: VEGAN, view: "mine" });
    expect(r.counts).toEqual({ mine: 1, check: 1, all: 3 });
    expect(r.shown.map((m) => m.id)).toEqual(["a"]);
    expect(applyLens(meals, { choice: VEGAN, view: "check" }).shown.map((m) => m.id)).toEqual(["b"]);
    expect(applyLens(meals, { choice: VEGAN, view: "all" }).shown.map((m) => [m.id, m.fit.status])).toEqual([["a", "eligible"], ["b", "needs_confirmation"], ["c", "ineligible"]]);
  });
});

describe("a place-level hint from the open map (docs/64)", () => {
  it("never makes a dish fit: a vegan restaurant's dish with no vegan word of its own still needs confirmation", () => {
    const place = { dietHints: [{ hint: "vegan" as const, basis: "dataset_primary" as const }] };
    const meals = [{ id: "x", excluded: null, place, evidence: ev({}) }];
    const r = applyLens(meals, { choice: VEGAN, view: "mine" });
    expect(r.shown).toEqual([]);
    expect(r.counts).toEqual({ mine: 0, check: 1, all: 1 });
    expect(mealFit(meals[0].evidence, VEG).status).toBe("needs_confirmation");
  });
});

describe("build-your-own combinations", () => {
  it("fit only when every chosen part fits, and name the part that doesn't", () => {
    const pita = { label: "White Pita", evidence: ev({ vegan: "yes" }) };
    const feta = { label: "Feta Cheese", evidence: ev({ vegetarian: "yes", allergens: ["dairy"] }) };
    const sauce = { label: "Garlic Sauce", evidence: ev({}) };
    expect(combinationFit([pita], VEGAN).status).toBe("eligible");
    const no = combinationFit([pita, feta], VEGAN);
    expect(no.status).toBe("ineligible");
    expect(no.short).toBe("Doesn't fit: Feta Cheese");
    expect(combinationFit([pita, sauce], VEGAN).status).toBe("needs_confirmation");
    expect(combinationFit([], VEGAN).short).toBe("");
  });
});
