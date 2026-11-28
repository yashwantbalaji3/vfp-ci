/**
 * Market configuration. Boston is the first editorial market; nothing in business logic hard-codes it.
 * Six metropolitan markets share one architecture (owner directive 24 Nov 2026 07:19 UTC, part 5; docs/83): each has
 * a centre and an area of about 25 miles (the same figures as public.markets, migration 20261124000100). Only a
 * market whose discovery is "open" shows restaurants; the others say plainly that discovery there is coming.
 */
export type MarketConfig = {
  slug: string;
  name: string;
  /** Short name for buttons and headings. */
  city: string;
  state: string;
  timezone: string;
  center: { lon: number; lat: number };
  radiusM: number;
  discovery: "open" | "coming";
  /** Editorial clusters promoted first (docs/09). */
  clusters: string[];
};

const R25 = 40234;
export const MARKETS: Record<string, MarketConfig> = {
  boston: {
    slug: "boston",
    name: "Boston area",
    city: "Boston",
    state: "MA",
    timezone: "America/New_York",
    center: { lon: -71.0589, lat: 42.3601 },
    radiusM: R25,
    discovery: "open",
    clusters: ["Cambridge · Central–Harvard", "Somerville · Davis–Union", "Boston · Back Bay–Fenway"],
  },
  "new-york": { slug: "new-york", name: "New York City area", city: "New York City", state: "NY", timezone: "America/New_York", center: { lon: -74.006, lat: 40.7128 }, radiusM: R25, discovery: "coming", clusters: [] },
  chicago: { slug: "chicago", name: "Chicago area", city: "Chicago", state: "IL", timezone: "America/Chicago", center: { lon: -87.6298, lat: 41.8781 }, radiusM: R25, discovery: "coming", clusters: [] },
  "los-angeles": { slug: "los-angeles", name: "Los Angeles area", city: "Los Angeles", state: "CA", timezone: "America/Los_Angeles", center: { lon: -118.2437, lat: 34.0522 }, radiusM: R25, discovery: "coming", clusters: [] },
  "san-francisco": { slug: "san-francisco", name: "San Francisco area", city: "San Francisco", state: "CA", timezone: "America/Los_Angeles", center: { lon: -122.4194, lat: 37.7749 }, radiusM: R25, discovery: "coming", clusters: [] },
  dallas: { slug: "dallas", name: "Dallas area", city: "Dallas", state: "TX", timezone: "America/Chicago", center: { lon: -96.797, lat: 32.7767 }, radiusM: R25, discovery: "coming", clusters: [] },
};
export const MARKET_ORDER = ["boston", "new-york", "chicago", "los-angeles", "san-francisco", "dallas"] as const;

export const DEFAULT_MARKET = process.env.DEFAULT_MARKET ?? "boston";

/** The market a stored choice names, or the default when it names none. */
export function marketFor(slug: string | null | undefined): MarketConfig {
  return (slug && Object.hasOwn(MARKETS, slug) ? MARKETS[slug] : null) ?? MARKETS[DEFAULT_MARKET] ?? MARKETS.boston;
}

/** Distance in metres between two points (haversine), for "which market is this place in". */
export function metresBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

/** The market whose area holds a point (the nearest centre when areas overlap), or null outside all six. */
export function marketAt(p: { lon: number; lat: number }): MarketConfig | null {
  let best: { m: MarketConfig; d: number } | null = null;
  for (const m of Object.values(MARKETS)) {
    const d = metresBetween(m.center, p);
    if (d <= m.radiusM && (!best || d < best.d)) best = { m, d };
  }
  return best?.m ?? null;
}
