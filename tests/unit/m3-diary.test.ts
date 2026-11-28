import { describe, expect, it } from "vitest";
import { customFoodInputSchema, goalsInputSchema, isoDateSchema, logEntryInputSchema, type DiaryEntry, type WeekDay } from "@/contracts/diary";
import { localDateOf, weekDates } from "@/domain/dates/week";
import { csvCell, diaryCsv } from "@/domain/diary/export";
import { defaultMealSlot, groupByMeal, knownAmount, portionText, proteinProgress, summarizeWeek } from "@/domain/diary/summary";

// M3 diary wording and arithmetic (T-DIARY, T-GOALS in docs/14). The rule under
// test throughout: unknown is never zero, and an empty day is never a zero day.

const total = (known: number | null, entryCount: number, unknownEntries = 0) => ({ known, entryCount, unknownEntries, estimatedEntries: 0 });
const day = (date: string, over: Partial<WeekDay> = {}): WeekDay => ({
  date,
  status: "unspecified",
  entryCount: 0,
  proteinKnown: null,
  proteinUnknownEntries: 0,
  proteinEstimatedEntries: 0,
  energyKnown: null,
  energyUnknownEntries: 0,
  homeMeals: 0,
  homeMealsFromDiary: 0,
  cookSessions: 0,
  plannedCount: 0,
  proteinTarget: null,
  ...over,
});
const week = (over: Record<number, Partial<WeekDay>>) => weekDates("2026-11-11").map((d, i) => day(d, over[i] ?? {}));

describe("known amounts", () => {
  it("tells apart: nothing logged, logged but unknown, partly known, fully known", () => {
    expect(knownAmount(undefined)).toEqual({ state: "none" });
    expect(knownAmount(total(null, 0))).toEqual({ state: "none" });
    expect(knownAmount(total(null, 2, 2))).toEqual({ state: "unknown" });
    expect(knownAmount(total(18, 2, 1))).toEqual({ state: "partial", value: 18, missing: 1, estimate: null });
    expect(knownAmount(total(42, 3, 0))).toEqual({ state: "complete", value: 42, estimate: null });
  });

  it("a real zero (a food with 0 g protein) is a known value, not 'unknown'", () => {
    expect(knownAmount(total(0, 1, 0))).toEqual({ state: "complete", value: 0, estimate: null });
  });
});

describe("protein goal for a day", () => {
  it("no goal means no progress is shown at all", () => {
    expect(proteinProgress({ proteinTarget: null, totals: { protein_g: total(90, 3) } })).toEqual({ state: "no_goal" });
  });
  it("reaching the goal is certain even when some items have no value", () => {
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: total(64, 3, 1) } })).toEqual({ state: "met", target: 60, value: 64, estimated: false, low: 64 });
  });
  it("below the goal with missing values is 'at least', never 'short by'", () => {
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: total(24, 2, 1) } })).toEqual({ state: "in_progress", target: 60, value: 24, atLeast: true, estimated: false });
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: total(24, 2, 0) } })).toMatchObject({ state: "in_progress", atLeast: false });
  });
  it("an empty day and an all-unknown day are their own states", () => {
    expect(proteinProgress({ proteinTarget: 60, totals: {} })).toEqual({ state: "nothing_logged", target: 60 });
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: total(null, 1, 1) } })).toEqual({ state: "unknown", target: 60 });
  });
});

describe("estimates in the diary (NIE N-4 diary part)", () => {
  const est = (known: number, low: number, high: number, count = 1, unknown = 0) => ({ known, entryCount: 3, unknownEntries: unknown, estimatedEntries: count, low, high });
  it("a total that includes estimates carries how many and its low and high ends", () => {
    expect(knownAmount(est(40, 31, 47))).toEqual({ state: "complete", value: 40, estimate: { count: 1, low: 31, high: 47 } });
    expect(knownAmount(est(40, 31, 47, 2, 1))).toEqual({ state: "partial", value: 40, missing: 1, estimate: { count: 2, low: 31, high: 47 } });
  });
  it("a goal is never 'met' on an estimate's central figure: only when the low end reaches it", () => {
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: est(64, 55, 70) } })).toEqual({ state: "maybe", target: 60, value: 64, low: 55 });
    // Met at the estimates' low end: still labelled estimate-based, never a measured intake.
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: est(66, 60, 72) } })).toEqual({ state: "met", target: 60, value: 66, estimated: true, low: 60 });
    expect(proteinProgress({ proteinTarget: 60, totals: { protein_g: est(30, 25, 35) } })).toEqual({ state: "in_progress", target: 60, value: 30, atLeast: false, estimated: true });
  });
  it("older answers without low and high fall back to the central value, as before", () => {
    expect(knownAmount({ known: 40, entryCount: 2, unknownEntries: 0, estimatedEntries: 1 })).toEqual({ state: "complete", value: 40, estimate: { count: 1, low: 40, high: 40 } });
  });
  it("in a week, a day met only by an estimate's central figure is 'can't tell', not 'met'", () => {
    const s = summarizeWeek(
      week({
        0: { entryCount: 2, proteinKnown: 64, proteinLow: 55, proteinEstimatedEntries: 1, proteinTarget: 60 },
        1: { entryCount: 2, proteinKnown: 66, proteinLow: 61, proteinEstimatedEntries: 1, proteinTarget: 60 },
        2: { entryCount: 2, proteinKnown: 70, proteinTarget: 60 },
      }),
      "2026-11-15",
    );
    expect(s.daysTargetMet).toBe(2);
    expect(s.daysTargetMetWithEstimates).toBe(1); // day 1: met at the low end, still estimate-based
    expect(s.daysTargetUnclear).toBe(1);
  });
});

describe("week summary", () => {
  it("an empty week has no total, no average and nothing 'not met'", () => {
    const s = summarizeWeek(week({ 0: { proteinTarget: 60 }, 1: { proteinTarget: 60 } }), "2026-11-15");
    expect(s).toMatchObject({ loggedDays: 0, totalKnownProtein: null, averageProtein: null, averageDays: 0, daysTargetMet: 0, daysTargetUnclear: 0, daysWithTarget: 2 });
  });

  it("averages only fully known, not-partial logged days; empty days are left out, not zero", () => {
    const s = summarizeWeek(
      week({
        0: { entryCount: 3, proteinKnown: 80 },
        1: { entryCount: 2, proteinKnown: 60 },
        2: { entryCount: 2, proteinKnown: 30, proteinUnknownEntries: 1 }, // incomplete nutrition
        3: { entryCount: 1, proteinKnown: 20, status: "partial" }, // member said partly logged
        // days 4-6: nothing logged
      }),
      "2026-11-15",
    );
    expect(s.loggedDays).toBe(4);
    expect(s.totalKnownProtein).toBe(190);
    expect(s.averageDays).toBe(2);
    expect(s.averageProtein).toBe(70); // (80 + 60) / 2, not 190 / 7
    expect(s.incompleteDays).toBe(1);
    expect(s.partialDays).toBe(1);
  });

  it("a day whose items all lack protein adds nothing to the total and is not averaged as zero", () => {
    const s = summarizeWeek(week({ 0: { entryCount: 1, proteinKnown: null, proteinUnknownEntries: 1 }, 1: { entryCount: 1, proteinKnown: 50 } }), "2026-11-15");
    expect(s.totalKnownProtein).toBe(50);
    expect(s.averageProtein).toBe(50);
    expect(s.incompleteDays).toBe(1);
  });

  it("counts days the goal was met; unclear and future days are never counted against the member", () => {
    const s = summarizeWeek(
      week({
        0: { entryCount: 2, proteinKnown: 70, proteinTarget: 60 }, // met
        1: { entryCount: 2, proteinKnown: 40, proteinTarget: 60 }, // below, fully known
        2: { entryCount: 2, proteinKnown: 40, proteinUnknownEntries: 1, proteinTarget: 60 }, // can't tell
        3: { entryCount: 2, proteinKnown: 65, proteinUnknownEntries: 1, proteinTarget: 60 }, // met for certain
        4: { proteinTarget: 60 }, // today, nothing logged
        5: { proteinTarget: 60 }, // future
        6: { proteinTarget: 60 }, // future
      }),
      "2026-11-13",
    );
    expect(s.daysWithTarget).toBe(5);
    expect(s.daysTargetMet).toBe(2);
    expect(s.daysTargetUnclear).toBe(1);
  });

  it("adds up home-cooked meals and keeps the chart scale above zero", () => {
    const s = summarizeWeek(week({ 0: { entryCount: 1, homeMeals: 2 }, 3: { entryCount: 1, homeMeals: 1 } }), "2026-11-15");
    expect(s.homeMeals).toBe(3);
    expect(s.scaleMax).toBeGreaterThanOrEqual(1);
  });
});

describe("display helpers", () => {
  const entry = (mealSlot: string, name: string) => ({ mealSlot, name }) as DiaryEntry;
  it("groups meals in the usual order, whatever the letter case", () => {
    const groups = groupByMeal([entry("dinner", "a"), entry("Breakfast", "b"), entry("snack", "c"), entry("breakfast", "d"), entry("lunch", "e")]);
    expect(groups.map((g) => g.slot)).toEqual(["breakfast", "lunch", "dinner", "snack"]);
    expect(groups[0].entries.map((e) => e.name)).toEqual(["b", "d"]);
  });
  it("words a portion", () => {
    expect(portionText({ kind: "defined", label: "1 bowl" }, 1)).toBe("1 bowl");
    expect(portionText({ kind: "defined", label: "1 bowl" }, 2)).toBe("2 × 1 bowl");
    expect(portionText({ kind: "grams", grams: 150 }, 150)).toBe("150 g");
  });
  it("preselects a meal from the time of day", () => {
    expect([7, 12, 19, 23, 2].map(defaultMealSlot)).toEqual(["breakfast", "lunch", "dinner", "snack", "snack"]);
  });
});

describe("timezones and daylight saving", () => {
  it("the same instant is a different calendar day in different places", () => {
    const instant = new Date("2026-11-14T03:30:00Z");
    expect(localDateOf(instant, "America/New_York")).toBe("2026-11-13");
    expect(localDateOf(instant, "America/Los_Angeles")).toBe("2026-11-13");
    expect(localDateOf(instant, "Asia/Tokyo")).toBe("2026-11-14");
    expect(localDateOf(instant, "UTC")).toBe("2026-11-14");
  });
  it("stays on the right day across the spring and autumn clock changes", () => {
    // 8 March 2026: clocks go forward in New York at 02:00.
    expect(localDateOf(new Date("2026-03-08T04:59:00Z"), "America/New_York")).toBe("2026-03-07");
    expect(localDateOf(new Date("2026-03-08T05:00:00Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateOf(new Date("2026-03-09T03:59:00Z"), "America/New_York")).toBe("2026-03-08"); // 23-hour day
    expect(localDateOf(new Date("2026-03-09T04:00:00Z"), "America/New_York")).toBe("2026-03-09");
    // 1 November 2026: clocks go back; the day is 25 hours long.
    expect(localDateOf(new Date("2026-11-01T04:00:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateOf(new Date("2026-11-02T04:59:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateOf(new Date("2026-11-02T05:00:00Z"), "America/New_York")).toBe("2026-11-02");
  });
  it("weeks start on Monday and contain seven real dates across a clock change", () => {
    expect(weekDates("2026-11-01")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(weekDates("2026-03-08")[0]).toBe("2026-03-02");
  });
});

describe("form contracts", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const base = { idempotencyKey: id, revisionId: id, context: "home", mealSlot: "lunch", date: "2026-11-13" };
  it("needs a portion with a quantity, or grams, never both and never neither", () => {
    expect(logEntryInputSchema.safeParse({ ...base, portionId: id, quantity: "1.5" }).success).toBe(true);
    expect(logEntryInputSchema.safeParse({ ...base, grams: "150" }).success).toBe(true);
    expect(logEntryInputSchema.safeParse(base).success).toBe(false);
    expect(logEntryInputSchema.safeParse({ ...base, portionId: id, quantity: 1, grams: 100 }).success).toBe(false);
  });
  it("rejects zero, negative and absurd amounts, and impossible dates", () => {
    for (const quantity of ["0", "-1", "101", "abc"]) expect(logEntryInputSchema.safeParse({ ...base, portionId: id, quantity }).success).toBe(false);
    expect(isoDateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(isoDateSchema.safeParse("13/11/2026").success).toBe(false);
  });
  it("a food of your own needs only a name; empty nutrition boxes stay undefined, not 0", () => {
    const parsed = customFoodInputSchema.parse({
      idempotencyKey: id, name: "  Stew ", quantity: "1", proteinG: "", energyKcal: "", carbG: "", fatG: "", fiberG: "", servingGrams: "",
      context: "home", mealSlot: "dinner", date: "2026-11-13",
    });
    expect(parsed.name).toBe("Stew");
    expect(parsed.proteinG).toBeUndefined();
    expect(parsed.energyKcal).toBeUndefined();
    expect(customFoodInputSchema.parse({ ...parsed, proteinG: "0" }).proteinG).toBe(0); // a typed 0 is a real 0
    expect(customFoodInputSchema.safeParse({ ...parsed, name: "   " }).success).toBe(false);
    expect(customFoodInputSchema.safeParse({ ...parsed, proteinG: "-3" }).success).toBe(false);
  });
  it("goals: empty means no goal; values must be in range; home meals are whole numbers", () => {
    expect(goalsInputSchema.parse({ proteinPerDay: "", homeMealsPerWeek: "" })).toEqual({ proteinPerDay: null, homeMealsPerWeek: null });
    expect(goalsInputSchema.parse({ proteinPerDay: "82.5" }).proteinPerDay).toBe(82.5);
    expect(goalsInputSchema.safeParse({ proteinPerDay: "0" }).success).toBe(false);
    expect(goalsInputSchema.safeParse({ proteinPerDay: "900" }).success).toBe(false);
    expect(goalsInputSchema.safeParse({ homeMealsPerWeek: "2.5" }).success).toBe(false);
    expect(goalsInputSchema.safeParse({ homeMealsPerWeek: "22" }).success).toBe(false);
  });
});

describe("spreadsheet export", () => {
  it("writes unknown values as empty cells, never as 0", () => {
    const csv = diaryCsv([
      { date: "2026-11-13", mealSlot: "dinner", context: "home", name: "Stew", quantity: 1, massG: null, portion: { kind: "defined", label: "1 serving" }, nutrients: { protein_g: { value: null }, energy_kcal: { value: 0 } } },
    ]);
    const [head, row] = csv.trim().split("\r\n");
    expect(head).toBe("date,meal,where,food,amount,portion,weight_g,protein_g,energy_kcal,carb_g,fat_g,fiber_g,protein_source");
    expect(row).toBe("2026-11-13,dinner,home,Stew,1,1 serving,,,0,,,,");
  });
  it("quotes commas and quotes, and defuses spreadsheet formulas in typed names", () => {
    expect(csvCell('Mac, "cheese"')).toBe('"Mac, ""cheese"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });
});
