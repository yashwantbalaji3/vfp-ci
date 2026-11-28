/**
 * Local-date helpers (docs/07). Dates are ISO "YYYY-MM-DD" strings in the member's
 * diary timezone; we never convert a stored local_date back through a timezone.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(date: string): void {
  if (!ISO_DATE.test(date)) throw new Error("INVALID_DATE");
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new Error("INVALID_DATE");
}

export function addDays(date: string, days: number): string {
  assertIsoDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday 1 (Monday) … 7 (Sunday). */
export function isoWeekday(date: string): number {
  assertIsoDate(date);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The seven dates of the week containing `date`; weekStart 1 = Monday (default), 7 = Sunday. */
export function weekDates(date: string, weekStart: 1 | 7 = 1): string[] {
  const offset = (isoWeekday(date) - weekStart + 7) % 7;
  const start = addDays(date, -offset);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date of an instant in a timezone. */
export function localDateOf(instant: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) throw new Error("INVALID_TIMEZONE");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
