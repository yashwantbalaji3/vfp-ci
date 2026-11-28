"use client";
import { useState } from "react";
import type { PlaceDirectory } from "@/contracts/places";
import { PlaceCard } from "@/components/place-card";

const RADII = [
  { label: "0.25 mile", meters: 402 },
  { label: "0.5 mile", meters: 805 },
  { label: "1 mile", meters: 1609 },
  { label: "3 miles", meters: 4828 },
] as const;

type State = { kind: "idle" } | { kind: "working" } | { kind: "message"; text: string } | { kind: "results"; data: PlaceDirectory };

/**
 * Optional "near me" for real places (docs/36). Location is asked for only when the person presses the
 * button, rounded to about 100 m, sent once in a request body and not kept. Choosing an area always
 * works without it.
 */
export function PlacesNearMe({ q, area, kind, checked, cuisine, possible }: { q?: string; area?: string; kind?: string; checked?: boolean; cuisine?: string; possible?: boolean }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [radius, setRadius] = useState<number>(805);

  function search() {
    if (!("geolocation" in navigator)) {
      setState({ kind: "message", text: "This browser can't share a location. Choose an area instead." });
      return;
    }
    setState({ kind: "working" });
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const round = (n: number) => Math.round(n * 1000) / 1000;
          const res = await fetch("/api/v1/places/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ q: q || undefined, area: area || undefined, kind: kind || undefined, checked: checked || undefined, cuisine: cuisine || undefined, possible: possible || undefined, near: { lat: round(pos.coords.latitude), lon: round(pos.coords.longitude), radiusM: radius }, mode: "list" }),
          });
          if (res.status === 429) return setState({ kind: "message", text: "Too many searches in a short time. Please wait a minute and try again." });
          if (!res.ok) throw new Error("near failed");
          const body = (await res.json()) as { data: PlaceDirectory };
          if (body.data.total === 0) {
            const label = RADII.find((r) => r.meters === radius)?.label ?? "that distance";
            return setState({ kind: "message", text: `No real places within ${label} of you. We cover the Boston area only. Try a wider distance or choose an area.` });
          }
          setState({ kind: "results", data: body.data });
        } catch {
          setState({ kind: "message", text: "We couldn't search near you just now. Please try again, or choose an area." });
        }
      },
      () => setState({ kind: "message", text: "Location is off, and that's fine. Choose an area instead." }),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }

  return (
    <section aria-label="Near me" className="stack">
      <div className="row" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn" onClick={search} disabled={state.kind === "working"} data-testid="places-near-me">
          {state.kind === "working" ? "Finding places near you…" : "Use my location"}
        </button>
        <label htmlFor="places-radius" className="s14" style={{ margin: 0 }}>
          Within
        </label>
        <select id="places-radius" value={radius} onChange={(e) => setRadius(Number(e.target.value))} style={{ width: "auto" }}>
          {RADII.map((r) => (
            <option key={r.meters} value={r.meters}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <p className="s14 muted" style={{ margin: 0 }}>
        Your location is used once for this search, rounded to about 100 m, and not kept.
      </p>
      <div role="status" aria-live="polite">
        {state.kind === "message" && <p data-testid="places-near-message">{state.text}</p>}
        {state.kind === "results" && (
          <>
            <h2 className="h-sec" data-testid="places-near-count">
              {state.data.total} {state.data.total === 1 ? "place" : "places"} near you{state.data.total > state.data.items.length ? ` (nearest ${state.data.items.length} shown)` : ""}
            </h2>
            <ul className="feed">
              {state.data.items.map((p) => (
                <PlaceCard key={p.id} p={p} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
