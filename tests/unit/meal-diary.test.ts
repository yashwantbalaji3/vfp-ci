import { describe, expect, it } from "vitest";
import { mealDiaryPrefill, mealSourceWords } from "@/contracts/meal-diary";
import type { PreviewMeal, PreviewProtein } from "@/contracts/menu-preview";

const protein = (p: Partial<PreviewProtein>): PreviewProtein => ({ basis: "published", low: 44, high: 44, sortValue: 44, words: "44 g protein per serving, printed by the restaurant", portion: "per serving", usda: null, unknownReason: null, ...p });
const meal = (p: Partial<PreviewProtein>, kcal: number | null = 790): PreviewMeal =>
  ({ dishId: "d", placeId: "p", label: "Steak Asada Burrito", section: "Burritos", diet: "vegan_stated", excluded: null, protein: protein(p), kcal, priceUsd: "18.95", sourceUrl: "https://example.test/menu", checkedOn: "2026-11-18" }) as PreviewMeal;

describe("Log this meal: what the diary form starts with", () => {
  it("fills in a single printed figure for one serving, as the person's own restaurant entry", () => {
    const r = mealDiaryPrefill(meal({}), "Veggie Grill");
    expect(r.values).toEqual({ name: "Steak Asada Burrito (Veggie Grill)", proteinG: "44", energyKcal: "790", context: "restaurant" });
    expect(r.note).toContain("printed 44 g");
    expect(r.note).toContain("Unverified preview");
    expect(r.note).toContain("2026-11-18");
  });

  it("fills in the restaurant's own estimate and says it is one", () => {
    const r = mealDiaryPrefill(meal({ basis: "restaurant_estimate", low: 30, high: 30 }), "NAYA");
    expect(r.values.proteinG).toBe("30");
    expect(r.note).toContain("own estimate");
  });

  it("never turns a range, a USDA estimate or an unknown into a number", () => {
    for (const p of [
      { basis: "published_range" as const, low: 18, high: 24, words: "18 to 24 g protein per serving, a range printed by the restaurant" },
      { basis: "usda_range" as const, low: 18, high: 24, words: "18 to 24 g protein, a USDA estimate" },
      { basis: "unknown" as const, low: null, high: null, words: "Protein not known" },
    ]) {
      const r = mealDiaryPrefill(meal(p), "Thai Basil");
      expect(r.values.proteinG).toBe("");
      expect(r.note).toMatch(/empty/);
    }
  });

  it("never fills in a per-100 g figure as if it were one serving", () => {
    const r = mealDiaryPrefill(meal({ portion: "per 100 g" }), "NAYA");
    expect(r.values.proteinG).toBe("");
    expect(r.values.energyKcal).toBe("");
  });

  it("leaves calories empty when the restaurant prints none", () => {
    expect(mealDiaryPrefill(meal({}, null), "NAYA").values.energyKcal).toBe("");
  });
});

describe("a logged real meal's source, in the diary", () => {
  const base = {
    restaurant: { name: "Veggie Grill" },
    dish: { name: "Steak Asada Burrito" },
    loggedAt: "2026-11-20T03:00:00Z",
    source: { url: "https://example.test/menu", checkedOn: "2026-11-18" },
    status: "unverified_draft" as const,
    protein: { evidence: "restaurant_published", sourceAmount: 44, logged: 44, changedByYou: false, typedByYou: false },
    servings: 1,
  };
  it("names the restaurant's printed figure as the restaurant's, and the draft as unverified", () => {
    const w = mealSourceWords(base, 1);
    expect(w.headline).toBe("Protein printed by Veggie Grill · Unverified draft");
    expect(w.lines.join(" ")).toContain("44 g protein for one serving, printed by the restaurant");
    expect(w.lines.join(" ")).toContain("Nov 18, 2026");
  });
  it("says when the person changed the figure or the servings, and never calls a confirmed transcription verified", () => {
    const w = mealSourceWords({ ...base, status: "transcription_confirmed", protein: { ...base.protein, logged: 40, changedByYou: true } }, 2);
    expect(w.headline).toBe("Protein entered by you · Transcription confirmed, not verified");
    expect(w.lines.join(" ")).toContain("You changed it to 40 g");
    expect(w.lines.join(" ")).toContain("Servings changed by you: logged as 1, now 2");
  });
  it("keeps a range or a USDA estimate as words, not a number", () => {
    const w = mealSourceWords({ ...base, protein: { evidence: "usda_estimate", sourceLow: 21, sourceHigh: 42, logged: null, changedByYou: false, typedByYou: false } }, 1);
    expect(w.headline).toBe("Protein not known · Unverified draft");
    expect(w.lines[0]).toContain("21 to 42 g protein, a USDA estimate, not the restaurant's figure");
  });
});
