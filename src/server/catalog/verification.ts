import "server-only";
import { evidenceCategories, type DietConfirmation } from "@/contracts/diet-confirmation";
import type { MenuPlace } from "@/contracts/menu-review";
import type { PreviewMeal } from "@/contracts/menu-preview";
import { openNotes } from "@/contracts/review-queue";
import { CHECK_KEYS, prioritise } from "@/contracts/tester-meals";
import { verifyDish, type Verification } from "@/contracts/verification";
import { getDietConfirmations } from "./diet-confirmations";
import { getPreviewAudience, getPreviewPlaces, type PreviewPlace } from "./menu-preview";
import { getMenuPlace } from "./menu-review";
import { getMealNotes } from "./review-queue";
import { getTesterQueue } from "./tester-meals";

/** Same limits as the review queue's proposed first selection (src/app/places/review/queue/page.tsx). */
export const PROPOSED_PER_PLACE = 6;
export const PROPOSED_LIMIT = 50;

export type VerifiedMeal = { p: PreviewPlace; m: PreviewMeal; menu: MenuPlace; v: Verification; proposed: boolean };

/**
 * The verification dry run over every source-backed complete meal in the founder's private preview (owner directive
 * 28 Nov 2026 04:59 UTC). Reads only, as the signed-in founder; the database refuses anyone else. Writes nothing.
 * "proposed" marks the meals in the review queue's proposed first selection, chosen by the same rule as that page.
 */
export async function getVerificationDryRun(now = Date.now()): Promise<VerifiedMeal[] | null> {
  const [audience, places, queue] = await Promise.all([getPreviewAudience(), getPreviewPlaces(), getTesterQueue()]);
  if (audience !== "founder" || !places || !queue) return null;
  const [records, notes, menus] = await Promise.all([getDietConfirmations(), getMealNotes(), Promise.all(places.map((p) => getMenuPlace(p.placeId).catch(() => null)))]);
  const recOf = new Map<string, DietConfirmation[]>();
  for (const r of records) recOf.set(r.dishId, [...(recOf.get(r.dishId) ?? []), r]);
  const open = openNotes(notes);
  const checksOf = new Map(queue.meals.map((r) => [r.dishId, r]));
  const rows: Omit<VerifiedMeal, "proposed">[] = [];
  for (const [i, p] of places.entries()) {
    const menu = menus[i];
    if (!menu) continue;
    for (const m of p.meals) {
      const d = menu.dishes.find((x) => x.dishId === m.dishId);
      if (!d) continue;
      rows.push({ p, m, menu, v: verifyDish(d, menu, m.protein.basis, now) });
    }
  }
  const labelled = rows.filter((r) => {
    const cat = evidenceCategories(r.m.evidence, recOf.get(r.m.dishId) ?? []);
    return cat.vegetarian === "restaurant_published" || cat.vegan === "restaurant_published";
  });
  const ready = (id: string) => {
    const t = checksOf.get(id);
    return !!t && CHECK_KEYS.every((k) => k === "place" || k === "reviewed" || t.checks[k]);
  };
  const ranked = prioritise(
    labelled
      .filter((r) => ready(r.m.dishId) && !open.get(r.m.dishId))
      .map((r) => ({
        dishId: r.m.dishId,
        placeId: r.p.placeId,
        label: r.m.label,
        area: r.p.area,
        veganStated: r.m.evidence.veganClaim === "yes",
        eggFreeStated: false,
        ingredientsListed: (r.m.evidence.ingredients?.length ?? 0) > 0,
        proteinPrinted: r.m.protein.basis === "published" || r.m.protein.basis === "published_range",
        checkedOn: r.m.checkedOn,
      })),
    { includedByPlace: new Map(), includedByArea: new Map(), today: new Date(now).toISOString().slice(0, 10) },
    PROPOSED_PER_PLACE,
    PROPOSED_LIMIT,
  );
  const proposed = new Set(ranked.map((r) => r.dishId));
  return rows.map((r) => ({ ...r, proposed: proposed.has(r.m.dishId) }));
}
