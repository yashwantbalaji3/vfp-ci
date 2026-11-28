import { describe, expect, it } from "vitest";
import { readExpand, spreadByPlace, withExpanded } from "@/contracts/meal-variety";

const row = (id: string, slug: string, g: number | null = null) => ({ id, g, place: { slug, name: slug.toUpperCase() } });
// Already sorted best first: four from "grill", then one each from two others, then two more from "grill".
const rows = [row("a1", "grill", 50), row("a2", "grill", 48), row("a3", "grill", 45), row("a4", "grill", 44), row("b1", "naya", 40), row("c1", "thai", 30), row("a5", "grill", 20), row("a6", "grill", 18)];

describe("restaurant variety (docs/64)", () => {
  it("shows each restaurant's strongest two first, keeping the list's own order", () => {
    const s = spreadByPlace(rows, { protein: (r) => r.g });
    expect(s.shown.map((r) => r.id)).toEqual(["a1", "a2", "b1", "c1"]);
    expect(s.held).toEqual([{ key: "grill", name: "GRILL", slug: "grill", count: 4, best: 45 }]);
    expect(s.total).toBe(8);
    expect(s.spread).toBe(true);
  });
  it("never drops a meal: shown plus held is the whole list", () => {
    const s = spreadByPlace(rows);
    expect(s.shown.length + s.held.reduce((n, h) => n + h.count, 0)).toBe(rows.length);
  });
  it("one tap expands one restaurant in place; 'all' turns the rule off", () => {
    expect(spreadByPlace(rows, { expand: new Set(["grill"]) }).shown.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(spreadByPlace(rows, { expand: "all" }).shown).toEqual(rows);
  });
  it("one per restaurant for a short row of cards", () => {
    expect(spreadByPlace(rows, { perPlace: 1 }).shown.map((r) => r.id)).toEqual(["a1", "b1", "c1"]);
  });
  it("a single restaurant's list is never held back", () => {
    const one = rows.filter((r) => r.place.slug === "grill");
    expect(spreadByPlace(one).shown).toEqual(one);
    expect(spreadByPlace(one).held).toEqual([]);
  });
  it("reads only plain restaurant slugs from the address", () => {
    expect(readExpand("all")).toBe("all");
    expect([...(readExpand("grill,naya,<script>") as Set<string>)]).toEqual(["grill", "naya"]);
    expect(withExpanded(new Set(["grill"]), "naya")).toBe("grill,naya");
    expect(withExpanded("all", "naya")).toBe("all");
  });
});
