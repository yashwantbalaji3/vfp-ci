import type { DiaryDay, DiaryEntry, NutrientTotal, WeekDay } from "@/contracts/diary";
import { MEAL_SLOTS } from "@/contracts/diary";

/**
 * Diary arithmetic for the screens (docs/07, R-F07, R-G03..R-G05). The database
 * adds up what is known; this module decides how to WORD it. Two rules run through
 * everything here: a missing value is never treated as zero, and a day with
 * nothing logged is never treated as a day with nothing eaten.
 */
/** When some logged values are estimates: how many, and the total with each at its low and high end. */
export type EstimatePart = { count: number; low: number; high: number } | null;

export type KnownAmount =
  | { state: "none" } // nothing logged
  | { state: "unknown" } // logged, but no entry has a value
  | { state: "partial"; value: number; missing: number; estimate: EstimatePart } // some entries have no value: a lower bound
  | { state: "complete"; value: number; estimate: EstimatePart };

function estimatePart(total: NutrientTotal): EstimatePart {
  if (total.estimatedEntries <= 0 || total.known === null) return null;
  return { count: total.estimatedEntries, low: total.low ?? total.known, high: total.high ?? total.known };
}

export function knownAmount(total: NutrientTotal | undefined): KnownAmount {
  if (!total || total.entryCount === 0) return { state: "none" };
  if (total.known === null) return { state: "unknown" };
  if (total.unknownEntries > 0) return { state: "partial", value: total.known, missing: total.unknownEntries, estimate: estimatePart(total) };
  return { state: "complete", value: total.known, estimate: estimatePart(total) };
}

/** Entries grouped by meal in the usual order; any other label goes last. */
export function groupByMeal(entries: DiaryEntry[]): { slot: string; entries: DiaryEntry[] }[] {
  const order = new Map<string, number>(MEAL_SLOTS.map((s, i) => [s, i]));
  const groups = new Map<string, DiaryEntry[]>();
  for (const e of entries) {
    const key = e.mealSlot.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
    .map(([slot, list]) => ({ slot, entries: list }));
}

export type GoalProgress =
  | { state: "no_goal" }
  | { state: "nothing_logged"; target: number }
  /** estimated: part of the total is an estimate, so this is estimate-based, not a measured intake. */
  | { state: "met"; target: number; value: number; estimated: boolean; low: number }
  | { state: "in_progress"; target: number; value: number; atLeast: boolean; estimated: boolean }
  /** The central figure reaches the goal, but an estimate's low end does not: not claimed as met. */
  | { state: "maybe"; target: number; value: number; low: number }
  | { state: "unknown"; target: number }; // logged, but no protein values at all

/** Progress toward the member's own protein goal for one day. Never negative, never a verdict. */
export function proteinProgress(day: Pick<DiaryDay, "proteinTarget" | "totals">): GoalProgress {
  const target = day.proteinTarget;
  if (target === null) return { state: "no_goal" };
  const amount = knownAmount(day.totals.protein_g);
  if (amount.state === "none") return { state: "nothing_logged", target };
  if (amount.state === "unknown") return { state: "unknown", target };
  // The known amount is a lower bound, so reaching the goal is certain even when values are missing,
  // but only if estimates count at their LOW end: an estimate alone never makes a goal "met".
  const low = amount.estimate?.low ?? amount.value;
  if (low >= target) return { state: "met", target, value: amount.value, estimated: amount.estimate !== null, low };
  if (amount.value >= target) return { state: "maybe", target, value: amount.value, low };
  return { state: "in_progress", target, value: amount.value, atLeast: amount.state === "partial", estimated: amount.estimate !== null };
}

export type WeekSummary = {
  loggedDays: number;
  /** Sum of known protein across the week; null when nothing known was logged. */
  totalKnownProtein: number | null;
  /** Days with at least one entry that has no protein value. */
  incompleteDays: number;
  /** Days the member marked as only partly logged. */
  partialDays: number;
  /** Days that count toward the average: logged, not marked partial, every entry has a protein value. */
  averageDays: number;
  averageProtein: number | null;
  /** Days up to today that had a protein goal. */
  daysWithTarget: number;
  daysTargetMet: number;
  /** Of daysTargetMet, days that include estimates (met at the estimates' low end): estimate-based. */
  daysTargetMetWithEstimates: number;
  /** Days with a goal where missing values make "met or not" impossible to tell. */
  daysTargetUnclear: number;
  homeMeals: number;
  /** Finished cooking sessions in the week (each already included in homeMeals once). */
  cookSessions: number;
  /** Recipes planned in the week. Plans are intentions and count toward nothing. */
  planned: number;
  /** Largest value on the chart scale (known protein or goal), at least 1. */
  scaleMax: number;
};

export function summarizeWeek(days: WeekDay[], today: string): WeekSummary {
  let loggedDays = 0;
  let total: number | null = null;
  let incompleteDays = 0;
  let partialDays = 0;
  let averageDays = 0;
  let averageSum = 0;
  let daysWithTarget = 0;
  let daysTargetMet = 0;
  let daysTargetMetWithEstimates = 0;
  let daysTargetUnclear = 0;
  let homeMeals = 0;
  let cookSessions = 0;
  let planned = 0;
  let scaleMax = 1;

  for (const d of days) {
    const logged = d.entryCount > 0;
    if (logged) loggedDays += 1;
    if (d.proteinKnown !== null) total = (total ?? 0) + d.proteinKnown;
    if (logged && d.proteinUnknownEntries > 0) incompleteDays += 1;
    if (logged && d.status === "partial") partialDays += 1;
    if (logged && d.status !== "partial" && d.proteinUnknownEntries === 0 && d.proteinKnown !== null) {
      averageDays += 1;
      averageSum += d.proteinKnown;
    }
    homeMeals += d.homeMeals;
    cookSessions += d.cookSessions;
    planned += d.plannedCount;
    scaleMax = Math.max(scaleMax, d.proteinKnown ?? 0, d.proteinTarget ?? 0);

    // A future day, or a day with nothing logged, is never counted as "not met".
    if (d.proteinTarget !== null && d.date <= today) {
      daysWithTarget += 1;
      const low = d.proteinLow ?? d.proteinKnown;
      if (d.proteinKnown !== null && low !== null && low >= d.proteinTarget) {
        daysTargetMet += 1;
        if (d.proteinEstimatedEntries > 0) daysTargetMetWithEstimates += 1;
      }
      else if (d.proteinKnown !== null && d.proteinKnown >= d.proteinTarget) daysTargetUnclear += 1; // met only by an estimate's central figure
      else if (logged && (d.proteinUnknownEntries > 0 || d.status === "partial")) daysTargetUnclear += 1;
    }
  }

  return {
    loggedDays,
    totalKnownProtein: total,
    incompleteDays,
    partialDays,
    averageDays,
    averageProtein: averageDays > 0 ? averageSum / averageDays : null,
    daysWithTarget,
    daysTargetMet,
    daysTargetMetWithEstimates,
    daysTargetUnclear,
    homeMeals,
    cookSessions,
    planned,
    scaleMax,
  };
}

/** What a snapshot's portion says, in words: "2 × 1 bowl" or "150 g". */
export function portionText(portion: { kind: string; label?: string | null; grams?: number | null }, quantity: number): string {
  const q = Math.round(quantity * 100) / 100;
  if (portion.kind === "grams") return `${q} g`;
  if (portion.kind === "cooked") return `${q} ${q === 1 ? "serving" : "servings"}, cooked from the recipe`;
  const label = portion.label ?? "serving";
  return q === 1 ? label : `${q} × ${label}`;
}

/** A sensible meal to preselect from the hour of the day (0-23) where the member is. They can always change it. */
export function defaultMealSlot(hour: number): (typeof MEAL_SLOTS)[number] {
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}
