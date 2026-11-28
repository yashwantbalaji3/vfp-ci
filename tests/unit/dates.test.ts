import { describe, expect, it } from "vitest";
import { addDays, assertIsoDate, isoWeekday, localDateOf, weekDates, isValidTimeZone } from "@/domain/dates/week";

describe("local dates (docs/07, docs/14 date tests)", () => {
  it("handles leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(() => assertIsoDate("2027-02-29")).toThrow("INVALID_DATE");
  });

  it("uses Monday-start weeks by default and supports Sunday-start", () => {
    expect(weekDates("2026-11-15")[0]).toBe("2026-11-09"); // Sunday belongs to the Monday week
    expect(weekDates("2026-11-15", 7)[0]).toBe("2026-11-15");
    expect(isoWeekday("2026-11-13")).toBe(5);
  });

  it("spring-forward gap: instants on either side map to the right local date", () => {
    // 2026-03-08 02:00 America/New_York does not exist.
    expect(localDateOf(new Date("2026-03-08T06:59:00Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDateOf(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toBe("2026-03-08");
  });

  it("fall-back repeated hour stays on the same local date", () => {
    expect(localDateOf(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDateOf(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("2026-11-01");
  });

  it("near-midnight travel: the same instant is a different local date in another zone", () => {
    const instant = new Date("2026-11-14T03:30:00Z");
    expect(localDateOf(instant, "America/New_York")).toBe("2026-11-13");
    expect(localDateOf(instant, "Europe/London")).toBe("2026-11-14");
  });

  it("rejects invalid timezones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(() => localDateOf(new Date(), "Mars/Base")).toThrow("INVALID_TIMEZONE");
  });
});
