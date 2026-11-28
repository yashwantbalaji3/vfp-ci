import "server-only";
import { mealLens, type MealLens } from "@/contracts/meal-eligibility";
import { readDietPreference } from "@/server/catalog/diet";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
/** The diet in force on a real-menu page: the person's saved choice, read on the server (docs/63). */
export async function readMealLens(sp: Record<string, string | string[] | undefined>): Promise<MealLens> {
  return mealLens(await readDietPreference(), first(sp.diet), first(sp.fit));
}
