import { hoursWords } from "@/lib/hours-words";
import type { MapArea, MapPlace } from "@/contracts/map";
import { formatDistance } from "@/lib/format";

/** Small, pure helpers for the MAP-1 screens (kept here so they can be unit tested without a browser). */

/** Finds a neighbourhood, city or ZIP code by what the person typed. Street addresses are not supported (M-5). */
export function findArea(areas: MapArea[], text: string): MapArea | undefined {
  const q = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return undefined;
  const bare = q.replace(/,.*$/, "").trim();
  return (
    areas.find((a) => a.name.toLowerCase() === q || a.name.toLowerCase() === bare || a.slug === q) ??
    areas.find((a) => `${a.name}, ${a.context ?? ""}`.toLowerCase() === q) ??
    areas.find((a) => a.name.toLowerCase().startsWith(bare))
  );
}

/** What a screen reader hears for a pin: name, group in words, distance (R-MAP-11). */
export function pinLabel(place: MapPlace, view: string) {
  // Real places (docs/36) are identity only: no dish count, and the menu is not checked yet.
  if (view === "places") return [place.name, place.venueType, "menu not checked yet", formatDistance(place.distanceM)].filter(Boolean).join(", ");
  const n = place.dishCount;
  const what = view === "matches" ? `${n} ${n === 1 ? "dish fits" : "dishes fit"}` : `${n} ${n === 1 ? "dish needs" : "dishes need"} confirmation`;
  // MAP-2: the opening status in words, when the database gave one.
  // "Closes soon" always carries the exact closing time (MAP2-B).
  const w = place.hours ? hoursWords(place.hours) : null;
  const hours = w ? (place.hours?.closesSoon && w.detail ? `${w.label}, ${w.detail.toLowerCase()}` : w.label) : null;
  return [place.name, what, hours, formatDistance(place.distanceM)].filter(Boolean).join(", ");
}

/** About 80 metres a minute; always shown as an estimate along a straight line (R-MAP-05). */
export function walkEstimate(meters: number | null): string | null {
  if (meters === null) return null;
  const minutes = Math.max(1, Math.round(meters / 80));
  return `about ${minutes} min walk (straight-line estimate)`;
}

/**
 * Directions open the person's own maps app or site with this place's position as the
 * destination only. Nothing about the person is added to the link.
 */
export function directionLinks(lat: number, lon: number) {
  const to = `${lat},${lon}`;
  return [
    { label: "Apple Maps", href: `https://maps.apple.com/?daddr=${encodeURIComponent(to)}` },
    { label: "Google Maps", href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(to)}` },
    { label: "OpenStreetMap", href: `https://www.openstreetmap.org/directions?route=%3B${encodeURIComponent(to)}` },
  ];
}
