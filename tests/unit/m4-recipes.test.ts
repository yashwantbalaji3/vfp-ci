import { describe, expect, it } from "vitest";
import { updateEntryInputSchema } from "@/contracts/diary";
import { logCookInputSchema, recipeFiltersSchema, recipeOptionsSchema, startCookInputSchema, swapsSchema } from "@/contracts/recipes";
import { portionText, summarizeWeek } from "@/domain/diary/summary";
import { formatClock, formatQuantity, formatServings, kitchenFraction, recipeHref, swapsFromParams, timerWords } from "@/domain/recipes/quantity";
import type { WeekDay } from "@/contracts/diary";

// M4 wording and input rules (T-COOK in docs/14). The arithmetic itself (scaling,
// swaps, nutrition, eligibility) lives in the database and is tested in tests/db/m4-recipes.test.ts.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("kitchen amounts", () => {
  it("writes common fractions the way a cookbook does", () => {
    expect(kitchenFraction(0.5)).toBe("½");
    expect(kitchenFraction(1.5)).toBe("1½");
    expect(kitchenFraction(0.75)).toBe("¾");
    expect(formatQuantity(1.5, "tsp")).toBe("1½ tsp");
    expect(formatQuantity(250, "g")).toBe("250 g");
  });
  it("uses the singular for one serving or less", () => {
    expect(formatServings(1)).toBe("1 serving");
    expect(formatServings(0.5)).toBe("½ serving");
    expect(formatServings(2)).toBe("2 servings");
    expect(formatServings(1.5)).toBe("1½ servings");
  });
  it("formats timers", () => {
    expect(formatClock(95)).toBe("1:35");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(-4)).toBe("0:00");
    expect(timerWords(300)).toBe("5 minutes");
  });
});

describe("recipe addresses", () => {
  it("reads only well-formed swap choices from an address", () => {
    expect(swapsFromParams({ swap_protein: id(1), swap_BAD: id(2), swap_cream: "not-an-id", other: id(3), swap_fat: [id(4), id(5)] })).toEqual({ protein: id(1), fat: id(4) });
  });
  it("round-trips servings and swaps, leaving out the defaults", () => {
    expect(recipeHref(id(9), { servings: 3, yieldServings: 3 })).toBe(`/cook/${id(9)}`);
    const href = recipeHref(id(9), { servings: 6, yieldServings: 3, swaps: { protein: id(1) }, unsure: true });
    const params = Object.fromEntries(new URL(href, "http://x").searchParams.entries());
    expect(params.servings).toBe("6");
    expect(swapsFromParams(params)).toEqual({ protein: id(1) });
    expect(params.unsure).toBe("1");
  });
});

describe("input rules", () => {
  it("limits servings to a quarter up to 100", () => {
    expect(recipeOptionsSchema.safeParse({ servings: "0.1" }).success).toBe(false);
    expect(recipeOptionsSchema.safeParse({ servings: "101" }).success).toBe(false);
    expect(recipeOptionsSchema.safeParse({ servings: "abc" }).success).toBe(false);
    expect(recipeOptionsSchema.parse({ servings: "2.5" })).toEqual({ servings: 2.5, swaps: {} });
    expect(recipeOptionsSchema.parse({})).toEqual({ swaps: {} });
  });
  it("accepts only group names and ids as swaps", () => {
    expect(swapsSchema.safeParse({ protein: id(1) }).success).toBe(true);
    expect(swapsSchema.safeParse({ "Protein; drop": id(1) }).success).toBe(false);
    expect(swapsSchema.safeParse({ protein: "tofu" }).success).toBe(false);
    expect(startCookInputSchema.safeParse({ idempotencyKey: id(1), foodItemId: id(2), swaps: { protein: 5 } }).success).toBe(false);
  });
  it("rejects unknown filters instead of guessing", () => {
    expect(recipeFiltersSchema.safeParse({ meal: "brunch" }).success).toBe(false);
    expect(recipeFiltersSchema.safeParse({ cuisine: "french" }).success).toBe(false);
    expect(recipeFiltersSchema.parse({})).toMatchObject({ highProtein: false, view: "matches" });
  });
  it("a cooking log needs a positive amount, a meal and a real date; zero is not an amount", () => {
    const ok = { idempotencyKey: id(1), sessionId: id(2), servings: "1.5", mealSlot: "dinner", date: "2026-11-14" };
    expect(logCookInputSchema.parse(ok)).toMatchObject({ servings: 1.5, additional: false });
    expect(logCookInputSchema.safeParse({ ...ok, servings: "0" }).success).toBe(false);
    expect(logCookInputSchema.safeParse({ ...ok, servings: "" }).success).toBe(false);
    expect(logCookInputSchema.safeParse({ ...ok, date: "2026-02-30" }).success).toBe(false);
    expect(logCookInputSchema.safeParse({ ...ok, mealSlot: undefined }).success).toBe(false);
  });
  it("a cooked diary entry is edited by servings only", () => {
    const base = { entryId: id(1), expectedVersion: 1 };
    expect(updateEntryInputSchema.safeParse({ ...base, cooked: true, quantity: 2 }).success).toBe(true);
    expect(updateEntryInputSchema.safeParse({ ...base, cooked: true, quantity: 2, grams: 100 }).success).toBe(false);
    expect(updateEntryInputSchema.safeParse({ ...base, cooked: true, quantity: 2, portionId: id(3) }).success).toBe(false);
    expect(updateEntryInputSchema.safeParse({ ...base, quantity: 2 }).success).toBe(false);
  });
});

describe("diary wording for cooking", () => {
  it("describes a cooked entry in servings", () => {
    expect(portionText({ kind: "cooked" }, 1)).toBe("1 serving, cooked from the recipe");
    expect(portionText({ kind: "cooked" }, 1.5)).toBe("1.5 servings, cooked from the recipe");
  });
  it("adds up cooking sessions and plans without touching protein", () => {
    const day = (date: string, over: Partial<WeekDay>): WeekDay => ({
      date, status: "unspecified", entryCount: 0, proteinKnown: null, proteinUnknownEntries: 0, proteinEstimatedEntries: 0,
      energyKnown: null, energyUnknownEntries: 0, homeMeals: 0, homeMealsFromDiary: 0, cookSessions: 0, plannedCount: 0, proteinTarget: null, ...over,
    });
    const s = summarizeWeek([day("2026-11-09", { homeMeals: 1, cookSessions: 1 }), day("2026-11-10", { plannedCount: 2 }), day("2026-11-11", { homeMeals: 2, homeMealsFromDiary: 1, cookSessions: 1 })], "2026-11-11");
    expect(s).toMatchObject({ homeMeals: 3, cookSessions: 2, planned: 2, totalKnownProtein: null, loggedDays: 0 });
  });
});
