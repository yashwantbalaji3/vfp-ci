import "server-only";
import { cache } from "react";
import type { FreshnessMarks } from "@/contracts/catalog";
import { FreshnessNote } from "@/components/editor/bits";
import { getFreshnessMarks } from "@/server/catalog";

/**
 * One lookup per page, however many records the page shows. Each label asks for
 * its own record; the requests made during one pass of rendering are gathered
 * and sent to the database together.
 */
type Batch = { foods: Set<string>; venues: Set<string>; pending: Promise<FreshnessMarks> | null };
const batchFor = cache((): Batch => ({ foods: new Set(), venues: new Set(), pending: null }));

function lookup(kind: "food" | "venue", id: string): Promise<FreshnessMarks> {
  const b = batchFor();
  (kind === "food" ? b.foods : b.venues).add(id);
  if (!b.pending) {
    b.pending = new Promise((resolve) => {
      setImmediate(() => {
        const foods = [...b.foods];
        const venues = [...b.venues];
        b.foods.clear();
        b.venues.clear();
        b.pending = null;
        void getFreshnessMarks(foods, venues).then(resolve);
      });
    });
  }
  return b.pending;
}

/** The "May be out of date" or "Being re-checked" label for one public record. Renders nothing when the record is current. */
export async function Fresh({ food, venue, block = false }: { food?: string | null; venue?: string | null; block?: boolean }) {
  const id = food ?? venue;
  if (!id) return null;
  const marks = await lookup(food ? "food" : "venue", id);
  const mark = food ? marks.foods[id] : marks.venues[id];
  if (!mark || (!mark.underReview && mark.state !== "out_of_date")) return null;
  const note = <FreshnessNote mark={mark} what={food ? "entry" : "place"} />;
  return block ? <div style={{ marginTop: 4 }}>{note}</div> : <> {note}</>;
}

/** Label for a rating, list or recommendation target, whatever kind it is. */
export function FreshTarget({ target, block = false }: { target: { kind: string; id: string }; block?: boolean }) {
  return target.kind === "venue" ? <Fresh venue={target.id} block={block} /> : <Fresh food={target.id} block={block} />;
}
