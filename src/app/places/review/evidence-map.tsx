"use client";
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { PMTiles, Protocol } from "pmtiles";
import { headerFits, plainStyle, streetStyle, PLAIN_CREDIT } from "@/lib/street-style";

/**
 * A small map of where each source puts one place (docs/33). Each pin carries a letter that matches
 * the source cards below the map; the same positions are written out in words there, so nothing on
 * the map is the only way to read the evidence.
 */
maplibregl.setWorkerUrl(`/vendor/maplibre-gl-worker-${maplibregl.getVersion()}.mjs`);
let protocol: Protocol | null = null;
const MARKET_BOX: [number, number, number, number] = [-71.6, 42.0, -70.6, 42.7];

export type EvidencePin = { letter: string; lat: number; lon: number; label: string };

export default function EvidenceMap({ pins, streetUrl }: { pins: EvidencePin[]; streetUrl: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "street" | "plain" | "broken">("loading");
  const key = JSON.stringify(pins);

  useEffect(() => {
    const container = box.current;
    if (!container || pins.length === 0) return;
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    (async () => {
      let style = plainStyle();
      let kind: "street" | "plain" = "plain";
      if (streetUrl) {
        try {
          const url = new URL(streetUrl, window.location.origin).href;
          const archive = new PMTiles(url);
          const header = await Promise.race([archive.getHeader(), new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), 8000))]);
          if (headerFits(header, MARKET_BOX)) {
            if (!protocol) {
              protocol = new Protocol();
              maplibregl.addProtocol("pmtiles", protocol.tile);
            }
            protocol.add(archive);
            style = streetStyle(url, window.location.origin);
            kind = "street";
          }
        } catch {
          /* plain background */
        }
      }
      if (cancelled) return;
      try {
        map = new maplibregl.Map({
          container,
          style,
          center: [pins[0].lon, pins[0].lat],
          zoom: 17,
          maxZoom: 19,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          attributionControl: false,
          localIdeographFontFamily: "sans-serif",
        });
      } catch {
        setState("broken");
        return;
      }
      map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: kind === "plain" ? PLAIN_CREDIT : undefined }), "bottom-right");
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "top-left");
      for (const p of pins) {
        const el = document.createElement("span");
        el.className = "evidence-pin";
        el.textContent = p.letter;
        el.setAttribute("aria-hidden", "true");
        el.title = p.label;
        new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
      }
      if (pins.length > 1) {
        const b = new maplibregl.LngLatBounds();
        for (const p of pins) b.extend([p.lon, p.lat]);
        map.fitBounds(b, { padding: 60, maxZoom: 18, duration: 0 });
      }
      setState(kind);
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, streetUrl]);

  if (state === "broken") return <p className="map-canvas broken evidence-map">The map could not load on this device. The positions are listed below.</p>;
  return (
    <>
      <p className="sr-only">Map with {pins.length === 1 ? "one pin" : `${pins.length} pins`}: {pins.map((p) => `${p.letter ? `pin ${p.letter}, ` : ""}${p.label}`).join("; ")}.</p>
      <div ref={box} className="map-canvas evidence-map" data-background={state === "street" ? "street" : undefined} data-testid="evidence-map" />
    </>
  );
}
