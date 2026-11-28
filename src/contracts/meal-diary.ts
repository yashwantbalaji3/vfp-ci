import type { PreviewMeal } from "./menu-preview";

/**
 * "Log this meal": what the diary's own-food form starts with for a real restaurant meal (owner direction
 * 20 Nov 2026 01:06 UTC, journey 7; docs/62). Pure, so it is unit-tested.
 *
 * - Only a single figure the restaurant prints (or gives as its own estimate) for one serving is filled in.
 *   A range, a USDA estimate, a per-100 g figure or an unknown value is never turned into a number: the box
 *   stays empty and the note says what is known, so the person decides. Empty is saved as "not known".
 * - The entry is the person's own private food: it never changes the drafted menu, never confirms anything,
 *   and the note keeps the "unverified" wording and the source date.
 */
export type MealDiaryPrefill = {
  values: { name: string; proteinG: string; energyKcal: string; context: "restaurant" };
  note: string;
};

const g = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function mealDiaryPrefill(meal: PreviewMeal, placeName: string): MealDiaryPrefill {
  const p = meal.protein;
  const perServing = p.portion === null || !p.portion.startsWith("per 100 g");
  const single = (p.basis === "published" || p.basis === "restaurant_estimate") && p.low !== null && perServing;
  const proteinG = single ? g(p.low as number) : "";
  const proteinNote = single
    ? p.basis === "published"
      ? `Protein filled in from ${placeName}'s printed ${g(p.low as number)} g.`
      : `Protein filled in from ${placeName}'s own estimate of about ${g(p.low as number)} g.`
    : p.basis === "unknown"
      ? "Protein isn't known for this meal, so the box is empty. Leave it empty or type a figure you trust."
      : `Protein: ${p.words}. A range isn't a single figure, so the box is empty: type one if you want it counted.`;
  const dated = meal.checkedOn ? ` (menu as drafted from the restaurant's site on ${meal.checkedOn})` : "";
  return {
    values: {
      name: `${meal.label} (${placeName})`.slice(0, 200),
      proteinG,
      energyKcal: meal.kcal !== null && perServing ? g(meal.kcal) : "",
      context: "restaurant",
    },
    note: `${proteinNote} Unverified preview${dated}. It's saved as your own private entry with where the figures came from; if you change one, the entry says so, and it never changes the menu.`,
  };
}

/**
 * How a logged real meal's figures are described in the diary (docs/63), from the private copy made when it was
 * logged. A figure the person kept is the restaurant's; one they typed or changed is theirs, and says so. A
 * draft is never called verified; a confirmed transcription is never called verified either.
 */
export type MealSourceWords = { headline: string; lines: string[] };
type SourceLike = {
  restaurant: { name: string };
  dish: { name: string };
  loggedAt: string;
  source: { url?: string | null; checkedOn?: string | null };
  status: "unverified_draft" | "transcription_confirmed";
  protein: { evidence: string; sourceAmount?: number | null; sourceLow?: number | null; sourceHigh?: number | null; logged?: number | null; changedByYou: boolean; typedByYou: boolean };
  energy?: { sourceAmount?: number | null; logged?: number | null; changedByYou: boolean; typedByYou: boolean };
  servings: number;
};
const EVIDENCE_WORDS: Record<string, string> = {
  restaurant_published: "printed by the restaurant",
  restaurant_estimate: "the restaurant's own estimate",
  restaurant_range: "a range printed by the restaurant",
  restaurant_per_100g: "printed by the restaurant per 100 g, not per serving",
  usda_estimate: "a USDA estimate, not the restaurant's figure",
  unknown: "not known",
};
const longDay = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
export function mealSourceWords(s: SourceLike, quantityNow: number): MealSourceWords {
  const p = s.protein;
  const status = s.status === "transcription_confirmed" ? "Transcription confirmed, not verified" : "Unverified draft";
  const who =
    p.logged === null || p.logged === undefined
      ? "Protein not known"
      : p.changedByYou || p.typedByYou
        ? "Protein entered by you"
        : p.evidence === "restaurant_estimate"
          ? `Protein: ${s.restaurant.name}'s own estimate`
          : `Protein printed by ${s.restaurant.name}`;
  const lines: string[] = [];
  const range = p.sourceLow != null && p.sourceHigh != null ? `${g(p.sourceLow)} to ${g(p.sourceHigh)} g` : null;
  if (p.sourceAmount != null) lines.push(`The menu's figure: ${g(p.sourceAmount)} g protein for one serving, ${EVIDENCE_WORDS[p.evidence]}.`);
  else if (range) lines.push(`The menu's figure: ${range} protein, ${EVIDENCE_WORDS[p.evidence]}. A range isn't a single figure, so it wasn't filled in.`);
  else lines.push(`The menu's figure: ${EVIDENCE_WORDS[p.evidence] ?? "not known"}.`);
  if (p.changedByYou) lines.push(`You changed it to ${g(p.logged as number)} g.`);
  else if (p.typedByYou) lines.push(`You typed ${g(p.logged as number)} g.`);
  if (s.energy?.changedByYou) lines.push(`You changed the calories to ${g(s.energy.logged as number)} kcal (the menu prints ${g(s.energy.sourceAmount as number)}).`);
  else if (s.energy?.typedByYou) lines.push(`You typed the calories.`);
  if (quantityNow !== s.servings) lines.push(`Servings changed by you: logged as ${g(s.servings)}, now ${g(quantityNow)}.`);
  else if (s.servings !== 1) lines.push(`${g(s.servings)} servings.`);
  lines.push(`${s.dish.name} at ${s.restaurant.name}${s.source.checkedOn ? `, from the menu as read on ${longDay(s.source.checkedOn)}` : ""}.`);
  return { headline: `${who} · ${status}`, lines };
}
