import { describe, expect, it } from "vitest";
import { CURRENT_PRICE_MAX_AGE_DAYS, editionOf, isHistoricalEdition } from "@/contracts/source-editions";

const OLD = "https://phopasteurboston.net/Boston%20Full%20Menu-2024-September.pdf";

describe("menu editions", () => {
  it("knows the Pho Pasteur September 2024 menu by its exact URL only", () => {
    expect(editionOf(OLD)?.label).toBe("September 2024");
    expect(editionOf("https://phopasteurboston.net/menu-boston.html")).toBeNull();
    expect(editionOf(null)).toBeNull();
  });
  it("calls an edition historical only after a year", () => {
    expect(CURRENT_PRICE_MAX_AGE_DAYS).toBe(365);
    expect(isHistoricalEdition(OLD, Date.parse("2025-08-15T00:00:00Z"))).toBe(false);
    expect(isHistoricalEdition(OLD, Date.parse("2026-11-28T00:00:00Z"))).toBe(true);
    expect(isHistoricalEdition("https://test.example/menu", Date.parse("2030-01-01T00:00:00Z"))).toBe(false);
  });
});
