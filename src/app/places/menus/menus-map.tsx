"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { MapPlace } from "@/contracts/map";

const MapCanvas = dynamic(() => import("../../discover/map-canvas"), {
  ssr: false,
  loading: () => (
    <div className="map-canvas loading" role="status">
      Loading the map…
    </div>
  ),
});

export type MenuPin = { id: string; slug: string; name: string; area: string | null; lat: number; lon: number; meals: number; summary: string };

/** The researched restaurants on the shared map (founder-only preview, docs/59). Same places as the list. */
export function MenusMap({ pins, streetUrl, fitKey }: { pins: MenuPin[]; streetUrl: string | null; fitKey: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const places: MapPlace[] = useMemo(
    () =>
      pins.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        neighborhood: p.area,
        locality: null,
        cuisines: null,
        priceBand: null,
        venueType: "Restaurant",
        lat: p.lat,
        lon: p.lon,
        distanceM: null,
        dishCount: 0,
        dishes: [],
        mine: null,
      })),
    [pins],
  );
  const chosen = pins.find((p) => p.id === selected);
  if (broken) {
    return (
      <p className="callout" role="status" data-testid="menus-map-broken">
        The map could not load on this device. The list has the same restaurants.
      </p>
    );
  }
  return (
    <section aria-label="Map of restaurants with drafted menus" className="stack">
      <p role="status" data-testid="menus-map-count" style={{ margin: 0 }}>
        {pins.length} {pins.length === 1 ? "restaurant" : "restaurants"} on the map.
      </p>
      <div style={{ height: "min(62vh, 520px)", minHeight: 300 }}>
        <MapCanvas
          places={places}
          view="places"
          focus={{ kind: "market" }}
          fitKey={fitKey}
          selectedId={selected}
          hoverId={hover}
          areas={[]}
          streetUrl={streetUrl}
          onSelect={setSelected}
          onHover={setHover}
          onUserMove={() => undefined}
          onUnavailable={() => setBroken(true)}
          onBackground={() => undefined}
        />
      </div>
      {chosen && (
        <div className="post" data-testid="menus-map-selected">
          <strong>
            <Link href={`/places/${chosen.slug}`}>{chosen.name}</Link>
          </strong>
          <p className="s14" style={{ margin: "2px 0 0" }}>
            {chosen.summary}
          </p>
        </div>
      )}
      <ul className="s14" style={{ margin: 0, paddingLeft: 20 }} aria-label="Restaurants on the map">
        {pins.map((p) => (
          <li key={p.id}>
            <Link href={`/places/${p.slug}`}>{p.name}</Link>: {p.summary}
          </li>
        ))}
      </ul>
    </section>
  );
}
