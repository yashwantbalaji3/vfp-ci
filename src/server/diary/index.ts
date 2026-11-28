import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import {
  GOAL_METRICS,
  customFoodsSchema,
  diaryDaySchema,
  diaryWeekSchema,
  goalsSchema,
  loggableFoodSchema,
  ownFoodSchema,
  recentFoodsSchema,
  usdaSearchSchema,
  writeResultSchema,
  type CustomFood,
  type CustomFoodInput,
  type DayStatus,
  type DiaryDay,
  type DiaryWeek,
  type Goals,
  type GoalsInput,
  type LogEntryInput,
  type LoggableFood,
  type OwnFood,
  type OwnFoodUpdateInput,
  type RecentFood,
  type RepeatEntryInput,
  type UpdateEntryInput,
  type UsdaFood,
  type WriteResult,
} from "@/contracts/diary";

/**
 * Server-only diary and goals access (docs/10). Every call runs AS THE SIGNED-IN
 * MEMBER: the database functions take the owner from the verified session, never
 * from an argument, and Row Level Security applies. No privileged key is used.
 * Nothing here writes diary content to logs.
 */
export type DiaryStatus = 401 | 404 | 409 | 422 | 429 | 500;
export class DiaryError extends Error {
  constructor(
    public status: DiaryStatus,
    public code: string,
  ) {
    super(code);
  }
}

const STATUS: Record<string, DiaryStatus> = { PT401: 401, PT404: 404, PT409: 409, PT422: 422, PT429: 429, "42501": 401 };

function toDiaryError(error: { code?: string; message?: string }): DiaryError {
  const status = STATUS[error.code ?? ""] ?? 500;
  // Our PTxxx messages are fixed identifiers such as VERSION_CONFLICT; anything else stays generic.
  const code = status === 500 ? "DIARY_UNAVAILABLE" : error.code === "42501" ? "NOT_SIGNED_IN" : (error.message ?? "INVALID_REQUEST");
  return new DiaryError(status, code);
}

async function rpc<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S): Promise<z.output<S>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toDiaryError(error);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new DiaryError(500, "DIARY_RESPONSE_INVALID");
  return parsed.data;
}

export const getDiaryDay = (date: string): Promise<DiaryDay> => rpc("diary_day", { p_date: date }, diaryDaySchema);
export const getDiaryWeek = (start: string): Promise<DiaryWeek> => rpc("diary_week", { p_start: start }, diaryWeekSchema);
export const getGoals = (date: string): Promise<Goals> => rpc("my_goals", { p_date: date }, goalsSchema);
export const getRecentFoods = (limit = 12): Promise<RecentFood[]> => rpc("recent_foods", { p_limit: limit }, recentFoodsSchema);
export const getCustomFoods = (): Promise<CustomFood[]> => rpc("my_custom_foods", {}, customFoodsSchema);
export const getLoggableFood = (foodItemId: string): Promise<LoggableFood> =>
  rpc("loggable_food", { p_food_item_id: foodItemId, p_include_demo: FLAGS.allowDemoContent }, loggableFoodSchema);

export function logEntry(input: LogEntryInput, timeZone: string): Promise<WriteResult> {
  return rpc(
    "log_food_entry",
    {
      p_idempotency_key: input.idempotencyKey,
      p_food_revision_id: input.revisionId,
      p_portion_id: input.grams === undefined ? input.portionId : null,
      p_multiplier: input.grams === undefined ? input.quantity : null,
      p_grams: input.grams ?? null,
      p_context: input.context,
      p_meal_slot: input.mealSlot,
      p_local_date: input.date,
      p_timezone: timeZone,
    },
    writeResultSchema,
  );
}

export function logCustomFood(input: CustomFoodInput, timeZone: string): Promise<WriteResult> {
  // Only values the member typed are sent. A missing key is stored as "not provided".
  const nutrients: Record<string, number> = {};
  if (input.proteinG !== undefined) nutrients.protein_g = input.proteinG;
  if (input.energyKcal !== undefined) nutrients.energy_kcal = input.energyKcal;
  if (input.carbG !== undefined) nutrients.carb_g = input.carbG;
  if (input.fatG !== undefined) nutrients.fat_g = input.fatG;
  if (input.fiberG !== undefined) nutrients.fiber_g = input.fiberG;
  return rpc(
    "log_new_custom_food",
    {
      p_idempotency_key: input.idempotencyKey,
      p_name: input.name,
      p_brand: input.brand || null,
      p_nutrients: nutrients,
      p_serving_label: input.servingLabel || null,
      p_serving_grams: input.servingGrams ?? null,
      p_multiplier: input.quantity,
      p_context: input.context,
      p_meal_slot: input.mealSlot,
      p_local_date: input.date,
      p_timezone: timeZone,
    },
    writeResultSchema,
  );
}

/**
 * "Log this meal" for a real restaurant meal (docs/63). The database reads the restaurant's own figures again and
 * keeps where they came from; only the person's protein, calories and servings come from the form. A USDA range,
 * read here on the server, is recorded as the meal's evidence but never becomes the logged number.
 */
export function logRealMeal(input: CustomFoodInput & { mealId: string; usda: { low: number; high: number; confidence: string | null } | null }, timeZone: string): Promise<WriteResult> {
  return rpc(
    "log_real_meal",
    {
      p_idempotency_key: input.idempotencyKey,
      p_dish: input.mealId,
      p_protein_g: input.proteinG ?? null,
      p_energy_kcal: input.energyKcal ?? null,
      p_multiplier: input.quantity,
      p_meal_slot: input.mealSlot,
      p_local_date: input.date,
      p_timezone: timeZone,
      p_usda: input.usda,
    },
    writeResultSchema,
  );
}

export function updateEntry(input: UpdateEntryInput): Promise<WriteResult> {
  return rpc(
    "update_diary_entry",
    {
      p_entry_id: input.entryId,
      p_expected_version: input.expectedVersion,
      p_portion_id: input.grams === undefined && !input.cooked ? (input.portionId ?? null) : null,
      p_multiplier: input.grams === undefined ? input.quantity : null,
      p_grams: input.grams ?? null,
      p_local_date: input.date ?? null,
      p_meal_slot: input.mealSlot ?? null,
    },
    writeResultSchema,
  );
}

export const deleteEntry = (entryId: string, expectedVersion: number): Promise<WriteResult> =>
  rpc("delete_diary_entry", { p_entry_id: entryId, p_expected_version: expectedVersion }, writeResultSchema);

export const restoreEntry = (entryId: string): Promise<WriteResult> =>
  rpc("restore_diary_entry", { p_entry_id: entryId }, writeResultSchema);

export function repeatEntry(input: RepeatEntryInput, timeZone: string): Promise<WriteResult> {
  return rpc(
    "repeat_diary_entry",
    {
      p_idempotency_key: input.idempotencyKey,
      p_entry_id: input.entryId,
      p_local_date: input.date,
      p_timezone: timeZone,
      p_meal_slot: input.mealSlot ?? null,
    },
    writeResultSchema,
  );
}

/** Sets, changes or removes the member's own goals from `from` onward. Earlier days keep the goal they had. */
export async function saveGoals(input: GoalsInput, from: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  for (const key of ["proteinPerDay", "homeMealsPerWeek"] as const) {
    const target = input[key];
    if (target === undefined) continue;
    const { error } = await supabase.rpc("set_goal", { p_metric: GOAL_METRICS[key], p_target: target, p_effective_from: from });
    if (error) throw toDiaryError(error);
  }
}

/** The member's own note about how fully a day was logged. */
export async function setDayStatus(memberId: string, date: string, status: DayStatus): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("daily_log_status").upsert({ owner_id: memberId, local_date: date, status });
  if (error) throw toDiaryError(error);
}

export async function exportMyData(): Promise<Record<string, unknown>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("export_my_data");
  if (error || !data || typeof data !== "object") throw error ? toDiaryError(error) : new DiaryError(500, "DIARY_UNAVAILABLE");
  return data as Record<string, unknown>;
}

/** USDA FoodData Central foods whose description has every word searched for (meat and fish groups left out). */
export const searchUsdaFoods = (q: string, limit = 8): Promise<UsdaFood[]> =>
  rpc("usda_food_search", { p_q: q.slice(0, 120), p_limit: limit }, usdaSearchSchema);

/** The member's own private copy of a USDA food, made the first time and reused after. */
export const chooseUsdaFood = (releaseId: string, fdcId: number): Promise<{ foodItemId: string; created: boolean }> =>
  rpc("usda_diary_food", { p_release_id: releaseId, p_fdc_id: fdcId }, z.object({ foodItemId: z.string(), created: z.boolean() }));

/** One food of the member's own (docs/56). Anyone else's food, a USDA copy or a removed food: 404. */
export const getOwnFood = (foodItemId: string): Promise<OwnFood> => rpc("my_custom_food", { p_food_item_id: foodItemId }, ownFoodSchema);

/** Saves a change as a new version of the food. Entries already logged keep the numbers they were logged with. */
export function updateOwnFood(input: OwnFoodUpdateInput): Promise<{ foodItemId: string; revisionId: string }> {
  // All five boxes are sent: an empty one is null, stored as "not provided", never zero.
  const nutrients = {
    protein_g: input.proteinG ?? null,
    energy_kcal: input.energyKcal ?? null,
    carb_g: input.carbG ?? null,
    fat_g: input.fatG ?? null,
    fiber_g: input.fiberG ?? null,
  };
  return rpc(
    "update_custom_food",
    {
      p_food_item_id: input.foodItemId,
      p_expected_revision_id: input.expectedRevisionId,
      p_name: input.name,
      p_brand: input.brand || null,
      p_nutrients: nutrients,
      p_serving_label: input.servingLabel || null,
      p_serving_grams: input.servingGrams ?? null,
    },
    z.object({ foodItemId: z.string(), revisionId: z.string() }),
  );
}

/** Takes a food off the member's list, or puts it back. Nothing is deleted. */
export const setOwnFoodRemoved = (foodItemId: string, remove: boolean): Promise<unknown> =>
  rpc("set_custom_food_removed", { p_food_item_id: foodItemId, p_remove: remove }, z.looseObject({ foodItemId: z.string() }));
