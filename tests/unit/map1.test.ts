import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RADIUS, RADII, mapAreaInputSchema, mapRequestSchema, roundCoord, type MapArea, type MapPlace } from "@/contracts/map";
import { directionLinks, findArea, pinLabel, walkEstimate } from "@/lib/map-text";

// MAP-1 logic that runs without a database or a browser (docs/14 T-MAP).
const area = (slug: string, kind: MapArea["kind"], name: string, context: string | null): MapArea => ({ slug, kind, name, context, lat: 42.35, lon: -71.06, approximate: true });
const AREAS = [area("allston", "neighborhood", "Allston", "Boston"), area("back-bay", "neighborhood", "Back Bay", "Boston"), area("cambridge", "city", "Cambridge", "MA"), area("zip-02139", "zip", "02139", "Cambridge")];

describe("coarse coordinates (R-MAP-02)", () => {
  it("rounds to 3 decimal places, about 100 m", () => {
    expect(roundCoord(42.365519)).toBe(42.366);
    expect(roundCoord(-71.104031)).toBe(-71.104);
  });
  it("the request schema rounds again, so a precise point never reaches the database", () => {
    const parsed = mapAreaInputSchema.parse({ kind: "radius", lat: 42.365519, lon: -71.104031, radiusM: 805 });
    expect(parsed).toEqual({ kind: "radius", lat: 42.366, lon: -71.104, radiusM: 805 });
    const box = mapAreaInputSchema.parse({ kind: "box", west: -71.12345, south: 42.31234, east: -71.01234, north: 42.40987 });
    expect(box).toEqual({ kind: "box", west: -71.123, south: 42.312, east: -71.012, north: 42.41 });
  });
  it("refuses distances that are not offered, bad points and oversized or inverted boxes", () => {
    for (const bad of [
      { kind: "radius", lat: 42.3, lon: -71.1, radiusM: 1000 },
      { kind: "radius", lat: 95, lon: -71.1, radiusM: 805 },
      { kind: "radius", lat: 42.3, radiusM: 805 },
      { kind: "box", west: -71, south: 42.4, east: -71.1, north: 42.3 },
      { kind: "box", west: -74, south: 42, east: -71, north: 42.5 },
      { kind: "everywhere" },
    ]) {
      expect(mapAreaInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(mapRequestSchema.parse({ area: { kind: "market" } }).view).toBe("matches");
    expect(mapRequestSchema.safeParse({ area: { kind: "market" }, view: "everything" }).success).toBe(false);
  });
});

describe("distances (MAP-D)", () => {
  it("offers 0.25 to 5 miles, defaulting to 0.5 mile on a phone and 1 mile on a wide screen", () => {
    expect(RADII.map((r) => r.label)).toEqual(["0.25 mile", "0.5 mile", "1 mile", "3 miles", "5 miles"]);
    expect(DEFAULT_RADIUS).toEqual({ phone: 805, desktop: 1609 });
  });
});

describe("typed places (M-4, M-5)", () => {
  it("finds neighbourhoods, cities and ZIP codes, ignoring case and spacing", () => {
    expect(findArea(AREAS, " allston ")?.slug).toBe("allston");
    expect(findArea(AREAS, "back   bay")?.slug).toBe("back-bay");
    expect(findArea(AREAS, "Back Bay, Boston")?.slug).toBe("back-bay");
    expect(findArea(AREAS, "02139")?.slug).toBe("zip-02139");
    expect(findArea(AREAS, "Camb")?.slug).toBe("cambridge");
  });
  it("does not pretend to find street addresses or unknown places", () => {
    expect(findArea(AREAS, "123 Main Street")).toBeUndefined();
    expect(findArea(AREAS, "")).toBeUndefined();
    expect(findArea(AREAS, "Los Angeles")).toBeUndefined();
  });
});

describe("pins and the place panel (R-MAP-05, R-MAP-11)", () => {
  const place = { name: "Demo Central Kitchen", dishCount: 1, distanceM: 120 } as MapPlace;
  it("names the group in words, never by colour alone", () => {
    expect(pinLabel(place, "matches")).toBe("Demo Central Kitchen, 1 dish fits, Under 0.1 mi");
    expect(pinLabel({ ...place, dishCount: 3, distanceM: null }, "needs_confirmation")).toBe("Demo Central Kitchen, 3 dishes need confirmation");
  });
  it("walking time is always labelled a straight-line estimate", () => {
    expect(walkEstimate(null)).toBeNull();
    expect(walkEstimate(30)).toBe("about 1 min walk (straight-line estimate)");
    expect(walkEstimate(800)).toBe("about 10 min walk (straight-line estimate)");
  });
  it("directions carry only the place's position as the destination", () => {
    const links = directionLinks(42.3655, -71.104);
    expect(links.map((l) => l.label)).toEqual(["Apple Maps", "Google Maps", "OpenStreetMap"]);
    for (const l of links) {
      const u = new URL(l.href);
      expect(u.protocol).toBe("https:");
      expect(decodeURIComponent(u.search)).toContain("42.3655,-71.104");
      expect(u.search).not.toMatch(/saddr|origin=|from=/);
    }
  });
});

describe("feature switch (R-MAP-01)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("with MAP_ENABLED off the map search route answers 404 and reads nothing", async () => {
    vi.stubEnv("MAP_ENABLED", "false");
    vi.resetModules();
    const searchMap = vi.fn();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/server/catalog/map", () => ({ searchMap }));
    const { POST } = await import("@/app/api/v1/map/search/route");
    const res = await POST(new Request("http://localhost/api/v1/map/search", { method: "POST", body: JSON.stringify({ area: { kind: "market" } }) }));
    expect(res.status).toBe(404);
    expect(searchMap).not.toHaveBeenCalled();
  });
});
