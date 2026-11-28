import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { isValidTimeZone, localDateOf } from "@/domain/dates/week";

/**
 * "Today" for a member is a calendar date in THEIR timezone, never the server's.
 * The browser reports its timezone in a small first-party cookie; until it has,
 * the default market's timezone is used. Each diary entry stores the date and
 * timezone it was logged with, so travelling later never moves old entries.
 */
export const TZ_COOKIE = "tz";
export const DEFAULT_TIMEZONE = "America/New_York";

export async function memberClock(): Promise<{ timeZone: string; today: string; hour: number }> {
  // The current time is request-time data: never prerendered.
  await connection();
  const store = await cookies();
  const raw = store.get(TZ_COOKIE)?.value;
  const candidate = raw ? decodeURIComponent(raw) : "";
  const timeZone = candidate && candidate.length <= 64 && isValidTimeZone(candidate) ? candidate : DEFAULT_TIMEZONE;
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(now));
  return { timeZone, today: localDateOf(now, timeZone), hour: Number.isFinite(hour) ? hour : 12 };
}
