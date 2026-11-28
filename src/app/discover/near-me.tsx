"use client";
import { useState } from "react";
import type { DietPreference, SearchItem } from "@/contracts/catalog";
import { DishCard } from "@/components/dish-card";
import { Icon } from "@/components/icons";

type State =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "message"; text: string }
  | { kind: "results"; items: SearchItem[]; needsConfirmation: number };

const RADII = [
  { label: "1 mile", meters: 1609 },
  { label: "3 miles", meters: 4828 },
  { label: "10 miles", meters: 16093 },
  { label: "30 miles", meters: 48280 },
];

/**
 * Optional "near me" search (R-D01, R-D04). Location is asked for only when the person
 * presses the button, is sent once in a request body, and is not kept anywhere.
 * Choosing a neighbourhood always works without it.
 */
export function NearMe({ filters, diet, marketName }: { filters: Record<string, unknown>; diet: DietPreference; marketName: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [radius, setRadius] = useState(RADII[1].meters);

  function search() {
    if (!("geolocation" in navigator)) {
      setState({ kind: "message", text: "This browser can't share a location. Choose a neighbourhood in Filters instead." });
      return;
    }
    setState({ kind: "working" });
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const response = await fetch("/api/v1/catalog/nearby", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ ...filters, lat: position.coords.latitude, lon: position.coords.longitude, radiusM: radius, limit: 12 }),
          });
          if (response.status === 429) {
            setState({ kind: "message", text: "Too many searches in a short time. Please wait a minute and try again." });
            return;
          }
          if (!response.ok) throw new Error("nearby failed");
          const body = (await response.json()) as { data: { items: SearchItem[]; counts: { needsConfirmation: number } } };
          if (body.data.items.length === 0) {
            const label = RADII.find((r) => r.meters === radius)?.label ?? "that distance";
            setState({
              kind: "message",
              text: `Nothing that matches within ${label} of you. We currently cover the ${marketName} only. Try a wider distance or choose a neighbourhood in Filters.`,
            });
            return;
          }
          setState({ kind: "results", items: body.data.items, needsConfirmation: body.data.counts.needsConfirmation });
        } catch {
          setState({ kind: "message", text: "We couldn't search near you just now. Please try again, or choose a neighbourhood in Filters." });
        }
      },
      () => setState({ kind: "message", text: "Location is off, and that's fine. Choose a neighbourhood in Filters instead." }),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }

  return (
    <section aria-label="Near me">
      <div className="row">
        <button type="button" className="btn" onClick={search} disabled={state.kind === "working"}>
          <Icon name="pin" className="" />
          {state.kind === "working" ? "Finding dishes near you…" : "Use my location"}
        </button>
        <label htmlFor="near-radius" className="s14" style={{ margin: 0 }}>
          Within
        </label>
        <select id="near-radius" value={radius} onChange={(e) => setRadius(Number(e.target.value))} style={{ width: "auto" }}>
          {RADII.map((r) => (
            <option key={r.meters} value={r.meters}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <p className="s13 muted" style={{ margin: "4px 0 0" }}>
        Optional. Your location is used for this one search and is not saved.
      </p>
      <div role="status" aria-live="polite" className="status-line">
        {state.kind === "message" && <p className="callout calm" style={{ marginTop: 8 }}>{state.text}</p>}
        {state.kind === "results" && (
          <p className="s14" style={{ margin: "8px 0" }}>
            <strong>
              {state.items.length} closest {state.items.length === 1 ? "match" : "matches"}
            </strong>
            , nearest first.
            {state.needsConfirmation > 0 && ` ${state.needsConfirmation} more nearby need confirmation and are not shown here.`}
          </p>
        )}
      </div>
      {state.kind === "results" && (
        <>
          <ul className="cards" data-testid="near-results">
            {state.items.map((item) => (
              <DishCard key={item.foodItemId} item={item} diet={diet} />
            ))}
          </ul>
          <button type="button" className="link-btn" style={{ background: "none", border: 0, font: "inherit", cursor: "pointer" }} onClick={() => setState({ kind: "idle" })}>
            Hide nearby results
          </button>
        </>
      )}
    </section>
  );
}
