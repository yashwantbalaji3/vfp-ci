import { describe, expect, it } from "vitest";
import { HOODS, hoodByKey, hoodRank, inHood, metersBetween, miles, withinByKey } from "@/contracts/neighbourhoods";

const bb = hoodByKey("back-bay")!;
const cam = hoodByKey("cambridge")!;

describe("neighbourhoods", () => {
  it("reads only known keys", () => {
    expect(HOODS.map((h) => h.key)).toEqual([
      "fenway", "back-bay", "downtown", "cambridge", "allston-brighton", "brookline", "south-end",
      "south-boston-seaport", "beacon-hill-west-end", "mission-hill-longwood", "jamaica-plain-roxbury", "east-boston-charlestown",
    ]);
    expect(hoodByKey("nowhere")).toBeNull();
    expect(hoodByKey(undefined)).toBeNull();
    expect(withinByKey("1")?.meters).toBe(1609);
    expect(withinByKey("5")).toBeNull();
  });
  it("uses the catalog's area label when there is one, whatever the distance", () => {
    expect(inHood({ area: "Back Bay / Prudential", lat: 0, lon: 0 }, bb)).toBe(true);
    expect(inHood({ area: "Fenway / Kenmore", lat: bb.lat, lon: bb.lon }, bb)).toBe(false);
    expect(inHood({ area: "Cambridge (Central, Harvard, Kendall)", lat: 0, lon: 0 }, cam)).toBe(true);
  });
  it("covers the charter's twelve Boston areas with the address-based labels (app.boston_area)", () => {
    const of = (area: string) => HOODS.filter((h) => inHood({ area, lat: 0, lon: 0 }, h)).map((h) => h.key);
    expect(of("Fenway / Kenmore")).toEqual(["fenway"]);
    expect(of("Fenway / Northeastern")).toEqual(["fenway"]);
    expect(of("Downtown / Financial District / Chinatown")).toEqual(["downtown"]);
    expect(of("Cambridge (Porter, Inman, East Cambridge)")).toEqual(["cambridge"]);
    expect(of("Somerville")).toEqual(["cambridge"]);
    expect(of("Allston / Brighton")).toEqual(["allston-brighton"]);
    expect(of("Brookline")).toEqual(["brookline"]);
    expect(of("South End")).toEqual(["south-end"]);
    expect(of("South Boston / Seaport")).toEqual(["south-boston-seaport"]);
    expect(of("Beacon Hill / West End")).toEqual(["beacon-hill-west-end"]);
    expect(of("Mission Hill / Longwood")).toEqual(["mission-hill-longwood"]);
    expect(of("Jamaica Plain")).toEqual(["jamaica-plain-roxbury"]);
    expect(of("Roxbury")).toEqual(["jamaica-plain-roxbury"]);
    expect(of("East Boston")).toEqual(["east-boston-charlestown"]);
    expect(of("Charlestown")).toEqual(["east-boston-charlestown"]);
    // Outside the twelve: still browsable in the directory, in no shortcut.
    expect(of("West Roxbury")).toEqual([]);
    expect(of("North End")).toEqual([]);
    expect(of("Quincy")).toEqual([]);
    expect(hoodRank("Back Bay / Prudential")).toBe(1);
    expect(hoodRank("Quincy")).toBe(HOODS.length);
  });
  it("falls back to closeness only for a place with no area", () => {
    expect(inHood({ area: null, lat: 42.3736, lon: -71.1190 }, cam)).toBe(true); // Harvard Square, about 1.4 km
    expect(inHood({ area: null, lat: 42.3398, lon: -71.1497 }, cam)).toBe(false); // Cleveland Circle
    expect(inHood({ area: null, lat: 42.3398, lon: -71.1497 }, bb)).toBe(false);
  });
  it("measures straight-line distance and words it in miles", () => {
    const kenmoreToCopley = metersBetween(hoodByKey("fenway")!, bb);
    expect(kenmoreToCopley).toBeGreaterThan(1300);
    expect(kenmoreToCopley).toBeLessThan(1600);
    expect(miles(kenmoreToCopley)).toBe("0.9 mi");
    expect(miles(5)).toBe("0.1 mi");
    expect(metersBetween(bb, bb)).toBe(0);
  });
});
