// docs/83: six metropolitan markets, about 25 miles each, in one configuration.
import { describe, expect, it } from "vitest";
import { MARKET_ORDER, MARKETS, marketAt, marketFor, metresBetween } from "@/config/markets";

describe("markets", () => {
  it("lists the six markets, Boston first and the only one open", () => {
    expect(MARKET_ORDER).toEqual(["boston", "new-york", "chicago", "los-angeles", "san-francisco", "dallas"]);
    expect(MARKET_ORDER.filter((s) => MARKETS[s].discovery === "open")).toEqual(["boston"]);
    for (const s of MARKET_ORDER) expect(MARKETS[s].radiusM).toBe(40234);
  });
  it("falls back to the default for a missing or unknown choice, never to a guess", () => {
    expect(marketFor(undefined).slug).toBe("boston");
    expect(marketFor("atlantis").slug).toBe("boston");
    expect(marketFor("__proto__").slug).toBe("boston");
    expect(marketFor("dallas").slug).toBe("dallas");
  });
  it("places a point in the market whose area holds it, or none", () => {
    expect(marketAt({ lon: -71.119, lat: 42.3736 })?.slug).toBe("boston"); // Cambridge
    expect(marketAt({ lon: -122.2711, lat: 37.8044 })?.slug).toBe("san-francisco"); // Oakland
    expect(marketAt({ lon: -97.1081, lat: 32.7357 })?.slug).toBe("dallas"); // Arlington
    expect(marketAt({ lon: -95.3698, lat: 29.7604 })).toBeNull(); // Houston
    expect(Math.round(metresBetween(MARKETS.boston.center, MARKETS["new-york"].center) / 1000)).toBe(306);
  });
});

// docs/84: the import's market areas are the app's markets.
import MARKETS_JSON from "../../scripts/lib/markets.json";
import { areaFor, marketAt as importMarketAt } from "../../scripts/lib/catalog-import-lib.mjs";
import { MARKETS as APP_MARKETS } from "@/config/markets";

describe("import areas match the app's markets", () => {
  it("has the same six centres and radius", () => {
    const json = Object.fromEntries(Object.entries(MARKETS_JSON as Record<string, unknown>).filter(([k]) => !k.startsWith("_")));
    expect(Object.keys(json).sort()).toEqual(Object.keys(APP_MARKETS).sort());
    for (const [slug, m] of Object.entries(APP_MARKETS)) expect(json[slug]).toEqual({ lon: m.center.lon, lat: m.center.lat, radiusM: m.radiusM });
  });
  it("keeps the first Boston box as the default area, and draws a 25-mile circle for a market", () => {
    expect(areaFor().key).toBe("boston-core");
    expect(areaFor().contains({ lat: 42.36, lon: -71.06 })).toBe(true);
    expect(areaFor().contains({ lat: 42.45, lon: -71.06 })).toBe(false); // Malden: outside the first box
    expect(areaFor("boston").contains({ lat: 42.45, lon: -71.06 })).toBe(true); // inside 25 miles
    expect(areaFor("chicago").contains({ lat: 42.0451, lon: -87.6877 })).toBe(true); // Evanston
    expect(areaFor("chicago").contains({ lat: 42.36, lon: -71.06 })).toBe(false);
    expect(() => areaFor("paris")).toThrow(/Unknown import area/);
    expect(importMarketAt({ lat: 37.8044, lon: -122.2711 })).toBe("san-francisco"); // Oakland
    expect(importMarketAt({ lat: 39.74, lon: -104.99 })).toBeNull(); // Denver: no market
  });
});
