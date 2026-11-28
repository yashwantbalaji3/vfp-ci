import { MEAL_SLOTS, isoDateSchema, type MealSlot } from "@/contracts/diary";
import { defaultMealSlot } from "@/domain/diary/summary";
import type { RawParams } from "@/lib/search-params";

export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The day and meal a diary form is for, taken from the address when valid, otherwise today and the time of day. */
export function targetOf(sp: RawParams, clock: { today: string; hour: number }): { date: string; mealSlot: MealSlot; query: string } {
  const date = isoDateSchema.safeParse(one(sp.date)).data ?? clock.today;
  const raw = one(sp.slot);
  const mealSlot = (MEAL_SLOTS as readonly string[]).includes(raw ?? "") ? (raw as MealSlot) : defaultMealSlot(clock.hour);
  return { date, mealSlot, query: `date=${date}&slot=${mealSlot}` };
}
