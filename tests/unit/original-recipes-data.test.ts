import { describe, expect, it } from "vitest";
import data from "../../data/recipes/original-v2.json";
import { deriveDiet, fixedId, validate } from "../../scripts/lib/original-recipes.mjs";

/** Recipe library v2 (scripts/original-recipes.mjs): checks on the data alone, no database needed. */
type Line = { ingredient: string; quantity: number; unit: string; grams: number; default?: boolean; group?: string };
type Ing = { name: string; fdcId: number | null; release: string | null; reuse?: string; families?: Record<string, string> };
type Recipe = { slug: string; name: string; servings: number; cuisine: string; mealTypes: string[]; ingredients: Line[]; diet: { vegan: string; vegetarian: string } };
const ings = data.ingredients as unknown as Record<string, Ing>;
const recipes = data.recipes as unknown as Recipe[];

describe("original recipes v2: the data", () => {
  it("has no problems the validator knows about", () => {
    expect(validate(data)).toEqual([]);
  });

  it("is 38 recipes with unique names, servings and grams above zero", () => {
    expect(recipes).toHaveLength(38);
    expect(new Set(recipes.map((r) => r.name.toLowerCase())).size).toBe(38);
    for (const r of recipes) {
      expect(r.servings).toBeGreaterThan(0);
      for (const l of r.ingredients) expect(l.grams).toBeGreaterThan(0);
    }
  });

  it("does not reuse a name from the first 12 recipes", () => {
    const first12 = ["red lentil soup", "sesame tofu and broccoli stir-fry", "spinach and paneer curry", "yogurt bowl with walnuts and berries", "crispy spiced chickpeas", "masala tofu scramble", "baked eggs in pepper and tomato sauce", "chana masala", "chickpea and quinoa bowl with lemon tahini", "peanut butter overnight oats", "peanut noodle bowl with edamame", "red lentil dal with spinach"];
    for (const r of recipes) expect(first12).not.toContain(r.name.toLowerCase());
  });

  it("spreads across meals and cuisines", () => {
    for (const m of ["breakfast", "lunch", "dinner", "snack"]) expect(recipes.filter((r) => r.mealTypes.includes(m)).length).toBeGreaterThanOrEqual(5);
    for (const c of ["indian", "asian", "mediterranean", "middle_eastern", "mexican", "american"]) expect(recipes.filter((r) => r.cuisine === c).length).toBeGreaterThanOrEqual(4);
  });

  it("maps every new ingredient to one SR Legacy 2018-04 food, and leaves only paneer without one", () => {
    for (const i of Object.values(ings)) {
      if (!i.reuse) expect([i.release, Number.isInteger(i.fdcId)]).toEqual(["2018-04", true]);
    }
    expect(Object.values(ings).filter((i) => i.fdcId === null).map((i) => i.name)).toEqual(["Paneer"]);
  });

  it("never calls a recipe vegan when an ingredient it uses as written has egg, dairy or honey", () => {
    const animal = ["egg", "dairy", "honey", "gelatin", "animal_stock", "fish_sauce", "animal_rennet"];
    const vegan = recipes.filter((r) => r.diet.vegan === "compatible");
    expect(vegan.length).toBeGreaterThanOrEqual(19);
    for (const r of vegan) {
      for (const l of r.ingredients.filter((x) => x.default !== false)) {
        const fam = ings[l.ingredient].families ?? {};
        for (const f of animal) expect(fam[f], `${r.name}: ${l.ingredient}`).toBeUndefined();
        const name = ings[l.ingredient].name;
        const looksAnimal = /\b(eggs?|honey|milk|cheese|yogurt|butter|cream|ghee|paneer|feta|ricotta|cheddar)\b/i.test(name) && !/\b(soy|coconut|peanut)\b/i.test(name);
        expect(looksAnimal, `${r.name}: ${name}`).toBe(false);
      }
    }
  });

  it("derives each recipe's diet statement from its ingredients, and a swap never changes the statement as written", () => {
    for (const r of recipes) {
      const d = deriveDiet(r, ings);
      expect([d.vegan.outcome, d.vegetarian.outcome], r.name).toEqual([r.diet.vegan, r.diet.vegetarian]);
    }
    const eggs = recipes.find((r) => r.slug === "eggs-spiced-pinto-beans")!;
    expect(eggs.diet.vegan).toBe("incompatible");
  });

  it("gives every row a distinct fixed id under its own prefix", () => {
    const ids = [...Object.keys(ings).flatMap((k) => [fixedId("11", k), fixedId("12", k)]), ...recipes.flatMap((r) => [fixedId("21", r.slug), fixedId("22", r.slug)])];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^a0380000-0000-4000-8000-[0-9a-f]{12}$/);
  });
});
