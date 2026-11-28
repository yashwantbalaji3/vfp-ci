import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromGoogleFoodMenus, fromSchemaOrgMenu, fromSquareCatalog, menuChanges, type DraftPlace } from "@/contracts/menu-adapters";

// Menu adapters on test fixtures only (owner directive 25 Nov 2026 04:01 UTC, section 3.1; docs/91).
const dir = join(__dirname, "..", "fixtures", "menu-adapters");
const json = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const at = "2026-11-25T05:00:00.000Z";
const of = (p: DraftPlace, label: string) => {
  const key = p.dishes.find((d) => d.label === label)!.key;
  return p.facts.filter((f) => f.dish === key);
};
const diets = (p: DraftPlace, label: string) => of(p, label).filter((f) => f.kind === "dietary_status").map((f) => f.subject).sort();
const protein = (p: DraftPlace, label: string) => of(p, label).find((f) => f.kind === "published_nutrition")!;

describe("menu adapters", () => {
  it("Google food menus: owner flags become diet facts; no flag stays unknown; ranges and prices keep their form", () => {
    const p = fromGoogleFoodMenus(json("gbp-food-menus.json"), { placeLabel: "Example", locationName: "accounts/1/locations/2", retrievedAt: at });
    expect(p.dishes.map((d) => d.label)).toEqual(["Tofu Power Bowl", "Chicken Bowl", "Veggie Burger"]);
    expect(diets(p, "Tofu Power Bowl")).toEqual(["vegan", "vegetarian"]);
    // "Veggie Burger" has no flag: nothing is inferred from the name.
    expect(diets(p, "Veggie Burger")).toEqual([]);
    expect(of(p, "Tofu Power Bowl").find((f) => f.kind === "price")!.value).toEqual({ usd: "14.50" });
    expect(protein(p, "Tofu Power Bowl").value).toMatchObject({ nutrient: "protein_g", basis: "published_range", low: 28, high: 32 });
    expect(protein(p, "Veggie Burger").value).toMatchObject({ nutrient: "protein_g", amount: 21 });
    expect(protein(p, "Chicken Bowl").unknownReason).toMatch(/no protein/);
    expect(protein(p, "Chicken Bowl").value).toBeUndefined();
    expect(of(p, "Chicken Bowl").find((f) => f.kind === "allergen_statement")!.value).toEqual({ statement: "contains", allergens: ["dairy"] });
    expect(JSON.stringify(p)).not.toMatch(/long description/);
    expect(p.sources[0].kind).toBe("owner_authorized_api");
  });

  it("Square catalog: only standard diet flags count; sized prices stay unknown; deleted items are skipped", () => {
    const p = fromSquareCatalog(json("square-catalog.json"), { placeLabel: "Example", merchantId: "M1", retrievedAt: at });
    expect(p.dishes.map((d) => d.label)).toEqual(["Falafel Wrap", "Lentil Soup"]);
    expect(diets(p, "Falafel Wrap")).toEqual(["vegan"]);
    expect(of(p, "Falafel Wrap").find((f) => f.kind === "price")!.value).toEqual({ usd: "12.00" });
    expect(of(p, "Lentil Soup").find((f) => f.kind === "price")!.unknownReason).toMatch(/size/);
    expect(protein(p, "Lentil Soup").unknownReason).toBeTruthy();
    expect(JSON.stringify(p)).not.toMatch(/Never copied/);
  });

  it("schema.org menu data: suitableForDiet only; a 'Vegan' name with no flag is not a claim; broken blocks are skipped", () => {
    const p = fromSchemaOrgMenu(readFileSync(join(dir, "schema-org-menu.html"), "utf8"), { placeLabel: "Example", url: "https://example.test/menu", retrievedAt: at });
    expect(p.dishes.map((d) => [d.label, d.section])).toEqual([["Chana Masala", "Mains"], ["Paneer Tikka", "Mains"], ["Vegan Chicken Sandwich", "Mains"]]);
    expect(diets(p, "Chana Masala")).toEqual(["vegan"]);
    expect(diets(p, "Paneer Tikka")).toEqual(["vegetarian"]);
    expect(diets(p, "Vegan Chicken Sandwich")).toEqual([]);
    expect(protein(p, "Chana Masala").value).toMatchObject({ amount: 18 });
    expect(of(p, "Paneer Tikka").find((f) => f.kind === "price")!.value).toEqual({ usd: "15.00" });
    expect(JSON.stringify(p)).not.toMatch(/never copied/);
  });

  it("change detection names added, removed and changed dishes, with which facts changed", () => {
    const before = fromSquareCatalog(json("square-catalog.json"), { placeLabel: "Example", merchantId: "M1", retrievedAt: at });
    const next = json("square-catalog.json");
    next.objects[0].item_data.food_and_beverage_details.dietary_preferences = [];
    next.objects[1].is_deleted = true;
    next.objects.push({ type: "ITEM", id: "E", item_data: { name: "Mushroom Bowl", variations: [] } });
    const after = fromSquareCatalog(next, { placeLabel: "Example", merchantId: "M1", retrievedAt: at });
    expect(menuChanges(before, after)).toEqual({ added: ["Mushroom Bowl"], removed: ["Lentil Soup"], changed: [{ dish: "Falafel Wrap", kinds: ["dietary_status|vegan"] }] });
  });
});
