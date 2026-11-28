import { describe, expect, it } from "vitest";
import { itemsToDrafts } from "../../scripts/lib/menu-drafts.mjs";

const item = (over: Record<string, unknown>) => ({ name: "Test Bowl", section: null, description: null, labels: [], allergens: null, price_usd: null, nutrition: {}, published_ranges: {}, variants: [], ...over });
const base = { source: "menu", checkedOn: "2026-11-18" };
type F = { dish: string; kind: string; subject?: string; value?: Record<string, unknown>; unknownReason?: string; confidence: string };

describe("reader items to private drafts", () => {
  it("drafts only what the page states and keeps everything else unknown", () => {
    const { dishes, facts } = itemsToDrafts({ ...base, items: [item({ name: "Chicken Bowl", price_usd: 13.5 })] });
    expect(dishes).toEqual([{ key: "chicken-bowl", label: "Chicken Bowl" }]);
    const f = facts as F[];
    expect(f.find((x) => x.kind === "price")?.value).toEqual({ usd: "13.50" });
    expect(f.filter((x) => x.kind === "dietary_status").map((x) => [x.subject, x.value ?? x.unknownReason])).toEqual([
      ["vegan", "The menu does not label it"], ["vegetarian", "The menu does not label it"],
    ]);
    expect(f.find((x) => x.subject === "protein_g")).toMatchObject({ unknownReason: "The menu does not print protein" });
    expect(f.every((x) => x.value?.amount !== "0")).toBe(true);
  });

  it("never reads a diet from a dish name or section", () => {
    const f = itemsToDrafts({ ...base, items: [item({ name: "Vegan Tofu Bowl", section: "Vegetarian corner" })] }).facts as F[];
    expect(f.filter((x) => x.kind === "dietary_status" && x.value)).toHaveLength(0);
  });

  it("uses the dish's own labels, and a menu-wide statement only at medium confidence", () => {
    const own = itemsToDrafts({ ...base, items: [item({ labels: ["dairy", "wheat", "vegetarian"] })] }).facts as F[];
    expect(own.find((x) => x.subject === "vegetarian")).toMatchObject({ value: { claim: "vegetarian", status: "yes" }, confidence: "high" });
    expect(own.find((x) => x.subject === "vegan")?.unknownReason).toBeTruthy();
    expect(own.find((x) => x.kind === "allergen_statement")?.value).toEqual({ statement: "contains", allergens: ["dairy", "wheat"] });
    const wide = itemsToDrafts({ ...base, menuWideDiet: "vegan", items: [item({})] }).facts as F[];
    expect(wide.filter((x) => x.kind === "dietary_status").map((x) => [x.subject, x.confidence])).toEqual([["vegan", "medium"], ["vegetarian", "medium"]]);
  });

  it("keeps a printed protein value, and a printed range as unknown with the range in the reason", () => {
    const f = itemsToDrafts({ ...base, items: [
      item({ name: "A", nutrition: { protein_g: { amount: 32, unit: "g", per: "serving" } } }),
      item({ name: "B", published_ranges: { protein_g: { low: 26, high: 44 } } }),
    ] }).facts as F[];
    expect(f.find((x) => x.dish === "a" && x.subject === "protein_g")?.value).toEqual({ nutrient: "protein_g", amount: "32", per: "serving" });
    expect(f.find((x) => x.dish === "b" && x.subject === "protein_g")?.unknownReason).toBe("The menu prints a range (26-44 g), not one value");
  });

  it("drafts a repeated name once and reports the repeat", () => {
    const r = itemsToDrafts({ ...base, items: [item({ name: "Fries", price_usd: 5 }), item({ name: "Fries", price_usd: 6 })] });
    expect(r.dishes).toHaveLength(1);
    expect(r.repeats).toEqual(["Fries"]);
    expect((r.facts as F[]).filter((x) => x.kind === "price")).toHaveLength(1);
  });
});
