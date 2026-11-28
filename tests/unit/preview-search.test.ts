import { describe, expect, it } from "vitest";
import { fold, searchPreview, words } from "@/contracts/preview-search";
import type { PreviewMeal } from "@/contracts/menu-preview";
import type { Builder } from "@/contracts/meal-builder";
import type { DietEvidence } from "@/contracts/meal-eligibility";

// One search across real restaurants and drafted meals (docs/61). Invented places and meals only.

const evidence = (diet: PreviewMeal["diet"], ingredients: string[] | null = null): DietEvidence => ({
  veganClaim: diet === "vegan_stated" ? "yes" : null,
  vegetarianClaim: diet === "vegetarian_stated" ? "yes" : null,
  ingredients,
  allergens: null,
  found: ingredients?.includes("egg") ? [{ family: "egg", word: "egg", from: "ingredients" }] : [],
  unclear: [],
  namesMeat: false,
});
const meal = (label: string, diet: PreviewMeal["diet"], low: number | null, extra: Partial<PreviewMeal> = {}) =>
  ({ dishId: crypto.randomUUID(), label, section: "Mains", diet, excluded: null, evidence: evidence(diet), protein: { low, high: low, sortValue: low, basis: low === null ? "unknown" : "published" }, ...extra }) as unknown as PreviewMeal;
const ANY = { diet: "none" as const, exclusions: [] };
const VEGAN = { diet: "vegan" as const, exclusions: [] };
const place = (name: string, cuisine: string, meals: PreviewMeal[]) => ({ slug: fold(name).replace(/ /g, "-"), name, street: "1 Test St", area: "Back Bay", cuisines: [{ cuisine, basis: "dataset_primary" }], meals });

const thai = place("Lotus Test Kitchen", "Thai", [meal("Tofu Pad Thai", "vegan_stated", 18), meal("Vegetable Curry", "unknown", 9), meal("Paneer Bowl", "vegetarian_stated", 24)]);
const grill = place("Ember Test Grill", "American", [
  meal("Crème Brûlée Tofu Plate", "vegan_stated", 30),
  meal("Chicken Plate", "unknown", 40, { excluded: "Its name names meat" }),
  meal("Vegetable Fried Rice", "vegetarian_stated", 12, { evidence: evidence("vegetarian_stated", ["rice", "vegetables", "egg"]) }),
]);

describe("search across real menus", () => {
  it("ignores case and accents, and needs every word", () => {
    expect(words("  Crème   BRÛLÉE! ")).toEqual(["creme", "brulee"]);
    expect(searchPreview([thai, grill], "creme brulee", ANY, "mine").meals.map((m) => m.label)).toEqual(["Crème Brûlée Tofu Plate"]);
    expect(searchPreview([thai, grill], "tofu thai", ANY, "mine").meals.map((m) => m.label)).toEqual(["Tofu Pad Thai"]);
  });

  it("matches a meal by its restaurant's name or cuisine, and lists that restaurant", () => {
    const hit = searchPreview([thai, grill], "thai", ANY, "mine");
    expect(hit.places.map((p) => p.name)).toEqual(["Lotus Test Kitchen"]);
    expect(hit.meals.map((m) => m.label)).toEqual(["Paneer Bowl", "Tofu Pad Thai", "Vegetable Curry"]);
  });

  it("applies the saved diet by default: a vegan never sees the egg fried rice unless they open All meals", () => {
    const hit = searchPreview([thai, grill], "vegetable fried rice", VEGAN, "mine");
    expect(hit.meals).toEqual([]);
    expect(hit.counts).toEqual({ mine: 0, check: 0, all: 1 });
    const all = searchPreview([thai, grill], "vegetable fried rice", VEGAN, "all");
    expect(all.meals.map((m) => [m.label, m.fit.status])).toEqual([["Vegetable Fried Rice", "ineligible"]]);
  });

  it("keeps meals that need confirmation in their own view, and never counts unknown as vegan", () => {
    const hit = searchPreview([thai, grill], "lotus", VEGAN, "mine");
    expect(hit.counts).toEqual({ mine: 1, check: 2, all: 3 });
    expect(hit.meals.map((m) => m.label)).toEqual(["Tofu Pad Thai"]);
    expect(searchPreview([thai, grill], "lotus", VEGAN, "check").meals.map((m) => m.label)).toEqual(["Paneer Bowl", "Vegetable Curry"]);
  });

  it("never returns a meal left out of discovery, and returns nothing for an empty search", () => {
    expect(searchPreview([thai, grill], "chicken", ANY, "all").meals).toEqual([]);
    expect(searchPreview([thai, grill], "   ", ANY, "mine")).toMatchObject({ meals: [], places: [], builders: [] });
  });

  it("finds a build-your-own meal by one of its parts, except in the Needs confirmation view", () => {
    const b = { dishId: crypto.randomUUID(), label: "Build your own bowl", parts: [{ label: "Falafel" }, { label: "Rice" }] } as unknown as Builder;
    const hit = searchPreview([thai, grill], "falafel", VEGAN, "mine", [{ builder: b, place: thai }]);
    expect(hit.builders).toMatchObject([{ parts: ["Falafel"] }]);
    expect(searchPreview([thai, grill], "falafel", VEGAN, "check", [{ builder: b, place: thai }]).builders).toEqual([]);
  });
});
