import Decimal from "decimal.js";

/**
 * Daily and weekly summaries (docs/07 "Diary snapshots and aggregation",
 * "Dates, goals and weekly summaries"). Inputs come from immutable snapshots.
 */
export type EntryNutrient = { value: Decimal.Value | null; method: string };

export type DaySummary = {
  entryCount: number;
  knownSubtotal: Decimal;
  unknownEntries: number;
  estimatedEntries: number;
  /** True only when every recorded entry has a value. Says nothing about actual intake. */
  dataComplete: boolean;
};

export function summarizeDay(entries: EntryNutrient[]): DaySummary {
  let known = new Decimal(0);
  let unknown = 0;
  let estimated = 0;
  for (const e of entries) {
    if (e.value === null) {
      unknown += 1;
    } else {
      known = known.plus(e.value);
      if (e.method === "estimated") estimated += 1;
    }
  }
  return {
    entryCount: entries.length,
    knownSubtotal: known,
    unknownEntries: unknown,
    estimatedEntries: estimated,
    dataComplete: unknown === 0 && entries.length > 0,
  };
}

export type GoalVersion = {
  target: Decimal.Value;
  /** Inclusive start, ISO date. */
  effectiveFrom: string;
  /** Exclusive end, ISO date, or null when open-ended. */
  effectiveTo: string | null;
};

/** The daily target in force on a local date, or null when no goal applies. */
export function targetOn(date: string, versions: GoalVersion[]): Decimal | null {
  const v = versions.find(
    (g) => g.effectiveFrom <= date && (g.effectiveTo === null || date < g.effectiveTo),
  );
  return v ? new Decimal(v.target) : null;
}

export type WeekTargets = {
  /** Sum of each day's effective target over the whole week (not 7 × latest). */
  fullWeekTarget: Decimal | null;
  /** Sum of targets from the first day through `today` inclusive. */
  elapsedTarget: Decimal | null;
  /** Dates with no goal, excluded from the denominator and labeled. */
  datesWithoutGoal: string[];
};

export function weeklyTargets(weekDates: string[], today: string, versions: GoalVersion[]): WeekTargets {
  let full = new Decimal(0);
  let elapsed = new Decimal(0);
  let any = false;
  const without: string[] = [];
  for (const d of weekDates) {
    const t = targetOn(d, versions);
    if (t === null) {
      without.push(d);
      continue;
    }
    any = true;
    full = full.plus(t);
    if (d <= today) elapsed = elapsed.plus(t);
  }
  return {
    fullWeekTarget: any ? full : null,
    elapsedTarget: any ? elapsed : null,
    datesWithoutGoal: without,
  };
}

export type LoggedDay = { date: string; entryCount: number };

/** Days with entries are counted; missing days are gaps, never zero intake (F09). */
export function loggedDayCoverage(weekDates: string[], days: LoggedDay[]) {
  const logged = new Set(days.filter((d) => d.entryCount > 0).map((d) => d.date));
  return {
    loggedDays: weekDates.filter((d) => logged.has(d)).length,
    gaps: weekDates.filter((d) => !logged.has(d)),
  };
}

/** Neutral progress wording inputs (R-G04). No negative remaining value. */
export function recordedProgress(knownSubtotal: Decimal.Value, target: Decimal.Value | null) {
  if (target === null) return null;
  const t = new Decimal(target);
  if (t.lte(0)) return null;
  const k = new Decimal(knownSubtotal);
  return { ratio: k.div(t), remaining: Decimal.max(t.minus(k), 0) };
}

/** Cooking goal counts distinct confirmed sessions, never portions (F12). */
export function cookSessionsInWeek(
  sessions: { id: string; completedLocalDate: string | null }[],
  weekDates: string[],
): number {
  const inWeek = new Set(weekDates);
  return new Set(
    sessions.filter((s) => s.completedLocalDate !== null && inWeek.has(s.completedLocalDate)).map((s) => s.id),
  ).size;
}
