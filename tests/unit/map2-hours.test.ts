import { describe, expect, it } from "vitest";
import { clockWords, hoursWords, momentWords, periodWords, weeklyLines } from "@/lib/hours-words";
import type { HoursStatus } from "@/contracts/hours";

// MAP-2: the owner's status wording, in the place's time zone, never relying on colour.
const tz = "America/New_York";
const now = new Date("2026-11-17T17:00:00Z"); // Tuesday 12:00 in New York
const s = (x: Partial<HoursStatus>): HoursStatus => ({ state: "closed", timezone: tz, ...x }) as HoursStatus;

describe("hours in words", () => {
  it("formats clock times the way people say them", () => {
    expect(["00:00", "07:00", "11:30", "12:00", "21:00"].map(clockWords)).toEqual(["12 AM", "7 AM", "11:30 AM", "12 PM", "9 PM"]);
    expect(periodWords({ opens: "17:00", closes: "02:00", closesNextDay: true })).toBe("5 PM–2 AM");
    expect(periodWords({ opens: "00:00", closes: "00:00", closesNextDay: true })).toBe("Open 24 hours");
  });

  it("uses the owner's five statuses", () => {
    expect(hoursWords(s({ state: "open", closesAt: "2026-11-18T02:00:00Z" }), now)).toEqual({ label: "Open now", detail: "Closes at 9 PM", tone: "open" });
    expect(hoursWords(s({ state: "closed", opensAt: "2026-11-18T16:00:00Z" }), now).label).toBe("Closed · opens at 11 AM tomorrow");
    expect(hoursWords(s({ state: "closed", opensAt: "2026-11-17T22:00:00Z" }), now).label).toBe("Closed · opens at 5 PM");
    expect(hoursWords(s({ state: "closed", opensAt: "2026-11-19T16:00:00Z" }), now).label).toBe("Closed · opens at 11 AM Thursday");
    expect(hoursWords(s({ state: "needs_confirmation", reason: "unchecked" }), now)).toEqual({ label: "Hours need confirmation", detail: null, tone: "unknown" });
    expect(hoursWords(s({ state: "needs_confirmation", reason: "out_of_date", checkedAt: "2026-08-12T15:00:00Z" }), now).detail).toBe("Last checked Aug 12, 2026");
    expect(hoursWords(s({ state: "temporarily_closed", until: "2026-12-10" }), now)).toEqual({ label: "Temporarily closed", detail: "Until Dec 10", tone: "closed" });
    expect(hoursWords(s({ state: "open", open24h: true, closesAt: null }), now).detail).toBe("Open 24 hours");
  });

  it("closes soon (MAP2-B) always shows the exact closing time, and only when the database says open", () => {
    expect(hoursWords(s({ state: "open", closesAt: "2026-11-17T17:20:00Z", closesSoon: true }), now)).toEqual({ label: "Open now · closes soon", detail: "Closes at 12:20 PM", tone: "open" });
    // Past midnight: the closing time is tomorrow for the place.
    expect(hoursWords(s({ state: "open", closesAt: "2026-11-18T07:00:00Z", closesSoon: true }), new Date("2026-11-18T04:45:00Z")).detail).toBe("Closes at 2 AM tomorrow");
    // A 24-hour place never "closes soon"; a state other than open never shows it.
    expect(hoursWords(s({ state: "open", open24h: true, closesAt: null, closesSoon: false }), now).label).toBe("Open now");
    expect(hoursWords(s({ state: "needs_confirmation", reason: "out_of_date", closesSoon: true }), now).label).toBe("Hours need confirmation");
    expect(hoursWords(s({ state: "closed", closesSoon: true, opensAt: "2026-11-17T22:00:00Z" }), now).label).toBe("Closed · opens at 5 PM");
  });

  it("anything unknown reads as needing confirmation, never as open", () => {
    expect(hoursWords(null, now).label).toBe("Hours need confirmation");
    expect(hoursWords(undefined, now).tone).toBe("unknown");
  });

  it("days are judged in the place's time zone, not the computer's", () => {
    // 11 PM in New York on Tuesday is already Wednesday in UTC; it is still "today" for the place.
    expect(momentWords("2026-11-18T04:00:00Z", tz, new Date("2026-11-18T01:00:00Z"))).toBe("11 PM");
  });

  it("lists the week from Monday, with closed days and several periods", () => {
    const lines = weeklyLines({
      weekly: [
        { day: 2, opens: "17:00", closes: "22:00", closesNextDay: false },
        { day: 2, opens: "11:30", closes: "14:30", closesNextDay: false },
        { day: 0, opens: "00:00", closes: "00:00", closesNextDay: true },
      ],
      exceptions: [],
    });
    expect(lines[0]).toEqual({ day: "Monday", text: "Closed" });
    expect(lines[1]).toEqual({ day: "Tuesday", text: "11:30 AM–2:30 PM, 5 PM–10 PM" });
    expect(lines[6]).toEqual({ day: "Sunday", text: "Open 24 hours" });
  });
});
