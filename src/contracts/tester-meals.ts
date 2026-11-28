import { z } from "zod";

/**
 * The founder's choice of real meals invited testers may see (owner direction 23 Nov 2026 19:34 UTC, item 3;
 * migration 20261123000200). Every check is computed by the database; this file only names them and sums them up.
 * Including a meal confirms nothing about it: its facts stay unverified, and it shows to testers only while the
 * member beta switch is on, which stays off until the owner's publication decision.
 */
export const CHECK_KEYS = ["meal", "rights", "stated", "place", "fresh", "price", "open", "reviewed"] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export const CHECK_WORDS: Record<CheckKey, { pass: string; fail: string }> = {
  meal: { pass: "A complete meal", fail: "Not recorded as a complete meal (side, drink, dessert or add-on)" },
  rights: { pass: "Source cleared for private use, and the menu text was found on the saved page", fail: "Source not cleared, or the menu text was not found on the saved page" },
  stated: { pass: "The restaurant's own words say vegetarian or vegan", fail: "The restaurant does not state vegetarian or vegan (or a label says no)" },
  place: { pass: "Restaurant is in the beta and linked to its listing", fail: "Restaurant is not in the beta, or not linked to a listing" },
  fresh: { pass: "Menu checked in the last 120 days", fail: "Menu not checked in the last 120 days" },
  price: { pass: "Price on the menu", fail: "No price on the menu" },
  open: { pass: "Nothing says the restaurant is closed", fail: "A record says the restaurant is closed" },
  reviewed: {
    pass: "You checked the menu item, price and diet label against the restaurant's source",
    fail: "You have not yet checked the menu item, price and diet label against the restaurant's source",
  },
};

export const testerChecksSchema = z
  .object({
    meal: z.boolean(),
    rights: z.boolean(),
    stated: z.boolean(),
    statedDiets: z.array(z.string()),
    place: z.boolean(),
    fresh: z.boolean(),
    price: z.boolean(),
    open: z.boolean(),
    // Migration 20261125000300; an older database without it reads as not reviewed.
    reviewed: z.boolean().default(false),
    reviewedDiets: z.array(z.string()).default([]),
    checkedOn: z.string().nullable(),
  })
  .passthrough();
export type TesterChecks = z.infer<typeof testerChecksSchema>;

export const testerQueueSchema = z.object({
  mode: z.enum(["reviewed_meals", "whole_place"]),
  betaOn: z.boolean(),
  limit: z.number().int(),
  meals: z.array(
    z.object({
      dishId: z.string().uuid(),
      placeId: z.string().uuid(),
      checks: testerChecksSchema,
      decision: z.enum(["include", "leave_out"]).nullable(),
      reason: z.string().nullable(),
      decidedAt: z.string().nullable(),
      included: z.boolean(),
    }),
  ),
});
export type TesterQueue = z.infer<typeof testerQueueSchema>;
export type TesterRow = TesterQueue["meals"][number];

export const allPass = (c: TesterChecks) => CHECK_KEYS.every((k) => c[k]);
export const failing = (c: TesterChecks): CheckKey[] => CHECK_KEYS.filter((k) => !c[k]);

/** Ready to include: every check passes and the founder has not decided yet, or left it out earlier. */
export type TesterState = "included" | "ready" | "left_out" | "not_eligible";
export function testerState(r: Pick<TesterRow, "checks" | "decision" | "included">): TesterState {
  if (r.included) return "included";
  if (!allPass(r.checks)) return "not_eligible";
  return r.decision === "leave_out" ? "left_out" : "ready";
}

/**
 * Progress against the minimum launch standard (docs/78 section 2) for the meals included so far: per neighbourhood,
 * restaurants with at least 3 included meals, and their cuisines. The standard is 3 such restaurants and 2 cuisines.
 */
export type AreaProgress = { area: string; restaurants: number; strongRestaurants: number; meals: number; cuisines: number; meetsMinimum: boolean };
export function areaProgress(
  rows: { placeId: string; included: boolean }[],
  places: { placeId: string; area: string | null; cuisines: { cuisine: string; basis: string }[] }[],
): AreaProgress[] {
  const byPlace = new Map(places.map((p) => [p.placeId, p]));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.included) counts.set(r.placeId, (counts.get(r.placeId) ?? 0) + 1);
  const areas = new Map<string, { restaurants: number; strong: Set<string>; meals: number; cuisines: Set<string> }>();
  for (const [placeId, n] of counts) {
    const p = byPlace.get(placeId);
    const area = p?.area?.trim() || "Area not recorded";
    const a = areas.get(area) ?? { restaurants: 0, strong: new Set<string>(), meals: 0, cuisines: new Set<string>() };
    a.restaurants += 1;
    a.meals += n;
    if (n >= 3) {
      a.strong.add(placeId);
      for (const c of p?.cuisines ?? []) if (c.basis !== "possibly") a.cuisines.add(c.cuisine);
    }
    areas.set(area, a);
  }
  return [...areas.entries()]
    .map(([area, a]) => ({ area, restaurants: a.restaurants, strongRestaurants: a.strong.size, meals: a.meals, cuisines: a.cuisines.size, meetsMinimum: a.strong.size >= 3 && a.cuisines.size >= 2 }))
    .sort((x, y) => y.meals - x.meals || x.area.localeCompare(y.area));
}

/**
 * Which ready meals the founder should look at first (owner directive 24 Nov 2026 14:59 UTC, 2C): the ones that add the
 * most variety and the strongest evidence, not just the next meal from the restaurant that already has the most.
 * Points, highest first; each reason is shown beside the meal so the order is never a mystery. Nothing here decides
 * for the founder: it only orders the list.
 */
export type PriorityInput = {
  placeId: string;
  area: string | null;
  veganStated: boolean;
  /** The restaurant's own words say no egg (an egg-free statement), not our reading of an ingredient list. */
  eggFreeStated: boolean;
  ingredientsListed: boolean;
  proteinPrinted: boolean;
  checkedOn: string | null;
};
export type Priority = { score: number; reasons: string[] };

export function reviewPriority(m: PriorityInput, ctx: { includedByPlace: Map<string, number>; includedByArea: Map<string, number>; today: string }): Priority {
  const reasons: string[] = [];
  let score = 0;
  if ((ctx.includedByPlace.get(m.placeId) ?? 0) === 0) {
    score += 40;
    reasons.push("new restaurant for testers");
  }
  const area = m.area?.trim() || "";
  if (area && (ctx.includedByArea.get(area) ?? 0) < 5) {
    score += 20;
    reasons.push(`few meals in ${area} yet`);
  }
  if (m.eggFreeStated) {
    score += 15;
    reasons.push("says no egg");
  }
  if (m.veganStated) {
    score += 15;
    reasons.push("says vegan");
  }
  if (m.ingredientsListed) {
    score += 10;
    reasons.push("ingredients listed");
  }
  if (m.proteinPrinted) {
    score += 10;
    reasons.push("protein printed");
  }
  if (m.checkedOn) {
    const days = (Date.parse(ctx.today) - Date.parse(m.checkedOn)) / 86_400_000;
    if (days <= 7) {
      score += 5;
      reasons.push("menu checked this week");
    }
  }
  return { score, reasons };
}

/**
 * The founder's first review set (owner decisions 24 Nov 2026 14:59 and 17:45 UTC): ready meals picked one at a time,
 * each pick re-scored as if the meals already picked were included, so the restaurant and area bonuses go to a
 * restaurant or area not yet in the set. The result interleaves restaurants and areas instead of listing one
 * restaurant's meals first. At most `perPlace` from one restaurant and `limit` in all. Only an order: nothing here
 * decides for the founder.
 */
export function prioritise<T extends PriorityInput & { label: string }>(
  meals: T[],
  ctx: Parameters<typeof reviewPriority>[1],
  perPlace: number,
  limit = Number.POSITIVE_INFINITY,
): (T & { priority: Priority })[] {
  const byPlace = new Map(ctx.includedByPlace);
  const byArea = new Map(ctx.includedByArea);
  const taken = new Map<string, number>();
  const pool = [...meals];
  const out: (T & { priority: Priority })[] = [];
  while (pool.length > 0 && out.length < limit) {
    let best = -1;
    let bestP: Priority | null = null;
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i];
      if ((taken.get(m.placeId) ?? 0) >= perPlace) continue;
      const p = reviewPriority(m, { includedByPlace: byPlace, includedByArea: byArea, today: ctx.today });
      if (!bestP || p.score > bestP.score || (p.score === bestP.score && m.label.localeCompare(pool[best].label) < 0)) {
        best = i;
        bestP = p;
      }
    }
    if (best < 0 || !bestP) break;
    const m = pool.splice(best, 1)[0];
    out.push({ ...m, priority: bestP });
    taken.set(m.placeId, (taken.get(m.placeId) ?? 0) + 1);
    byPlace.set(m.placeId, (byPlace.get(m.placeId) ?? 0) + 1);
    const a = m.area?.trim() || "";
    if (a) byArea.set(a, (byArea.get(a) ?? 0) + 1);
  }
  return out;
}
