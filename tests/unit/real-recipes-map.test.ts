import { describe, expect, it } from "vitest";
import map from "../../scripts/real-recipes-usda.json";

/** The USDA mapping behind the real-mode recipes (scripts/real-recipes.mjs, docs/62). */
describe("real recipes: one USDA food per ingredient, or an honest unknown", () => {
  const entries = Object.entries(map as Record<string, { name: string; fdcId: number | null; release: string | null; usda: string | null; note?: string }>);
  it("covers every demo ingredient the 12 recipes use", () => {
    expect(entries).toHaveLength(58);
  });
  it("names a sealed USDA release and food for every mapped ingredient, and says why for every unmapped one", () => {
    for (const [, e] of entries) {
      expect(e.name).not.toMatch(/^Demo /);
      if (e.fdcId === null) {
        expect(e.release).toBeNull();
        expect(e.note).toMatch(/unknown/);
      } else {
        expect(["2018-04", "2026-10-29"]).toContain(e.release);
        expect(e.usda).toBeTruthy();
      }
    }
    expect(entries.filter(([, e]) => e.fdcId === null).map(([, e]) => e.name).sort()).toEqual(["Garam masala", "Paneer"]);
  });
});
