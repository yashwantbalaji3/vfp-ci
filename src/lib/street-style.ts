import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";

/**
 * Map styles (MAP-1.1).
 *
 * Street style: OpenStreetMap streets, water, parks and names from our own street-map file, drawn
 * with the Protomaps "light" design (BSD-3 code, CC0 design), muted so the restaurant pins stay
 * the strongest thing on screen (docs/19). Fonts and icons come from this site
 * (`public/maps/assets/`, OFL and MIT, see the notices there). Nothing is fetched from elsewhere.
 *
 * Plain style: the MAP-1 background, kept as the fallback whenever the street map is not
 * configured or cannot load.
 */
export const STREET_SOURCE = "protomaps";
export const STREET_CREDIT =
  '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
export const PLAIN_CREDIT = "Demo map: plain background, no street map. Neighbourhood names are at approximate positions.";
export const PLAIN_BACKGROUND = "#eef0e8";

/** Layers left out: OpenStreetMap shops and restaurants (they would compete with, and could be
 *  mistaken for, our checked places) and one-way arrows (clutter at our zooms). */
const LEFT_OUT = new Set(["pois", "roads_oneway"]);

function mutedFlavor(): Flavor {
  const f = namedFlavor("light");
  return {
    ...f,
    background: "#f3f1ea",
    earth: "#f3f1ea",
    park_a: "#e1ebd9",
    park_b: "#dbe7d2",
    wood_a: "#e1ebd9",
    wood_b: "#dbe7d2",
    water: "#cfdfe6",
    buildings: "#e7e3da",
    pedestrian: "#efede6",
    roads_label_minor: "#6b6b6b",
    roads_label_major: "#555555",
    subplace_label: "#5d6b62",
    city_label: "#3f4a43",
  };
}

export function streetStyle(tilesUrl: string, origin: string): StyleSpecification {
  return {
    version: 8,
    glyphs: `${origin}/maps/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/maps/assets/sprites/v4/light`,
    sources: {
      [STREET_SOURCE]: { type: "vector", url: `pmtiles://${tilesUrl}`, attribution: STREET_CREDIT },
    },
    layers: layers(STREET_SOURCE, mutedFlavor(), { lang: "en" }).filter((l) => !LEFT_OUT.has(l.id)),
  };
}

export function plainStyle(): StyleSpecification {
  return {
    version: 8,
    // Nothing to fetch. The map shows PLAIN_CREDIT as its credit line with this style.
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": PLAIN_BACKGROUND } }],
  };
}

/** The street-map file must be vector tiles covering part of the market, or it is not used. */
export function headerFits(h: { tileType: number; minLon: number; minLat: number; maxLon: number; maxLat: number; maxZoom: number }, market: [number, number, number, number]) {
  const [w, s, e, n] = market;
  return h.tileType === 1 && h.maxZoom >= 12 && h.minLon < e && h.maxLon > w && h.minLat < n && h.maxLat > s;
}
