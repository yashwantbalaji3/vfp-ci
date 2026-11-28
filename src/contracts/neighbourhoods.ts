/**
 * Neighbourhood shortcuts for real meals (owner direction 20 Nov 2026 21:20 UTC, item 2; docs/64), widened to the
 * owner's seven Boston priority areas on 27 Nov 2026 and to the charter's twelve on 28 Nov 2026. A place belongs to a neighbourhood when the catalog's own area
 * label starts with one of its names (the label comes from the listing's address, app.boston_area()), or, for a place the
 * catalog gives no area, when it lies close to the neighbourhood's centre.
 *
 * Distance is straight-line from the neighbourhood's centre (a named landmark), never the person's location,
 * so nothing about where the person is leaves their browser or lands in an address.
 */

export type Hood = { key: string; label: string; areaPrefixes: readonly string[]; centre: string; lat: number; lon: number; fallbackM: number };

/** The owner's twelve Boston areas (charter 28 Nov 2026 00:32 UTC, section 3), in the charter's order. Keys are stable URL values. */
export const HOODS: readonly Hood[] = [
  { key: "fenway", label: "Fenway & Kenmore", areaPrefixes: ["Fenway"], centre: "Kenmore Square", lat: 42.3489, lon: -71.0951, fallbackM: 1000 },
  { key: "back-bay", label: "Back Bay", areaPrefixes: ["Back Bay"], centre: "Copley Square", lat: 42.3499, lon: -71.0778, fallbackM: 1000 },
  { key: "downtown", label: "Downtown & Chinatown", areaPrefixes: ["Downtown"], centre: "Downtown Crossing", lat: 42.3555, lon: -71.0605, fallbackM: 900 },
  { key: "cambridge", label: "Cambridge & Somerville", areaPrefixes: ["Cambridge", "Somerville"], centre: "Central Square", lat: 42.3651, lon: -71.1036, fallbackM: 2500 },
  { key: "allston-brighton", label: "Allston & Brighton", areaPrefixes: ["Allston"], centre: "Packard's Corner", lat: 42.3518, lon: -71.1316, fallbackM: 1800 },
  { key: "brookline", label: "Brookline", areaPrefixes: ["Brookline"], centre: "Coolidge Corner", lat: 42.342, lon: -71.1212, fallbackM: 1500 },
  { key: "south-end", label: "South End", areaPrefixes: ["South End"], centre: "Blackstone Square", lat: 42.3405, lon: -71.0742, fallbackM: 800 },
  { key: "south-boston-seaport", label: "South Boston & Seaport", areaPrefixes: ["South Boston"], centre: "Broadway station", lat: 42.3426, lon: -71.057, fallbackM: 1500 },
  { key: "beacon-hill-west-end", label: "Beacon Hill & West End", areaPrefixes: ["Beacon Hill"], centre: "Charles/MGH station", lat: 42.3612, lon: -71.0706, fallbackM: 700 },
  { key: "mission-hill-longwood", label: "Mission Hill & Longwood", areaPrefixes: ["Mission Hill"], centre: "Brigham Circle", lat: 42.3343, lon: -71.1048, fallbackM: 900 },
  { key: "jamaica-plain-roxbury", label: "Jamaica Plain & Roxbury", areaPrefixes: ["Jamaica Plain", "Roxbury"], centre: "Jackson Square station", lat: 42.3232, lon: -71.0997, fallbackM: 2000 },
  { key: "east-boston-charlestown", label: "East Boston & Charlestown", areaPrefixes: ["East Boston", "Charlestown"], centre: "Maverick Square", lat: 42.3691, lon: -71.0395, fallbackM: 1500 },
];

export const WITHIN = [
  { key: "0.5", label: "0.5 mile", meters: 805 },
  { key: "1", label: "1 mile", meters: 1609 },
  { key: "2", label: "2 miles", meters: 3219 },
] as const;

export const hoodByKey = (k: string | undefined): Hood | null => HOODS.find((h) => h.key === k) ?? null;
export const withinByKey = (k: string | undefined) => WITHIN.find((w) => w.key === k) ?? null;

/** Straight-line distance in metres (haversine). */
export function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether an address-based area label belongs to a neighbourhood ("Roxbury" yes, "West Roxbury" no). */
export const areaInHood = (area: string, hood: Hood): boolean => hood.areaPrefixes.some((p) => area.startsWith(p));

/** The position of an area's neighbourhood in HOODS, or HOODS.length when it is in none of the twelve. */
export const hoodRank = (area: string): number => {
  const i = HOODS.findIndex((h) => areaInHood(area, h));
  return i < 0 ? HOODS.length : i;
};

export function inHood(place: { area: string | null; lat: number; lon: number }, hood: Hood): boolean {
  if (place.area) return areaInHood(place.area, hood);
  return metersBetween(place, hood) <= hood.fallbackM;
}

/** "0.4 mi" style, to one decimal, never below 0.1. */
export function miles(m: number): string {
  return `${Math.max(0.1, Math.round((m / 1609.344) * 10) / 10).toFixed(1)} mi`;
}
