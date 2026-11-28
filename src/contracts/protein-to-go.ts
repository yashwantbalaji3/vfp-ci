import type { GoalProgress } from "@/domain/diary/summary";
import type { DietChoice } from "@/domain/dietary/labels";
import { mealFit } from "./meal-eligibility";
import type { PreviewMeal } from "./menu-preview";

/**
 * "Protein to go today" (owner direction 20 Nov 2026 01:06 UTC, journeys 8 and 9; docs/62). Pure, so it is
 * unit-tested.
 *
 * - What's left is the goal minus what is known. When some logged items have no protein value, the known
 *   total is a lower bound, so what's left is an upper bound ("at most"). With estimates, or when the goal
 *   may already be met, we say nothing rather than guess.
 * - Suggestions are only ever things that exist: the person's saved real meals first, then other real
 *   meals, one per restaurant, then recipes. A meal's diet must fit the person's diet filter, using what the
 *   restaurant states (unknown never counts as vegetarian or vegan). A meal with unknown protein is never
 *   suggested. A suggestion is aimed at one meal's worth (at most 45 g), not at closing the day in one go.
 */
export type ToGo = { grams: number; atMost: boolean };
export const ONE_MEAL_G = 45;

export function proteinToGo(p: GoalProgress): ToGo | null {
  if (p.state === "nothing_logged") return { grams: p.target, atMost: false };
  if (p.state === "in_progress" && !p.estimated) return { grams: Math.max(0, Math.round((p.target - p.value) * 10) / 10), atMost: p.atLeast };
  return null;
}

export type MealIdea = { meal: PreviewMeal; placeName: string; saved: boolean };
export function mealIdeas(toGo: ToGo, meals: { meal: PreviewMeal; placeName: string }[], saved: Set<string>, choice: DietChoice, n = 3): MealIdea[] {
  const aim = Math.min(toGo.grams, ONE_MEAL_G);
  const fit = meals
    .filter(({ meal }) => !meal.excluded && mealFit(meal.evidence, choice).status === "eligible" && meal.protein.low !== null)
    .map((x) => ({ ...x, saved: saved.has(x.meal.dishId) }))
    .sort((a, b) => Number(b.saved) - Number(a.saved) || Math.abs((a.meal.protein.low as number) - aim) - Math.abs((b.meal.protein.low as number) - aim) || (b.meal.protein.low as number) - (a.meal.protein.low as number) || a.meal.label.localeCompare(b.meal.label));
  const out: MealIdea[] = [];
  const places = new Set<string>();
  // One idea per place, and one per dish name: two branches of a chain print the same menu (P2 part 2).
  const names = new Set<string>();
  for (const x of fit) {
    const name = x.meal.label.trim().toLowerCase();
    if (places.has(x.meal.placeId) || names.has(name)) continue;
    places.add(x.meal.placeId);
    names.add(name);
    out.push(x);
    if (out.length === n) break;
  }
  return out;
}

/**
 * Journey K (24 Nov 2026): a saved meal whose restaurant prints no protein figure is never a protein
 * suggestion, but the person saved it, so Today still lists it separately as "Saved, protein not printed",
 * with no figure and no guess. Same diet check, the same "not already logged" rule, and not repeated when
 * it already appears among the suggestions.
 */
export function savedWithoutFigure(meals: { meal: PreviewMeal; placeName: string }[], saved: Set<string>, choice: DietChoice, shown: Set<string>, n = 2) {
  return meals
    .filter(({ meal }) => saved.has(meal.dishId) && !shown.has(meal.dishId) && !meal.excluded && meal.protein.low === null && mealFit(meal.evidence, choice).status === "eligible")
    .sort((a, b) => a.meal.label.localeCompare(b.meal.label))
    .slice(0, n);
}

export type RecipeIdea = { foodItemId: string; name: string; proteinG: number };
export function recipeIdeas(toGo: ToGo, recipes: { foodItemId: string; name: string; proteinG: number | null }[], n = 2): RecipeIdea[] {
  const aim = Math.min(toGo.grams, ONE_MEAL_G);
  return recipes
    .filter((r): r is RecipeIdea => r.proteinG !== null && r.proteinG > 0)
    .sort((a, b) => Math.abs(a.proteinG - aim) - Math.abs(b.proteinG - aim) || b.proteinG - a.proteinG || a.name.localeCompare(b.name))
    .slice(0, n);
}

/**
 * What the ideas on Today and the diary aim at (docs/68, L1). With a goal, what's left of it; with no goal,
 * one meal's worth, so a person who never set a goal still gets real next steps (goals stay optional). Nothing
 * when the goal is reached or when estimates make what's left impossible to say.
 */
export type IdeaAim = { kind: "to_go" | "open"; toGo: ToGo };
export function ideaAim(p: GoalProgress): IdeaAim | null {
  if (p.state === "no_goal") return { kind: "open", toGo: { grams: ONE_MEAL_G, atMost: false } };
  const t = proteinToGo(p);
  return t && t.grams > 0 ? { kind: "to_go", toGo: t } : null;
}

/** How a suggestion's protein figure is described: always with its basis. */
export function ideaBasisWords(basis: PreviewMeal["protein"]["basis"]): string {
  return basis === "usda_range" ? "USDA estimate" : basis === "restaurant_estimate" ? "restaurant's estimate" : basis === "unknown" ? "not known" : "printed by the restaurant";
}
