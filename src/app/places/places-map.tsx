"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MapPlace } from "@/contracts/map";
import { IDENTITY_WORDS, type PlaceMap, type PlacePin } from "@/contracts/places";
import type { MapBounds, MapFocus } from "../discover/map-canvas";

const MapCanvas = dynamic(() => import("../discover/map-canvas"), {
  ssr: false,
  loading: () => (
    <div className="map-canvas loading" role="status">
      Loading the map…
    </div>
  ),
});

/** A real place shaped for the shared map: identity only, no dishes. */
function asMapPlace(p: PlacePin): MapPlace {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    neighborhood: p.area,
    locality: null,
    cuisines: null,
    priceBand: null,
    venueType: p.category,
    lat: p.lat,
    lon: p.lon,
    distanceM: p.distanceM,
    dishCount: 0,
    dishes: [],
    mine: null,
  };
}

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: PlaceMap; key: string };

/**
 * Map view of real places (docs/36). It asks for exactly the same search and area as the list, so the
 * map and the list show the same places. Moving the map offers "Search this area"; the rectangle is
 * sent in a request body, rounded, and not kept.
 */
export function PlacesMap({ q, area, kind, checked, cuisine, possible, streetUrl }: { q?: string; area?: string; kind?: string; checked?: boolean; cuisine?: string; possible?: boolean; streetUrl: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [box, setBox] = useState<MapBounds | null>(null);
  const [moved, setMoved] = useState<MapBounds | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  const load = useCallback(
    async (b: MapBounds | null) => {
      setState({ kind: "loading" });
      try {
        const res = await fetch("/api/v1/places/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ q: q || undefined, area: area || undefined, kind: kind || undefined, checked: checked || undefined, cuisine: cuisine || undefined, possible: possible || undefined, box: b ?? undefined, mode: "map" }),
        });
        if (!res.ok) throw new Error("search failed");
        const body = (await res.json()) as { data: PlaceMap };
        setState({ kind: "ready", data: body.data, key: `${q}|${area}|${kind}|${checked}|${cuisine}|${possible}|${JSON.stringify(b)}|${Date.now()}` });
      } catch {
        setState({ kind: "error" });
      }
    },
    [q, area, kind, checked, cuisine, possible],
  );

  useEffect(() => {
    // Loading after the first paint is this component's whole job.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null);
  }, [load]);

  const places = useMemo(() => (state.kind === "ready" ? state.data.items.map(asMapPlace) : []), [state]);
  const focus: MapFocus = box ? { kind: "box", ...box } : { kind: "market" };
  const chosen = state.kind === "ready" ? state.data.items.find((p) => p.id === selected) : undefined;

  if (broken) {
    return (
      <p className="callout" role="status" data-testid="places-map-broken">
        The map could not load on this device. The list has the same places.
      </p>
    );
  }
  return (
    <section aria-label="Map of real places" className="stack">
      <p role="status" aria-live="polite" data-testid="places-map-count" style={{ margin: 0 }}>
        {state.kind === "loading" && "Finding places…"}
        {state.kind === "error" && "We couldn't load the map's places just now."}
        {state.kind === "ready" &&
          (state.data.items.length < state.data.total
            ? `Showing ${state.data.items.length} of ${state.data.total} places. Zoom in and search this area to see the rest, or use the list.`
            : `${state.data.total} ${state.data.total === 1 ? "place" : "places"} on the map${box ? " in this area" : ""}.`)}
      </p>
      <div style={{ height: "min(62vh, 520px)", minHeight: 300 }}>
        <MapCanvas
          places={places}
          view="places"
          focus={focus}
          fitKey={state.kind === "ready" ? state.key : "loading"}
          selectedId={selected}
          hoverId={hover}
          areas={[]}
          streetUrl={streetUrl}
          onSelect={setSelected}
          onHover={setHover}
          onUserMove={setMoved}
          onUnavailable={() => setBroken(true)}
          onBackground={() => undefined}
        />
      </div>
      {moved && (
        <p style={{ margin: 0 }}>
          <button
            type="button"
            className="btn"
            data-testid="places-search-area"
            onClick={() => {
              setBox(moved);
              setMoved(null);
              void load(moved);
            }}
          >
            Search this area
          </button>
          {box && (
            <button
              type="button"
              className="btn"
              style={{ marginLeft: 8 }}
              onClick={() => {
                setBox(null);
                setMoved(null);
                void load(null);
              }}
            >
              Show all
            </button>
          )}
        </p>
      )}
      {chosen ? (
        <div className="post" data-testid="places-map-selected" aria-live="polite">
          <div className="head">
            <h3 style={{ margin: 0, fontSize: 16, overflowWrap: "anywhere" }}>
              <Link href={`/places/${chosen.slug}`}>{chosen.name}</Link>
            </h3>
            <span className="badge wait">Menu not checked yet</span>
          </div>
          <p style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>
            {chosen.category} · {chosen.street}
            {chosen.area ? ` · ${chosen.area}` : ""}
          </p>
          <p className="s14 muted" style={{ margin: "4px 0 0" }}>
            {IDENTITY_WORDS[chosen.identityBasis]}.
          </p>
        </div>
      ) : (
        <p className="s14 muted" style={{ margin: 0 }}>
          Choose a pin to see the place. Numbered bubbles group nearby places: choose one to zoom in.
        </p>
      )}
    </section>
  );
}
