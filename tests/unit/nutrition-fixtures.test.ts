import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { consume, ConversionError } from "@/domain/nutrition/consume";
import { calculateRecipeNutrient } from "@/domain/nutrition/recipe";
import { proteinPer100Kcal, per100g } from "@/domain/nutrition/compare";
import {
  summarizeDay,
  weeklyTargets,
  loggedDayCoverage,
  cookSessionsInWeek,
  recordedProgress,
} from "@/domain/nutrition/summary";
import { weekDates } from "@/domain/dates/week";

// Golden fixtures F01–F12 from docs/14 (synthetic arithmetic, not food facts).
const EPS = new Decimal("0.000001");
const close = (actual: Decimal | null, expected: string) => {
  expect(actual).not.toBeNull();
  expect(actual!.minus(expected).abs().lte(EPS)).toBe(true);
};

describe("golden nutrition fixtures", () => {
  it("F01: 12 g protein/100 g, consume 150 g -> 18 g", () => {
    const r = consume(
      { kind: "mass", amount: "100", unit: "g" },
      { protein_g: { value: "12", method: "published", missingReason: null } },
      { kind: "grams", grams: "150" },
    );
    close(r.nutrients.protein_g!.value, "18");
    expect(r.nutrients.protein_g!.method).toBe("published");
  });

  it("F02: 24 g per serving, no mass; 0.5 serving -> 12 g and per-100-g unavailable", () => {
    const r = consume(
      { kind: "serving", amount: "1", unit: "serving" },
      { protein_g: { value: "24", method: "published", missingReason: null } },
      { kind: "portion", portion: { label: "1 bowl", amount: "1", unit: "serving", grams: null }, multiplier: "0.5" },
    );
    close(r.nutrients.protein_g!.value, "12");
    expect(r.resolvedMassG).toBeNull();
    expect(per100g("24", { kind: "serving", amount: "1" }, null)).toBeNull();
  });

  it("F03: 18 g plus one unknown -> known subtotal 18, unknown 1, not complete", () => {
    const s = summarizeDay([
      { value: "18", method: "published" },
      { value: null, method: "unknown" },
    ]);
    close(s.knownSubtotal, "18");
    expect(s.unknownEntries).toBe(1);
    expect(s.dataComplete).toBe(false);
  });

  it("F04: recipe 20 g + 10 g, yield 2 -> 30 g batch, 15 g/serving; scaled x2 -> 60 g batch, 15 g/serving", () => {
    const ings = [
      { batchValue: "20", optional: false, included: true },
      { batchValue: "10", optional: false, included: true },
    ];
    const base = calculateRecipeNutrient(ings, 2);
    close(base.batch, "30");
    close(base.perServing, "15");
    const scaled = calculateRecipeNutrient(ings, 2, 2);
    close(scaled.batch, "60");
    close(scaled.perServing, "15");
  });

  it("F05: a required ingredient with unknown protein -> complete value null, known subtotal 20", () => {
    const r = calculateRecipeNutrient(
      [
        { batchValue: "20", optional: false, included: true },
        { batchValue: null, optional: false, included: true },
      ],
      2,
    );
    expect(r.batch).toBeNull();
    expect(r.perServing).toBeNull();
    close(r.knownSubtotal, "20");
    expect(r.missingIngredients).toBe(1);
  });

  it("F05b: an excluded optional ingredient does not make the recipe incomplete", () => {
    const r = calculateRecipeNutrient(
      [
        { batchValue: "20", optional: false, included: true },
        { batchValue: null, optional: true, included: false },
      ],
      2,
    );
    close(r.batch, "20");
  });

  it("F06: 20 g protein and 200 kcal -> 10 g/100 kcal; energy 0 or null -> unavailable", () => {
    close(proteinPer100Kcal("20", "200"), "10");
    expect(proteinPer100Kcal("20", "0")).toBeNull();
    expect(proteinPer100Kcal("20", null)).toBeNull();
  });

  it("F08: goal 80 g Mon–Wed then 100 g Thu–Sun -> 640 g week, 340 g through Thursday", () => {
    const week = weekDates("2026-11-11"); // Wednesday -> Mon 9 … Sun 15
    expect(week[0]).toBe("2026-11-09");
    const t = weeklyTargets(week, "2026-11-12", [
      { target: "80", effectiveFrom: "2026-11-01", effectiveTo: "2026-11-12" },
      { target: "100", effectiveFrom: "2026-11-12", effectiveTo: null },
    ]);
    close(t.fullWeekTarget, "640");
    close(t.elapsedTarget, "340");
  });

  it("F08b: days with no goal are excluded from the denominator and listed", () => {
    const week = weekDates("2026-11-11");
    const t = weeklyTargets(week, "2026-11-15", [{ target: "80", effectiveFrom: "2026-11-12", effectiveTo: null }]);
    close(t.fullWeekTarget, "320");
    expect(t.datesWithoutGoal).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
  });

  it("F09: 3 logged days in a 7-day range -> 3 logged days, 4 gaps (not zero intake)", () => {
    const week = weekDates("2026-11-11");
    const c = loggedDayCoverage(week, [
      { date: "2026-11-09", entryCount: 2 },
      { date: "2026-11-11", entryCount: 1 },
      { date: "2026-11-14", entryCount: 3 },
    ]);
    expect(c.loggedDays).toBe(3);
    expect(c.gaps).toHaveLength(4);
  });

  it("F10: 2 oz mass portion at 10 g/100 g -> 56.69904625 g and 5.669904625 g protein", () => {
    const r = consume(
      { kind: "mass", amount: "100", unit: "g" },
      { protein_g: { value: "10", method: "published", missingReason: null } },
      { kind: "portion", portion: { label: "2 oz", amount: "2", unit: "oz", grams: null }, multiplier: "1" },
    );
    close(r.resolvedMassG, "56.69904625");
    close(r.nutrients.protein_g!.value, "5.669904625");
  });

  it("F11: two bowls with no gram mapping -> unquantified, nutrition null, no guessed mass", () => {
    const r = consume(
      { kind: "mass", amount: "100", unit: "g" },
      { protein_g: { value: "7", method: "published", missingReason: null } },
      { kind: "portion", portion: { label: "1 bowl", amount: "1", unit: "bowl", grams: null }, multiplier: "2" },
    );
    expect(r.factor).toBeNull();
    expect(r.resolvedMassG).toBeNull();
    expect(r.nutrients.protein_g).toEqual({ value: null, method: "published", missingReason: "unavailable_conversion" });
  });

  it("F12: one completed cook session with 3 portions logged -> weekly cook count 1", () => {
    const week = weekDates("2026-11-11");
    expect(
      cookSessionsInWeek(
        [
          { id: "s1", completedLocalDate: "2026-11-10" },
          { id: "s1", completedLocalDate: "2026-11-10" },
          { id: "s2", completedLocalDate: null },
        ],
        week,
      ),
    ).toBe(1);
  });
});

describe("input validation and neutral progress", () => {
  it("rejects zero, negative, non-finite and oversized amounts", () => {
    const basis = { kind: "mass", amount: "100", unit: "g" } as const;
    for (const grams of ["0", "-5", "100001"]) {
      expect(() => consume(basis, {}, { kind: "grams", grams })).toThrow(ConversionError);
    }
    expect(() => consume(basis, {}, { kind: "grams", grams: Infinity })).toThrow(ConversionError);
    expect(() => consume(basis, {}, { kind: "grams", grams: NaN })).toThrow(ConversionError);
    expect(() =>
      consume(basis, {}, { kind: "portion", portion: { label: "x", amount: "1", unit: "g", grams: "1" }, multiplier: "101" }),
    ).toThrow(ConversionError);
  });

  it("rejects grams for a serving-basis food without a sourced serving weight", () => {
    expect(() =>
      consume({ kind: "serving", amount: "1", unit: "serving" }, {}, { kind: "grams", grams: "100" }),
    ).toThrow("UNSUPPORTED_MASS_CONVERSION");
  });

  it("converts grams to servings only through a sourced serving weight", () => {
    const r = consume(
      { kind: "serving", amount: "1", unit: "serving" },
      { protein_g: { value: "20", method: "published", missingReason: null } },
      { kind: "grams", grams: "25" },
      [{ label: "1 pack", amount: "1", unit: "serving", grams: "50" }],
    );
    close(r.nutrients.protein_g!.value, "10");
  });

  it("keeps unknown values unknown even when the amount converts", () => {
    const r = consume(
      { kind: "mass", amount: "100", unit: "g" },
      { fat_g: { value: null, method: "published", missingReason: "not_provided" } },
      { kind: "grams", grams: "50" },
    );
    expect(r.nutrients.fat_g!.value).toBeNull();
    expect(r.nutrients.fat_g!.missingReason).toBe("not_provided");
  });

  it("progress never reports a negative remaining amount", () => {
    const p = recordedProgress("120", "100")!;
    close(p.remaining, "0");
    expect(recordedProgress("10", null)).toBeNull();
  });
});
