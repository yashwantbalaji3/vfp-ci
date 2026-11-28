import { describe, expect, it } from "vitest";
import { bostonArea } from "../../scripts/lib/boston-areas.mjs";

// The importer's copy of app.boston_area() (migration 20261127000100). tests/db/boston-neighbourhoods.test.ts checks
// the two agree; this pins the cases that matter for the owner's seven priority areas.
describe("Boston neighbourhood from an address", () => {
  it("keeps the six earlier labels exactly", () => {
    expect(bostonArea("02116")).toBe("Back Bay / Prudential");
    expect(bostonArea("02115")).toBe("Fenway / Northeastern");
    expect(bostonArea("02115", "Boston", -71.0884)).toBe("Fenway / Northeastern"); // Northeastern University
    expect(bostonArea("02115", "Boston", -71.1053)).toBe("Mission Hill / Longwood"); // Longwood Medical Area
    expect(bostonArea("02120")).toBe("Mission Hill / Longwood");
    expect(bostonArea("02118")).toBe("South End");
    expect(bostonArea("02111")).toBe("Downtown / Financial District / Chinatown");
    expect(bostonArea("02138")).toBe("Cambridge (Central, Harvard, Kendall)");
    expect(bostonArea("02215", "Boston", -71.0942)).toBe("Fenway / Kenmore"); // 484 Commonwealth Ave
  });
  it("splits 02215 at the Allston line, and names the new areas", () => {
    expect(bostonArea("02215", "Boston", -71.1219)).toBe("Allston / Brighton"); // 1033 Commonwealth Ave
    expect(bostonArea("02215", "Boston", null)).toBe("Fenway / Kenmore");
    expect(bostonArea("02135", "Brighton")).toBe("Allston / Brighton"); // Cleveland Circle
    expect(bostonArea("02446", "Brookline")).toBe("Brookline");
    expect(bostonArea("02467", "Brookline")).toBe("Brookline");
    expect(bostonArea("02467", "Chestnut Hill")).toBe("Chestnut Hill");
    expect(bostonArea("02144", "Somerville")).toBe("Somerville");
  });
  it("falls back to the town, never to plain 'Boston'", () => {
    expect(bostonArea("02472", "WATERTOWN")).toBe("Watertown");
    expect(bostonArea("02459", "Newton Centre")).toBe("Newton");
    expect(bostonArea("02199x", "Boston")).toBeNull();
    expect(bostonArea(null, null)).toBeNull();
    expect(bostonArea("02999", "Brighton")).toBe("Allston / Brighton");
  });
});
