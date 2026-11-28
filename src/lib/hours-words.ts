import type { HoursStatus, HoursPeriod, WeeklyHours } from "@/contracts/hours";

/**
 * MAP-2: opening status in words (never colour alone). The wording is fixed by the owner:
 * "Open now", "Closes at 9 PM", "Closed · opens at 11 AM", "Hours need confirmation",
 * "Temporarily closed", and "Closes soon" with the exact closing time (MAP2-B). Times are shown in
 * the place's own time zone.
 */
export type HoursWords = { label: string; detail: string | null; tone: "open" | "closed" | "unknown" };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_NAMES = DAYS;

/** "11 AM", "9:30 PM", "12 PM", "12 AM". */
export function clockWords(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

function localParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, weekday: get("weekday") };
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "9 PM", "11 AM tomorrow", "11 AM Tuesday", relative to `now` in the place's time zone. */
export function momentWords(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = localParts(iso, timeZone);
  const today = localParts(now.toISOString(), timeZone).date;
  const clock = clockWords(at.time);
  if (at.date === today) return clock;
  if (at.date === addDays(today, 1)) return `${clock} tomorrow`;
  return `${clock} ${at.weekday}`;
}

export function hoursWords(status: HoursStatus | null | undefined, now: Date = new Date()): HoursWords {
  if (!status) return { label: "Hours need confirmation", detail: null, tone: "unknown" };
  const tz = status.timezone;
  switch (status.state) {
    case "open":
      if (status.open24h) return { label: "Open now", detail: "Open 24 hours", tone: "open" };
      if (status.closesSoon && status.closesAt) return { label: "Open now · closes soon", detail: `Closes at ${momentWords(status.closesAt, tz, now)}`, tone: "open" };
      return { label: "Open now", detail: status.closesAt ? `Closes at ${momentWords(status.closesAt, tz, now)}` : null, tone: "open" };
    case "closed":
      return { label: status.opensAt ? `Closed · opens at ${momentWords(status.opensAt, tz, now)}` : "Closed", detail: null, tone: "closed" };
    case "temporarily_closed":
      return {
        label: "Temporarily closed",
        detail: status.until ? `Until ${new Date(`${status.until}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : null,
        tone: "closed",
      };
    default:
      return {
        label: "Hours need confirmation",
        detail: status.reason === "out_of_date" && status.checkedAt
          ? `Last checked ${new Date(status.checkedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: tz })}`
          : null,
        tone: "unknown",
      };
  }
}

/** One line per weekday, Monday first: "Monday: 11 AM–2:30 PM, 5 PM–2 AM", "Tuesday: Closed", "Wednesday: Open 24 hours". */
export function weeklyLines(hours: WeeklyHours): { day: string; text: string }[] {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((d) => {
    const periods = hours.weekly.filter((p) => p.day === d).sort((a, b) => a.opens.localeCompare(b.opens));
    return { day: DAYS[d], text: periods.length ? periods.map(periodWords).join(", ") : "Closed" };
  });
}

export function periodWords(p: Pick<HoursPeriod, "opens" | "closes" | "closesNextDay">): string {
  if (p.closesNextDay && p.opens === "00:00" && p.closes === "00:00") return "Open 24 hours";
  return `${clockWords(p.opens)}–${clockWords(p.closes)}`;
}
