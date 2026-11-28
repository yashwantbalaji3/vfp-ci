"use client";
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import type { MapArea, MapPlace } from "@/contracts/map";
import { pinLabel } from "@/lib/map-text";
import { headerFits, plainStyle, streetStyle, PLAIN_CREDIT, STREET_SOURCE } from "@/lib/street-style";

/**
 * The map itself (MAP-1, MAP-1.1). Loaded only when someone opens Map view (R-MAP-01, T-MAP 17):
 * this file, MapLibre and the street-map reader are a separate download the List never asks for.
 *
 * Background: the Boston street map when the server has a street-map file (served by this app at
 * /map-data/streets; OpenStreetMap data, credited on the map), otherwise the plain MAP-1
 * background. If the street map cannot load, the plain background takes over and says so.
 *
 * Pins and cluster bubbles are real buttons, so they work with a keyboard and a screen reader.
 * Nearby places merge into one numbered bubble when zoomed out (MapLibre's own clustering);
 * places at the same spot are spread side by side once zoomed in.
 */
maplibregl.setWorkerUrl(`/vendor/maplibre-gl-worker-${maplibregl.getVersion()}.mjs`);
let protocol: Protocol | null = null;
function streetProtocol() {
  if (!protocol) {
    protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
  }
  return protocol;
}

export type MapBounds = { west: number; south: number; east: number; north: number };
export type MapFocus =
  | { kind: "radius"; lat: number; lon: number; radiusM: number; radiusText: string }
  | { kind: "box"; west: number; south: number; east: number; north: number }
  | { kind: "market" };

const BOSTON: [number, number] = [-71.0589, 42.3601];
/** The market's rough extent; a street-map file must overlap it to be used. */
const MARKET_BOX: [number, number, number, number] = [-71.6, 42.0, -70.6, 42.7];
const CLUSTER_MAX_ZOOM = 14;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function circle(lat: number, lon: number, meters: number) {
  const points: [number, number][] = [];
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    points.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [points] } };
}

type Entry = { marker: maplibregl.Marker; el: HTMLButtonElement };
type Background = "street" | "plain";

export default function MapCanvas({
  places,
  view,
  focus,
  fitKey,
  selectedId,
  hoverId,
  areas,
  streetUrl,
  onSelect,
  onHover,
  onUserMove,
  onUnavailable,
  onBackground,
}: {
  places: MapPlace[];
  view: string;
  focus: MapFocus;
  fitKey: string;
  selectedId: string | null;
  hoverId: string | null;
  areas: MapArea[];
  streetUrl: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onUserMove: (b: MapBounds) => void;
  onUnavailable: () => void;
  onBackground: (b: Background, failed: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pins = useRef<Map<string, Entry>>(new Map());
  const bubbles = useRef<Map<number, Entry & { leaves: Set<string> | null }>>(new Map());
  const radiusMarks = useRef<maplibregl.Marker[]>([]);
  const markRef = useRef<() => void>(() => undefined);
  // A counter bumped every time our own layers are (re)added, after the first style or a fallback.
  const [styleGen, setStyleGen] = useState(0);
  const [background, setBackground] = useState<Background | null>(null);
  const ready = styleGen > 0;
  const latest = useRef({ places, view, focus, selectedId, hoverId });
  const handlers = useRef({ onSelect, onHover, onUserMove, onUnavailable, onBackground });
  useEffect(() => {
    handlers.current = { onSelect, onHover, onUserMove, onUnavailable, onBackground };
    latest.current = { places, view, focus, selectedId, hoverId };
  });

  // Create the map once, after deciding which background to use.
  useEffect(() => {
    const container = box.current;
    if (!container) return;
    let cancelled = false;
    let map: maplibregl.Map | null = null;

    async function chooseStyle(): Promise<{ style: maplibregl.StyleSpecification; kind: Background; failed: boolean }> {
      if (!streetUrl) return { style: plainStyle(), kind: "plain", failed: false };
      try {
        const url = new URL(streetUrl, window.location.origin).href;
        const archive = new PMTiles(url);
        const header = await Promise.race([
          archive.getHeader(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
        ]);
        if (!headerFits(header, MARKET_BOX)) throw new Error("street map does not cover this market");
        streetProtocol().add(archive);
        return { style: streetStyle(url, window.location.origin), kind: "street", failed: false };
      } catch {
        return { style: plainStyle(), kind: "plain", failed: true };
      }
    }

    void chooseStyle().then(({ style, kind, failed }) => {
      if (cancelled) return;
      try {
        map = new maplibregl.Map({
          container,
          style,
          center: BOSTON,
          zoom: 11.5,
          minZoom: 9,
          maxZoom: 18,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          // Added below, so its wording can follow the background in use.
          attributionControl: false,
          // Chinese, Japanese and Korean names are drawn with the device's own font, never fetched.
          localIdeographFontFamily: "sans-serif",
        });
      } catch {
        handlers.current.onUnavailable();
        return;
      }
      const m = map;
      mapRef.current = m;
      let current: Background = kind;
      setBackground(kind);
      handlers.current.onBackground(kind, failed);
      m.touchZoomRotate.disableRotation();
      m.keyboard.disableRotation();
      // The credit: Protomaps and OpenStreetMap on the street map (from the map source), the honest
      // "plain background" sentence otherwise. Always shown in full, never collapsed (docs/21).
      let credit = new maplibregl.AttributionControl({ compact: false, customAttribution: kind === "plain" ? PLAIN_CREDIT : undefined });
      m.addControl(credit, "bottom-right");
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      m.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "top-left");
      m.addControl(new ShowAllControl(() => fitToPlaces(m, latest.current.places, false)), "top-right");

      // Our own layers go on top of whichever background is in use, again after a fallback.
      m.on("style.load", () => {
        m.addSource("area", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        m.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#254d38", "fill-opacity": 0.07 } });
        m.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#254d38", "line-width": 2, "line-dasharray": [2, 2] } });
        m.addSource("places", { type: "geojson", data: { type: "FeatureCollection", features: [] }, cluster: true, clusterMaxZoom: CLUSTER_MAX_ZOOM, clusterRadius: 44 });
        // Invisible: keeps the clustered data computed so the bubbles and pins can be drawn as buttons.
        m.addLayer({ id: "places-hidden", type: "circle", source: "places", paint: { "circle-radius": 0, "circle-opacity": 0 } });
        setStyleGen((g) => g + 1);
      });

      // If the street map fails while in use, fall back to the plain background once.
      let streetLoaded = false;
      let streetErrors = 0;
      m.on("sourcedata", (e: maplibregl.MapSourceDataEvent) => {
        if (e.sourceId === STREET_SOURCE && e.isSourceLoaded) streetLoaded = true;
      });
      m.on("error", (e) => {
        if (current !== "street" || (e as unknown as { sourceId?: string }).sourceId !== STREET_SOURCE) return;
        streetErrors += 1;
        if (!streetLoaded || streetErrors >= 5) {
          current = "plain";
          setBackground("plain");
          handlers.current.onBackground("plain", true);
          m.setStyle(plainStyle(), { diff: false });
          m.removeControl(credit);
          credit = new maplibregl.AttributionControl({ compact: false, customAttribution: PLAIN_CREDIT });
          m.addControl(credit, "bottom-right");
        }
      });

      // Only a move the person made offers "Search this area"; moves made by the app do not (R-MAP-09).
      m.on("moveend", (e: { originalEvent?: unknown }) => {
        if (!e.originalEvent) return;
        const b = m.getBounds();
        handlers.current.onUserMove({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
      });
      const far = () => {
        container.classList.toggle("far", m.getZoom() < 12);
        container.dataset.zoom = m.getZoom().toFixed(2);
      };
      m.on("zoom", far);
      far();
    });

    const pinMap = pins.current;
    const bubbleMap = bubbles.current;
    return () => {
      cancelled = true;
      pinMap.clear();
      bubbleMap.clear();
      map?.remove();
      mapRef.current = null;
    };
    // The street-map address is fixed for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Neighbourhood names at approximate centres, only on the plain background (the street map has its own).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleGen || background !== "plain") return;
    const labels = areas
      .filter((a) => a.kind === "neighborhood")
      .map((a) => {
        const el = document.createElement("div");
        el.className = "area-label";
        el.setAttribute("aria-hidden", "true");
        el.textContent = a.name;
        return new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).addTo(map);
      });
    return () => labels.forEach((m) => m.remove());
  }, [areas, styleGen, background]);

  // The search area: a circle with a centre dot and its distance written on its edge.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleGen) return;
    (map.getSource("area") as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: focus.kind === "radius" ? [circle(focus.lat, focus.lon, focus.radiusM)] : [],
    });
    radiusMarks.current.forEach((m) => m.remove());
    radiusMarks.current = [];
    if (focus.kind === "radius") {
      const dot = document.createElement("div");
      dot.className = "radius-centre";
      dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("div");
      label.className = "radius-label";
      label.setAttribute("aria-hidden", "true");
      label.dataset.testid = "radius-label";
      label.textContent = focus.radiusText;
      const north = focus.lat + focus.radiusM / 111_320;
      radiusMarks.current = [
        new maplibregl.Marker({ element: dot }).setLngLat([focus.lon, focus.lat]).addTo(map),
        new maplibregl.Marker({ element: label, anchor: "bottom" }).setLngLat([focus.lon, north]).addTo(map),
      ];
    }
  }, [focus, styleGen]);

  // The places go into the clustered source; the visible bubbles and pins are redrawn as buttons.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleGen) return;
    const source = map.getSource("places") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    void source.setData({
      type: "FeatureCollection",
      features: places.map((p) => ({ type: "Feature" as const, properties: { id: p.id }, geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] } })),
    });
    // The bubble contents depend on the data; forget them so they are looked up again.
    for (const b of bubbles.current.values()) b.leaves = null;
  }, [places, styleGen]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleGen) return;
    const m = map;
    const byId = new Map(places.map((p) => [p.id, p]));
    let frame = 0;

    function draw() {
      frame = 0;
      const source = m.getSource("places") as maplibregl.GeoJSONSource | undefined;
      if (!source || !m.isSourceLoaded("places")) return;
      const v = latest.current.view;
      const seenPins = new Set<string>();
      const seenBubbles = new Set<number>();
      const singles: { id: string; lngLat: [number, number] }[] = [];
      for (const f of m.querySourceFeatures("places")) {
        const props = f.properties as { cluster?: boolean; cluster_id?: number; point_count?: number; id?: string };
        const coords = (f.geometry as { coordinates: number[] }).coordinates.slice(0, 2) as [number, number];
        if (props.cluster && typeof props.cluster_id === "number") {
          if (seenBubbles.has(props.cluster_id)) continue;
          seenBubbles.add(props.cluster_id);
          let b = bubbles.current.get(props.cluster_id);
          if (!b) {
            const el = document.createElement("button");
            el.type = "button";
            el.className = "map-bubble";
            el.dataset.testid = "map-bubble";
            const clusterId = props.cluster_id;
            el.addEventListener("click", (ev) => {
              ev.stopPropagation();
              void source.getClusterExpansionZoom(clusterId).then((zoom) => {
                m.easeTo({ center: coords, zoom: Math.min(zoom + 0.5, 18), duration: reducedMotion() ? 0 : 400 });
              });
            });
            b = { marker: new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat(coords).addTo(m), el, leaves: null };
            bubbles.current.set(clusterId, b);
          }
          const count = props.point_count ?? 0;
          b.el.classList.toggle("unsure", v !== "matches");
          b.el.dataset.count = String(count);
          b.el.setAttribute(
            "aria-label",
            `${count} places with dishes that ${v === "matches" ? "fit" : "need confirmation"}. Press to zoom in and see them.`,
          );
          b.el.innerHTML = `<span aria-hidden="true">${count}</span>`;
          b.marker.setLngLat(coords);
          if (b.leaves === null) {
            const entry = b;
            void source.getClusterLeaves(props.cluster_id, Infinity, 0).then((leaves) => {
              entry.leaves = new Set(leaves.map((l) => String((l.properties as { id: string }).id)));
              mark();
            }).catch(() => undefined);
          }
        } else if (props.id && !seenPins.has(props.id)) {
          seenPins.add(props.id);
          singles.push({ id: props.id, lngLat: coords });
        }
      }

      // Places at the same spot (or within a pin's width) are spread side by side.
      const groups: { at: maplibregl.Point; ids: string[] }[] = [];
      for (const s of singles) {
        const at = m.project(s.lngLat);
        const g = groups.find((x) => Math.abs(x.at.x - at.x) < 30 && Math.abs(x.at.y - at.y) < 30);
        if (g) g.ids.push(s.id);
        else groups.push({ at, ids: [s.id] });
      }
      const offsets = new Map<string, [number, number]>();
      for (const g of groups) g.ids.forEach((id, i) => offsets.set(id, [(i - (g.ids.length - 1) / 2) * 40, 0]));

      for (const s of singles) {
        const place = byId.get(s.id);
        if (!place) continue;
        let entry = pins.current.get(s.id);
        if (!entry) {
          const el = document.createElement("button");
          el.type = "button";
          el.dataset.placeId = s.id;
          el.addEventListener("click", (ev) => {
            ev.stopPropagation();
            handlers.current.onSelect(s.id);
          });
          el.addEventListener("mouseenter", () => handlers.current.onHover(s.id));
          el.addEventListener("mouseleave", () => handlers.current.onHover(null));
          el.addEventListener("focus", () => handlers.current.onHover(s.id));
          el.addEventListener("blur", () => handlers.current.onHover(null));
          entry = { marker: new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([place.lon, place.lat]).addTo(m), el };
          pins.current.set(s.id, entry);
        }
        entry.marker.setLngLat([place.lon, place.lat]);
        entry.marker.setOffset(offsets.get(s.id) ?? [0, 0]);
        // Shape and words differ by group, never colour alone (R-MAP-11).
        // classList, not className: MapLibre's own marker classes (which position the pin) must stay.
        entry.el.classList.add("map-pin");
        entry.el.classList.toggle("fits", v === "matches");
        entry.el.classList.toggle("unsure", v !== "matches" && v !== "places");
        // Real places (docs/36): identity only, so the pin carries no dish count.
        entry.el.classList.toggle("real", v === "places");
        entry.el.setAttribute("aria-label", pinLabel(place, v));
        entry.el.dataset.testid = "map-pin";
        // MAP-2: a small clock mark when the place is not confirmed open; the words are in the label.
        entry.el.dataset.hours = v === "places" ? "none" : (place.hours?.state ?? "unknown");
        entry.el.innerHTML = `<span aria-hidden="true">${v === "places" ? "" : v === "matches" ? place.dishCount : "?"}</span>`;
      }
      for (const [id, entry] of pins.current) {
        if (!seenPins.has(id)) {
          entry.marker.remove();
          pins.current.delete(id);
        }
      }
      for (const [id, entry] of bubbles.current) {
        if (!seenBubbles.has(id)) {
          entry.marker.remove();
          bubbles.current.delete(id);
        }
      }
      mark();
    }

    function mark() {
      const { selectedId: sel, hoverId: hov } = latest.current;
      for (const [id, { el }] of pins.current) {
        el.classList.toggle("selected", id === sel);
        el.classList.toggle("hover", id === hov && id !== sel);
        el.setAttribute("aria-pressed", id === sel ? "true" : "false");
      }
      for (const b of bubbles.current.values()) {
        b.el.classList.toggle("selected", !!sel && !!b.leaves?.has(sel));
        b.el.classList.toggle("hover", !!hov && !!b.leaves?.has(hov));
      }
    }

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const onData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === "places") schedule();
    };
    m.on("sourcedata", onData);
    m.on("moveend", schedule);
    m.on("zoomend", schedule);
    schedule();
    markRef.current = mark;
    return () => {
      m.off("sourcedata", onData);
      m.off("moveend", schedule);
      m.off("zoomend", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [places, view, styleGen]);

  useEffect(() => {
    markRef.current();
  }, [selectedId, hoverId]);

  // A place chosen in the list is brought into view and out of its bubble.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleGen || !selectedId) return;
    const place = latest.current.places.find((p) => p.id === selectedId);
    if (!place) return;
    const inView = map.getBounds().contains([place.lon, place.lat]);
    const zoom = Math.max(map.getZoom(), CLUSTER_MAX_ZOOM + 1);
    if (!inView || !pins.current.has(selectedId) || map.getZoom() <= CLUSTER_MAX_ZOOM) {
      map.easeTo({ center: [place.lon, place.lat], zoom, duration: reducedMotion() ? 0 : 400 });
    }
  }, [selectedId, styleGen]);

  // Move the view after a new search, never by itself after the person moved the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleGen) return;
    const opts = { padding: { top: 50, bottom: 90, left: 40, right: 60 }, duration: 0, maxZoom: 15 };
    if (focus.kind === "radius") {
      const c = circle(focus.lat, focus.lon, focus.radiusM).geometry.coordinates[0];
      const lons = c.map((p) => p[0]);
      const lats = c.map((p) => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], opts);
    } else if (focus.kind === "box") {
      // The person chose this view by moving the map; leave it as it is.
    } else {
      fitToPlaces(map, places, true);
    }
    // fitKey changes once per completed search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  return (
    <div
      ref={box}
      // Fixed class: MapLibre adds its own classes to this element, which a changing className would wipe.
      className="map-canvas"
      data-testid="map-canvas"
      data-background={background ?? "loading"}
      role="region"
      aria-label="Map of the places in the results. Arrow keys move the map; plus and minus zoom. Numbered bubbles group nearby places: press one to zoom in. The list beside the map has the same places."
    />
  );
}

function fitToPlaces(map: maplibregl.Map, places: MapPlace[], instant: boolean) {
  if (places.length === 0) return;
  const lons = places.map((p) => p.lon);
  const lats = places.map((p) => p.lat);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
    padding: { top: 50, bottom: 90, left: 40, right: 60 },
    duration: instant || reducedMotion() ? 0 : 400,
    maxZoom: 15,
  });
}

/** A map control: "Show all places" fits every place in the current results. */
class ShowAllControl implements maplibregl.IControl {
  private box: HTMLDivElement | null = null;
  constructor(private readonly onPress: () => void) {}
  onAdd() {
    const box = document.createElement("div");
    box.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "map-show-all";
    b.title = "Show all places";
    b.setAttribute("aria-label", "Show all places in the results");
    b.innerHTML = '<span aria-hidden="true">⤢</span>';
    b.addEventListener("click", this.onPress);
    box.appendChild(b);
    this.box = box;
    return box;
  }
  onRemove() {
    this.box?.remove();
    this.box = null;
  }
}
