import Link from "next/link";
import type { Basis, DietPreference, SearchItem } from "@/contracts/catalog";
import { KIND_LABELS, formatDistance, priceBand, proteinFor } from "@/lib/format";
import { FoodIllustration } from "./food-illustration";
import { FreshnessNote } from "./editor/bits";
import { DietaryConfidence, EvidenceBadge, ProteinFigure } from "./labels";
import { HoursStatusLine } from "./hours-status";

/**
 * One result. Same order everywhere: picture, name, place, protein with its
 * evidence, dietary confidence. Usable on the server and in the browser.
 */
export function DishCard({ item, diet, basis = "serving" }: { item: SearchItem; diet: DietPreference; basis?: Basis }) {
  const place = item.venue
    ? [item.venue.name, item.venue.neighborhood, priceBand(item.venue.priceBand), formatDistance(item.distanceM)].filter(Boolean).join(" · ")
    : [KIND_LABELS[item.kind], item.brand].filter(Boolean).join(" · ");
  const view = proteinFor(item.protein, basis);
  const change = item.eligibility.reasons.find((r) => r.code === "requires_modification")?.modifications;
  return (
    <li className="card" data-testid="dish-card">
      <FoodIllustration name={item.name} />
      <div className="body">
        <h3>
          <Link href={`/foods/${item.foodItemId}`}>{item.name}</Link>
        </h3>
        <p className="meta" style={{ margin: 0 }}>
          {place}
        </p>
        {item.venue?.hours && <HoursStatusLine status={item.venue.hours} />}
        <div className="foot">
          <ProteinFigure protein={item.protein} basis={basis} />
          {view.value !== null && <EvidenceBadge method={item.protein.method} known />}
        </div>
        <div className="foot">
          <DietaryConfidence eligibility={item.eligibility} choice={diet} />
          <FreshnessNote mark={item.freshness} />
        </div>
        {change && diet.diet !== "none" && (
          <p className="s13 muted" style={{ margin: 0 }}>
            {change}
          </p>
        )}
      </div>
    </li>
  );
}
