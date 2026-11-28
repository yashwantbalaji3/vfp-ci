"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { DietPreference, SearchItem } from "@/contracts/catalog";
import { DEFAULT_RADIUS, RADII, roundCoord, type MapArea, type MapAreaInput, type MapPlace, type MapResult } from "@/contracts/map";
import { DishCard } from "@/components/dish-card";
import { Icon } from "@/components/icons";
import { formatDistance } from "@/lib/format";
import { findArea } from "@/lib/map-text";
import type { MapBounds, MapFocus } from "./map-canvas";
import { PlacePanel } from "./place-panel";
import { HoursStatusLine } from "@/components/hours-status";

// The map and MapLibre are fetched only when Map view is opened (T-MAP 17).
const MapCanvas = dynamic(() => import("./map-canvas"), {
  ssr: false,
  loading: () => <div className="map-canvas loading" role="status">Loading the map…</div>,
});

type Display = "list" | "map";
type Area =
  | { kind: "radius"; lat: number; lon: number; radiusM: number; label: string; fromLocation: boolean }
  | { kind: "box"; west: number; south: number; east: number; north: number; label: string };
type Layers = { saved: boolean; lists: boolean; friends: boolean };
/** The phone bottom sheet's three positions (MAP-1.1). Wide screens always show the side panel. */
type Sheet = "peek" | "half" | "full";
const SHEET_ORDER: Sheet[] = ["peek", "half", "full"];
const SHEET_WORDS: Record<Sheet, string> = { peek: "Collapsed", half: "Half height", full: "Full height" };

const DISPLAY_KEY = "discover-display";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const radiusLabel = (m: number) => RADII.find((r) => r.meters === m)?.label ?? `${Math.round(m)} m`;

function readDisplay(): Display {
  try {
    return sessionStorage.getItem(DISPLAY_KEY) === "map" ? "map" : "list";
  } catch {
    return "list";
  }
}
const displayListeners = new Set<() => void>();
let displayInMemory: Display | null = null;
function saveDisplay(d: Display) {
  displayInMemory = d;
  try {
    sessionStorage.setItem(DISPLAY_KEY, d);
  } catch {
    /* storage unavailable: the choice is kept for this page only */
  }
  displayListeners.forEach((l) => l());
}
function subscribeDisplay(l: () => void) {
  displayListeners.add(l);
  return () => displayListeners.delete(l);
}
const currentDisplay = () => displayInMemory ?? readDisplay();
function subscribeWide(l: () => void) {
  const q = window.matchMedia("(min-width: 900px)");
  q.addEventListener("change", l);
  return () => q.removeEventListener("change", l);
}
const isWide = () => window.matchMedia("(min-width: 900px)").matches;

function toSearchItem(place: MapPlace, dish: MapPlace["dishes"][number]): SearchItem {
  return {
    foodItemId: dish.foodItemId,
    revisionId: dish.revisionId,
    kind: "dish",
    name: dish.name,
    brand: dish.brand,
    isDemo: dish.isDemo,
    venue: { id: place.id, name: place.name, neighborhood: place.neighborhood, locality: place.locality, cuisines: place.cuisines, priceBand: place.priceBand },
    distanceM: dish.distanceM,
    protein: dish.protein,
    price: null,
    proteinPerDollar: null,
    eligibility: dish.eligibility,
    freshness: dish.freshness,
  };
}

/**
 * Discover's List and Map views (MAP-1). Both show the same search: when no area is chosen
 * the List is the server-rendered list (children) and the Map shows the same places; when an
 * area is chosen both show the places in it, from one request (R-MAP-01, R-MAP-06).
 *
 * Location (R-MAP-02, docs/20 section 10): asked only when "Use my location" is pressed, read
 * once, rounded to about 100 m before it leaves the browser, sent in a request body, kept only
 * in this page's memory and never written to the address, browser storage or the server.
 */
export function DiscoverViews({
  children,
  diet,
  filters,
  view,
  areas,
  signedIn,
  marketName,
  streetUrl,
}: {
  children: ReactNode;
  diet: DietPreference;
  filters: Record<string, unknown>;
  view: "matches" | "needs_confirmation";
  areas: MapArea[];
  signedIn: boolean;
  marketName: string;
  /** Where this app serves the street-map file, or null when none is configured (plain background). */
  streetUrl: string | null;
}) {
  const router = useRouter();
  // Remembered for the visit only (R-MAP-01); the server always starts with the List.
  const display = useSyncExternalStore(subscribeDisplay, currentDisplay, () => "list" as Display);
  // Default distance by screen size (MAP-D): 0.5 mile on a phone, 1 mile on a wide screen.
  const wide = useSyncExternalStore(subscribeWide, isWide, () => false);
  const [area, setArea] = useState<Area | null>(null);
  const [radiusChoice, setRadius] = useState<number | null>(null);
  const radius = radiusChoice ?? (wide ? DEFAULT_RADIUS.desktop : DEFAULT_RADIUS.phone);
  const [result, setResult] = useState<MapResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<MapBounds | null>(null);
  const [mapBroken, setMapBroken] = useState(false);
  const [layers, setLayers] = useState<Layers>({ saved: false, lists: false, friends: false });
  const [fitKey, setFitKey] = useState("0");
  const [placeText, setPlaceText] = useState("");
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>("half");
  const [streetFailed, setStreetFailed] = useState(false);
  const seq = useRef(0);
  const lastPin = useRef<{ id: string; from: "pin" | "row" } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const drag = useRef<{ y: number; start: Sheet } | null>(null);

  const filterKey = JSON.stringify(filters);
  const needsFetch = display === "map" || area !== null;

  const run = useCallback(
    async (target: Area | null) => {
      const id = ++seq.current;
      setBusy(true);
      const areaInput: MapAreaInput =
        target === null
          ? { kind: "market" }
          : target.kind === "radius"
            ? { kind: "radius", lat: roundCoord(target.lat), lon: roundCoord(target.lon), radiusM: target.radiusM }
            : { kind: "box", west: roundCoord(target.west), south: roundCoord(target.south), east: roundCoord(target.east), north: roundCoord(target.north) };
      try {
        const res = await fetch("/api/v1/map/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ ...JSON.parse(filterKey), view, area: areaInput }),
        });
        // A slower earlier answer never replaces a newer one (T-MAP 6).
        if (id !== seq.current) return;
        if (res.status === 429) {
          setMessage("Too many searches in a short time. Please wait a minute and try again.");
          return;
        }
        if (!res.ok) throw new Error("map search failed");
        const body = (await res.json()) as { data: MapResult };
        if (id !== seq.current) return;
        setResult(body.data);
        setSelectedId(null);
        setMovedTo(null);
        setFitKey(String(id));
        if (body.data.places.length === 0 && target?.kind === "radius" && target.fromLocation) {
          setMessage(`Nothing that matches within ${radiusLabel(target.radiusM)} of you. We currently cover the ${marketName} only. Try a wider distance or type a neighbourhood.`);
        } else {
          setMessage(null);
        }
      } catch {
        if (id === seq.current) setMessage("We couldn't search this area just now. Please try again, or type a neighbourhood instead.");
      } finally {
        if (id === seq.current) setBusy(false);
      }
    },
    [filterKey, view, marketName],
  );

  useEffect(() => {
    if (!needsFetch) return;
    let live = true;
    // Started just after this render, so the effect itself changes no state.
    void Promise.resolve().then(() => {
      if (live) void run(area);
    });
    return () => {
      live = false;
    };
  }, [needsFetch, area, run]);

  // While a map or an area is in use, changing filters keeps them: the filter form updates the
  // address without a full reload, so the area (and a location, which is never put in the
  // address) survives.
  useEffect(() => {
    const form = document.getElementById("discover-filters") as HTMLFormElement | null;
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      if (!(display === "map" || area !== null)) return;
      e.preventDefault();
      const params = new URLSearchParams();
      for (const [k, v] of new FormData(form, e.submitter)) if (typeof v === "string" && v !== "") params.append(k, v);
      router.replace(`/discover${params.size ? `?${params}` : ""}`, { scroll: false });
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [display, area, router]);

  function choose(d: Display) {
    saveDisplay(d);
  }

  function askLocation() {
    if (!("geolocation" in navigator)) {
      setMessage("This browser can't share a location. Type a neighbourhood, city or ZIP code instead.");
      return;
    }
    setLocating(true);
    setMessage(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // Rounded at once: the precise reading is not kept even in memory.
        setArea({ kind: "radius", lat: roundCoord(pos.coords.latitude), lon: roundCoord(pos.coords.longitude), radiusM: radius, label: "your location", fromLocation: true });
      },
      () => {
        setLocating(false);
        setMessage("Location is off, and that's fine. Type a neighbourhood, city or ZIP code instead.");
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }

  function searchPlace(e: React.FormEvent) {
    e.preventDefault();
    const found = findArea(areas, placeText);
    if (!found) {
      setMessage(`We couldn't find "${placeText.trim()}". Try a ${marketName} neighbourhood, city or ZIP code. Street addresses are not supported yet.`);
      return;
    }
    setMessage(null);
    setArea({ kind: "radius", lat: found.lat, lon: found.lon, radiusM: radius, label: `${found.name} (approximate centre)`, fromLocation: false });
  }

  function changeRadius(m: number) {
    setRadius(m);
    if (area?.kind === "radius") setArea({ ...area, radiusM: m });
    if (area?.kind === "box") setArea({ kind: "radius", lat: (area.south + area.north) / 2, lon: (area.west + area.east) / 2, radiusM: m, label: "the middle of the map area", fromLocation: false });
  }

  function searchThisArea() {
    if (!movedTo) return;
    if (movedTo.east - movedTo.west > 2 || movedTo.north - movedTo.south > 2) {
      setMessage("This area is too large to search. Zoom in a little and try again.");
      return;
    }
    setArea({ kind: "box", ...movedTo, label: "this map area" });
  }

  function select(id: string | null, from: "pin" | "row" = "row") {
    if (id && selectedId === null) listScroll.current = sheetRef.current?.scrollTop ?? 0;
    if (id) lastPin.current = { id, from };
    setSelectedId(id);
    if (id && sheet === "peek") setSheet("half");
    if (id === null && lastPin.current) {
      const opener = lastPin.current;
      // After the list is back: restore where it was scrolled, keep the place's row in view, and
      // return focus to whatever opened the panel (its pin on the map, or its row in the list).
      requestAnimationFrame(() => {
        if (sheetRef.current) sheetRef.current.scrollTop = listScroll.current;
        const row = document.querySelector<HTMLElement>(`.place-row[data-place-id="${opener.id}"]`);
        const pin = document.querySelector<HTMLElement>(`.map-pin[data-place-id="${opener.id}"]`);
        row?.scrollIntoView({ block: "nearest" });
        ((opener.from === "pin" ? pin : row) ?? row ?? pin)?.focus({ preventScroll: true });
      });
    }
  }

  function moveSheet(step: 1 | -1) {
    const i = SHEET_ORDER.indexOf(sheet) + step;
    if (i >= 0 && i < SHEET_ORDER.length) setSheet(SHEET_ORDER[i]);
  }
  function onHandleDown(e: React.PointerEvent<HTMLButtonElement>) {
    drag.current = { y: e.clientY, start: sheet };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onHandleUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = e.clientY - d.y;
    if (Math.abs(dy) < 24) return; // a press, handled by the click
    const i = SHEET_ORDER.indexOf(d.start) + (dy < 0 ? 1 : -1) * (Math.abs(dy) > 220 ? 2 : 1);
    setSheet(SHEET_ORDER[Math.max(0, Math.min(2, i))]);
    e.preventDefault();
  }

  const places = useMemo(() => {
    const all = result?.places ?? [];
    if (!signedIn || !(layers.saved || layers.lists || layers.friends)) return all;
    return all.filter(
      (p) =>
        (!layers.saved || p.mine?.saved) &&
        (!layers.lists || (p.mine?.lists.length ?? 0) > 0) &&
        (!layers.friends || (p.mine?.recommendedBy?.length ?? 0) > 0 || p.dishes.some((d) => (d.recommendedBy?.length ?? 0) > 0)),
    );
  }, [result, layers, signedIn]);
  const selected = places.find((p) => p.id === selectedId) ?? null;
  const fits = view === "matches";
  const dishTotal = places.reduce((n, p) => n + p.dishCount, 0);
  const focus: MapFocus = useMemo(
    () =>
      area === null
        ? { kind: "market" }
        : area.kind === "radius"
          ? { kind: "radius", lat: area.lat, lon: area.lon, radiusM: area.radiusM, radiusText: radiusLabel(area.radiusM) }
          : { ...area, kind: "box" },
    [area],
  );
  const otherGroup = fits ? (result?.counts.placesNeedsConfirmation ?? 0) : 0;

  const summary = result
    ? `${plural(places.length, "place")} with ${plural(dishTotal, fits ? "dish that fits" : "dish that needs confirmation", fits ? "dishes that fit" : "dishes that need confirmation")}${
        area ? ` within ${area.kind === "radius" ? `${radiusLabel(area.radiusM)} of ${area.label}` : area.label}` : ` in the ${marketName}`
      }.`
    : "";

  return (
    <section aria-label="Results" className="discover-views">
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <div className="seg view-switch" role="group" aria-label="Show results as">
          <button type="button" aria-pressed={display === "list"} onClick={() => choose("list")}>
            List
          </button>
          <button type="button" aria-pressed={display === "map"} onClick={() => choose("map")}>
            Map
          </button>
        </div>
      </div>

      <div className="area-bar">
        <div className="area-controls">
          <div className="row">
          <button type="button" className="btn" onClick={askLocation} disabled={locating}>
            <Icon name="pin" className="" />
            {locating ? "Finding your location…" : "Use my location"}
          </button>
          <label htmlFor="area-radius" className="s14" style={{ margin: 0 }}>
            Within
          </label>
          <select id="area-radius" value={radius} onChange={(e) => changeRadius(Number(e.target.value))} style={{ width: "auto" }}>
            {RADII.map((r) => (
              <option key={r.meters} value={r.meters}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <form className="searchbar area-place" role="search" aria-label="Search near a place" onSubmit={searchPlace}>
          <label htmlFor="area-place" className="sr-only">
            Neighbourhood, city or ZIP code
          </label>
          <input
            id="area-place"
            type="search"
            list="area-names"
            value={placeText}
            onChange={(e) => setPlaceText(e.target.value)}
            placeholder="Neighbourhood, city or ZIP code"
            autoComplete="off"
            maxLength={80}
          />
          <datalist id="area-names">
            {areas.map((a) => (
              <option key={a.slug} value={a.kind === "zip" ? a.name : a.name}>
                {a.context ?? ""}
              </option>
            ))}
          </datalist>
          <button className="btn" type="submit">
            Go
          </button>
        </form>
        </div>
        <p className="s13 muted" style={{ margin: "4px 0 0" }}>
          Optional. If you use your location, an approximate position (about 100 m) is sent to our server for this one search and is
          not saved. Place centres are approximate.
        </p>
        {area && (
          <p className="s14" style={{ margin: "6px 0 0" }}>
            Searching {area.kind === "radius" ? `within ${radiusLabel(area.radiusM)} of ${area.label}` : area.label}.{" "}
            <button type="button" className="link-btn plain" onClick={() => setArea(null)}>
              Show all of the {marketName}
            </button>
          </p>
        )}
      </div>

      <div role="status" aria-live="polite" className="status-line" data-testid="map-status">
        {message && <p className="callout calm" style={{ marginTop: 8 }}>{message}</p>}
        {display === "map" && streetFailed && (
          <p className="s14 muted" style={{ margin: "8px 0 0" }} data-testid="street-fallback">
            The street map couldn&rsquo;t be loaded, so the map shows a plain background. The places and the list are the same.
          </p>
        )}
        {!message && needsFetch && result && <p className="s14" style={{ margin: "8px 0" }}>{summary}</p>}
      </div>

      {needsFetch && fits && otherGroup > 0 && (
        <p className="s14 muted" style={{ margin: "0 0 8px" }} data-testid="map-needs-note">
          {plural(otherGroup, "more place")} {otherGroup === 1 ? "has" : "have"} dishes that need confirmation and {otherGroup === 1 ? "is" : "are"} not
          shown. Choose &ldquo;Needs confirmation&rdquo; above the list to see them.
        </p>
      )}

      {signedIn && needsFetch && (
        <fieldset className="layers">
          <legend className="s14">Show only</legend>
          <label className="check">
            <input type="checkbox" checked={layers.saved} onChange={(e) => setLayers({ ...layers, saved: e.target.checked })} />
            <span>Places I saved</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={layers.lists} onChange={(e) => setLayers({ ...layers, lists: e.target.checked })} />
            <span>Places on my lists</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={layers.friends} onChange={(e) => setLayers({ ...layers, friends: e.target.checked })} />
            <span>Rated highly by people I follow</span>
          </label>
        </fieldset>
      )}

      {display === "list" && area === null && children}

      {display === "list" && area !== null && result && (
        <>
          <h2 className="h-sec" id="area-results-heading">
            {plural(dishTotal, fits ? "dish" : "dish that needs confirmation", fits ? "dishes" : "dishes that need confirmation")}, nearest place first
          </h2>
          <ul className="cards" data-testid="near-results" aria-labelledby="area-results-heading">
            {places.flatMap((p) => p.dishes.map((d) => <DishCard key={d.foodItemId} item={toSearchItem(p, d)} diet={diet} />))}
          </ul>
        </>
      )}

      {display === "map" && (
        <div className={`map-layout sheet-${sheet}`} data-testid="map-view">
          <div className="map-wrap">
            {mapBroken ? (
              <div className="map-canvas broken" role="note">
                The map can&rsquo;t be drawn in this browser. The list beside it has the same places.
              </div>
            ) : (
              <MapCanvas
                places={places}
                view={view}
                focus={focus}
                fitKey={fitKey}
                selectedId={selectedId}
                hoverId={hoverId}
                areas={areas}
                streetUrl={streetUrl}
                onSelect={(id) => select(id, "pin")}
                onHover={setHoverId}
                onUserMove={setMovedTo}
                onUnavailable={() => setMapBroken(true)}
                onBackground={(_, failed) => setStreetFailed(failed)}
              />
            )}
            {movedTo && (
              <button type="button" className="btn primary search-area" onClick={searchThisArea}>
                Search this area
              </button>
            )}
            {busy && <div className="map-busy" aria-hidden="true">Searching…</div>}
          </div>
          <div className="map-sheet" data-testid="map-sheet" data-sheet={sheet} ref={sheetRef}>
            <div className="sheet-handle-row">
              <button
                type="button"
                className="sheet-handle"
                data-testid="sheet-handle"
                aria-label={`${SHEET_WORDS[sheet]} panel. ${sheet === "full" ? "Press to collapse it" : "Press to enlarge it"}, or drag it.`}
                onClick={() => (sheet === "full" ? setSheet("peek") : moveSheet(1))}
                onPointerDown={onHandleDown}
                onPointerUp={onHandleUp}
              >
                <span aria-hidden="true" />
              </button>
              <div className="sheet-steps" role="group" aria-label="Panel size">
                <button type="button" className="btn small" onClick={() => moveSheet(-1)} disabled={sheet === "peek"}>
                  Show less
                </button>
                <button type="button" className="btn small" onClick={() => moveSheet(1)} disabled={sheet === "full"}>
                  Show more
                </button>
              </div>
            </div>
            {selected ? (
              <PlacePanel place={selected} view={view} diet={diet} onClose={() => select(null)} />
            ) : (
              <>
                <h2 className="h-sec" style={{ marginTop: 0 }}>
                  {fits ? "Places with dishes that fit" : "Places with dishes that need confirmation"}
                </h2>
                {result?.truncated && <p className="s13 muted">Showing the first 200 places. Zoom in or choose an area to see the rest.</p>}
                {result && places.length === 0 && <p className="muted">No places here match. Try a wider distance or fewer filters.</p>}
                <ul className="place-rows">
                  {places.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`place-row${hoverId === p.id ? " hover" : ""}`}
                        data-place-id={p.id}
                        onClick={() => select(p.id, "row")}
                        onMouseEnter={() => setHoverId(p.id)}
                        onMouseLeave={() => setHoverId(null)}
                        onFocus={() => setHoverId(p.id)}
                        onBlur={() => setHoverId(null)}
                      >
                        <span className={`row-mark ${fits ? "fits" : "unsure"}`} aria-hidden="true">
                          {fits ? p.dishCount : "?"}
                        </span>
                        <span>
                          <strong>{p.name}</strong>
                          <span className="s13 muted" style={{ display: "block" }}>
                            {[p.neighborhood, fits ? plural(p.dishCount, "dish fits", "dishes fit") : plural(p.dishCount, "dish needs confirmation", "dishes need confirmation"), formatDistance(p.distanceM)]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          {p.hours && <HoursStatusLine status={p.hours} className="s13" />}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
