import { describe, expect, it } from "vitest";
import { mealIdeas, proteinToGo, recipeIdeas, savedWithoutFigure } from "@/contracts/protein-to-go";
import type { PreviewMeal, PreviewDiet } from "@/contracts/menu-preview";
import type { DietEvidence } from "@/contracts/meal-eligibility";

const evidence = (diet: PreviewDiet): DietEvidence => ({
  veganClaim: diet === "vegan_stated" ? "yes" : null,
  vegetarianClaim: diet === "vegetarian_stated" ? "yes" : diet === "not_vegetarian" ? "no" : null,
  ingredients: null,
  allergens: null,
  found: [],
  unclear: [],
  namesMeat: false,
});

const m = (id: string, place: string, low: number | null, diet: PreviewDiet = "vegan_stated", excluded: string | null = null): { meal: PreviewMeal; placeName: string } => ({
  meal: { dishId: id, placeId: place, label: id, section: null, diet, excluded, evidence: evidence(diet), protein: { basis: low === null ? "unknown" : "published", low, high: low, sortValue: low, words: "", portion: "per serving", usda: null, unknownReason: null }, kcal: null, priceUsd: null, sourceUrl: null, checkedOn: null } as PreviewMeal,
  placeName: place,
});

describe("protein to go today", () => {
  it("is the goal when nothing is logged, and the rest when the known total is below it", () => {
    expect(proteinToGo({ state: "nothing_logged", target: 90 })).toEqual({ grams: 90, atMost: false });
    expect(proteinToGo({ state: "in_progress", target: 90, value: 17.9, atLeast: false, estimated: false })).toEqual({ grams: 72.1, atMost: false });
  });
  it("is an upper bound when some items have no protein value", () => {
    expect(proteinToGo({ state: "in_progress", target: 90, value: 30, atLeast: true, estimated: false })).toEqual({ grams: 60, atMost: true });
  });
  it("says nothing with estimates, a met or maybe-met goal, unknown values or no goal", () => {
    expect(proteinToGo({ state: "in_progress", target: 90, value: 30, atLeast: false, estimated: true })).toBeNull();
    expect(proteinToGo({ state: "met", target: 90, value: 95, estimated: false, low: 95 })).toBeNull();
    expect(proteinToGo({ state: "maybe", target: 90, value: 92, low: 80 })).toBeNull();
    expect(proteinToGo({ state: "unknown", target: 90 })).toBeNull();
    expect(proteinToGo({ state: "no_goal" })).toBeNull();
  });
});

describe("meal ideas", () => {
  const meals = [m("a1", "A", 44), m("a2", "A", 40), m("b1", "B", 30), m("c1", "C", 12, "unknown"), m("d1", "D", null), m("e1", "E", 50, "vegan_stated", "names meat")];
  it("puts saved meals first, then one per restaurant nearest a meal's worth, never unknown protein or excluded meals", () => {
    const ideas = mealIdeas({ grams: 72, atMost: false }, meals, new Set(["b1"]), { diet: "none", exclusions: [] });
    expect(ideas.map((i) => i.meal.dishId)).toEqual(["b1", "a1", "c1"]);
    expect(ideas[0].saved).toBe(true);
  });
  it("keeps to the person's diet by the shared check: only meals that fit, never ones that need confirmation", () => {
    expect(mealIdeas({ grams: 72, atMost: false }, meals, new Set(), { diet: "vegan", exclusions: [] }).map((i) => i.meal.dishId)).toEqual(["a1", "b1"]);
  });
  it("never suggests a meal that lists something the person leaves out", () => {
    const eggy = m("f1", "F", 40, "vegetarian_stated");
    eggy.meal.evidence = { ...eggy.meal.evidence, ingredients: ["rice", "egg"], found: [{ family: "egg", word: "egg", from: "ingredients" }] };
    const ideas = mealIdeas({ grams: 72, atMost: false }, [eggy, m("g1", "G", 30, "vegetarian_stated")], new Set(["f1"]), { diet: "vegetarian", exclusions: ["egg"] });
    expect(ideas.map((i) => i.meal.dishId)).toEqual([]);
    expect(mealIdeas({ grams: 72, atMost: false }, [eggy], new Set(), { diet: "vegetarian", exclusions: [] }).map((i) => i.meal.dishId)).toEqual(["f1"]);
  });
  it("shows one idea per dish name, so two branches of a chain don't repeat the same meal", () => {
    const one = m("x1", "P", 40), two = m("x2", "Q", 40);
    one.meal.label = "Falafel hummus bowl";
    two.meal.label = "falafel hummus bowl ";
    expect(mealIdeas({ grams: 72, atMost: false }, [one, two], new Set(), { diet: "none", exclusions: [] }).map((i) => i.meal.dishId)).toEqual(["x1"]);
  });
  it("aims at what is left when that is less than a meal", () => {
    expect(mealIdeas({ grams: 12, atMost: false }, meals, new Set(), { diet: "none", exclusions: [] }, 1)[0].meal.dishId).toBe("c1");
  });
});

describe("saved meals without a printed protein figure (journey K)", () => {
  const meals = [m("d1", "D", null), m("d2", "D", null, "not_vegetarian"), m("d3", "D", null, "vegan_stated", "names meat"), m("b1", "B", 30), m("z1", "Z", null)];
  it("lists only saved meals with no figure that fit the diet, excluded and already shown ones left out", () => {
    const out = savedWithoutFigure(meals, new Set(["d1", "d2", "d3", "b1"]), { diet: "vegetarian", exclusions: [] }, new Set());
    expect(out.map((x) => x.meal.dishId)).toEqual(["d1"]);
    expect(savedWithoutFigure(meals, new Set(["d1"]), { diet: "none", exclusions: [] }, new Set(["d1"]))).toEqual([]);
  });
});

describe("recipe ideas", () => {
  it("leaves out unknown protein and picks those nearest what is left", () => {
    const r = recipeIdeas({ grams: 25, atMost: false }, [
      { foodItemId: "1", name: "Lentil soup", proteinG: 18 },
      { foodItemId: "2", name: "Tofu bowl", proteinG: 27 },
      { foodItemId: "3", name: "Mystery", proteinG: null },
      { foodItemId: "4", name: "Seitan", proteinG: 45 },
    ]);
    expect(r.map((x) => x.name)).toEqual(["Tofu bowl", "Lentil soup"]);
  });
});

describe("ideaAim (docs/68, L1)", () => {
  it("aims at one meal's worth with no goal, at what's left with one, and at nothing once reached or unsure", async () => {
    const { ideaAim, ideaBasisWords, ONE_MEAL_G } = await import("@/contracts/protein-to-go");
    expect(ideaAim({ state: "no_goal" })).toEqual({ kind: "open", toGo: { grams: ONE_MEAL_G, atMost: false } });
    expect(ideaAim({ state: "nothing_logged", target: 90 })).toEqual({ kind: "to_go", toGo: { grams: 90, atMost: false } });
    expect(ideaAim({ state: "in_progress", target: 90, value: 30, atLeast: true, estimated: false })).toEqual({ kind: "to_go", toGo: { grams: 60, atMost: true } });
    expect(ideaAim({ state: "met", target: 90, value: 95, estimated: false, low: 95 })).toBeNull();
    expect(ideaAim({ state: "in_progress", target: 90, value: 30, atLeast: false, estimated: true })).toBeNull();
    expect(ideaBasisWords("usda_range")).toBe("USDA estimate");
    expect(ideaBasisWords("published")).toBe("printed by the restaurant");
  });
});
