"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { DietPreference } from "@/contracts/catalog";
import type { MapPlace } from "@/contracts/map";
import { DietaryConfidence, EvidenceBadge, ProteinFigure } from "@/components/labels";
import { FreshnessNote } from "@/components/editor/bits";
import { formatDistance, priceBand, proteinFor, titleCase } from "@/lib/format";
import { directionLinks, walkEstimate } from "@/lib/map-text";
import { HoursStatusLine } from "@/components/hours-status";

export function PlacePanel({
  place,
  view,
  diet,
  onClose,
}: {
  place: MapPlace;
  view: string;
  diet: DietPreference;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [place.id]);
  const fits = view === "matches";
  const isDemo = place.dishes.every((d) => d.isDemo);
  const meta = [place.neighborhood, place.locality, priceBand(place.priceBand ?? null), (place.cuisines ?? []).map(titleCase).join(", ")]
    .filter(Boolean)
    .join(" · ");
  const picks = place.mine?.recommendedBy ?? [];
  return (
    <article className="place-panel" data-testid="place-panel" aria-labelledby="place-panel-title">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <h2 id="place-panel-title" ref={heading} tabIndex={-1} className="h-sec" style={{ margin: 0 }}>
          {place.name}
        </h2>
        <button type="button" className="btn small" onClick={onClose}>
          Back to all places
        </button>
      </div>
      {isDemo && (
        <p className="s13" style={{ margin: "4px 0" }}>
          <strong>Demo data.</strong> This place, its position and its dishes are invented for testing.
        </p>
      )}
      {meta && <p className="meta" style={{ margin: "4px 0" }}>{meta}</p>}
      {place.distanceM !== null && (
        <p className="s14" style={{ margin: "4px 0" }}>
          {formatDistance(place.distanceM)}, {walkEstimate(place.distanceM)}
        </p>
      )}
      {place.hours && <HoursStatusLine status={place.hours} />}
      <FreshnessNote mark={place.freshness} what="place" />
      {place.mine && (place.mine.saved || place.mine.lists.length > 0 || picks.length > 0) && (
        <ul className="mine-tags" aria-label="Yours">
          {place.mine.saved && <li>Saved</li>}
          {place.mine.lists.map((l) => (
            <li key={l.id}>On your list &ldquo;{l.title}&rdquo;</li>
          ))}
          {picks.map((p, i) => (
            <li key={i}>
              Rated {p.rating} by {p.person.displayName ?? p.person.handle}
              {p.audience === "friends" ? " (friends only)" : ""}
            </li>
          ))}
        </ul>
      )}

      <h3 className="s16" style={{ margin: "12px 0 4px" }}>
        {fits ? `Dishes that fit your filter (${place.dishes.length})` : `Not confirmed for your filter (${place.dishes.length})`}
      </h3>
      {!fits && (
        <p className="callout" style={{ margin: "4px 0 8px" }}>
          <strong>Not confirmed.</strong> Nobody has confirmed an ingredient of these dishes for your filter. Ask the restaurant before ordering.
        </p>
      )}
      <ul className="place-dishes">
        {place.dishes.map((d) => {
          const known = proteinFor(d.protein, "serving").value !== null;
          return (
            <li key={d.foodItemId} data-testid="place-dish">
              <Link href={`/foods/${d.foodItemId}`}>{d.name}</Link>
              <div className="foot">
                <ProteinFigure protein={d.protein} basis="serving" />
                {known && <EvidenceBadge method={d.protein.method} known />}
              </div>
              <div className="foot">
                <DietaryConfidence eligibility={d.eligibility} choice={diet} />
                <FreshnessNote mark={d.freshness} />
              </div>
              {(d.recommendedBy ?? []).length > 0 && (
                <p className="s13 muted" style={{ margin: 0 }}>
                  Rated highly by{" "}
                  {(d.recommendedBy ?? [])
                    .map((p) => `${p.person.displayName ?? p.person.handle}${p.audience === "friends" ? " (friends only)" : ""}`)
                    .join(", ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="row" style={{ marginTop: 12 }}>
        <Link className="btn" href={`/venues/${place.id}`}>
          See the place
        </Link>
      </div>
      <div style={{ marginTop: 12 }}>
        <p className="s14" style={{ margin: "0 0 4px", fontWeight: 700 }}>
          Directions
        </p>
        <p className="s13 muted" style={{ margin: "0 0 6px" }}>
          Opens outside this app, with only this place&rsquo;s position as the destination.
        </p>
        <div className="row">
          {directionLinks(place.lat, place.lon).map((l) => (
            <a key={l.label} className="btn small" href={l.href} target="_blank" rel="noopener noreferrer">
              {l.label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ))}
        </div>
      </div>
    </article>
  );
}
