import type { Builder } from "./meal-builder";
import type { DietChoice } from "@/domain/dietary/labels";
import { inFitView, mealFit, type FitView, type MealFit } from "./meal-eligibility";
import { byProtein, type PreviewMeal, type PreviewIndexEntry } from "./menu-preview";

/**
 * One search across the founder's real restaurants and their drafted meals (owner direction 19 Nov 2026 23:11 UTC,
 * item 2; docs/61). Pure and deterministic, so it is unit-tested without a database.
 *
 * - A word matches a meal by its name, menu section, its restaurant's name, area or cuisine; a restaurant by its
 *   name, street, area or cuisine. Every word must match ("lentil soup" needs both). Case and accents are ignored.
 * - The person's diet choice applies by default, through the one shared check (meal-eligibility, docs/63): a
 *   typed or shared address can't widen it. "check" shows only the meals that need confirmation, and "all"
 *   is the explicit broadening, where every meal carries its fit. Every result is an unverified draft.
 * - A meal left out of discovery (its name names meat with no vegetarian claim) is never a search result.
 * - Cuisine comes from open place data and says nothing about diet; it only helps find a restaurant.
 */

type Place = Pick<PreviewIndexEntry, "slug" | "name" | "street" | "area" | "cuisines"> & { meals: PreviewMeal[] };
export type BuilderHit<P extends Place> = { builder: Builder; place: P; parts: string[] };
export type SearchHit<P extends Place> = { allMeals: (PreviewMeal & { place: P; fit: MealFit })[]; meals: (PreviewMeal & { place: P; fit: MealFit })[]; places: P[]; builders: BuilderHit<P>[]; counts: Record<FitView, number> };

export const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
export const words = (q: string) => [...new Set(fold(q).split(" ").filter((w) => w.length > 0))].slice(0, 8);

/**
 * Build-your-own meals match by their name, their restaurant, or the name of any part ("falafel" finds a bowl
 * that offers falafel). Their diet depends on what is picked; their page marks each part against the diet.
 * They show in every view except "Needs confirmation".
 */
export function searchPreview<P extends Place>(places: P[], q: string, choice: DietChoice, view: FitView, builders: { builder: Builder; place: P }[] = []): SearchHit<P> {
  const ws = words(q);
  const has = (hay: string) => ws.every((w) => hay.includes(w));
  const placeText = (p: P) => fold([p.name, p.street, p.area ?? "", ...p.cuisines.map((c) => c.cuisine)].join(" "));
  const all = ws.length
    ? places.flatMap((p) => {
        const pt = placeText(p);
        return p.meals.filter((m) => !m.excluded && has(`${fold(`${m.label} ${m.section ?? ""}`)} ${pt}`)).map((m) => ({ ...m, place: p, fit: mealFit(m.evidence, choice) }));
      })
    : [];
  const counts = { mine: all.filter((m) => inFitView(m.fit, "mine")).length, check: all.filter((m) => inFitView(m.fit, "check")).length, all: all.length };
  const meals = all.filter((m) => inFitView(m.fit, view)).sort(byProtein);
  const matchedPlaces = ws.length ? places.filter((p) => has(placeText(p)) || meals.some((m) => m.place.slug === p.slug)) : [];
  const builderHits =
    ws.length && view !== "check"
      ? builders.flatMap(({ builder, place }) => {
          const hay = `${fold(builder.label)} ${builder.parts.map((x) => fold(x.label)).join(" ")} ${placeText(place)}`;
          if (!has(hay)) return [];
          const parts = builder.parts.filter((x) => ws.some((w) => fold(x.label).includes(w))).map((x) => x.label);
          return [{ builder, place, parts }];
        })
      : [];
  return { allMeals: all, meals, places: matchedPlaces, builders: builderHits, counts };
}
