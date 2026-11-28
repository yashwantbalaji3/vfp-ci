import "server-only";
import type { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import type { DietPreference } from "@/contracts/catalog";
import {
  HIGH_PROTEIN_G,
  cookSessionSchema,
  cookWriteSchema,
  myCookingSchema,
  planSchema,
  recipeDetailSchema,
  recipeListSchema,
  type CookProgressInput,
  type CookSession,
  type LogCookInput,
  type MyCooking,
  type PlanInput,
  type PlanItem,
  type RecipeDetail,
  type RecipeFilters,
  type RecipeList,
  type RecipeOptions,
  type StartCookInput,
} from "@/contracts/recipes";
import { writeResultSchema, type WriteResult } from "@/contracts/diary";
import { CatalogError } from "@/server/catalog";
import { DiaryError, type DiaryStatus } from "@/server/diary";

/**
 * Server-only access to recipes, cook sessions and the week plan (docs/10).
 * Recipe reads run as the visitor (guest or member) and return only published
 * public recipes. Everything about a person (sessions, plans, logging) runs AS THE
 * SIGNED-IN MEMBER: the database takes the owner from the verified session, never
 * from an argument. The dietary rule, scaling and substitution checks all live in
 * the database, so they cannot differ between screens. Nothing here is logged.
 */
type RpcError = { code?: string; message?: string };
const PRIVATE_STATUS: Record<string, DiaryStatus> = { PT401: 401, PT404: 404, PT409: 409, PT422: 422, PT429: 429, "42501": 401 };

async function publicRpc<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S): Promise<z.output<S>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const e = error as RpcError;
    const status = e.code === "PT404" ? 404 : e.code === "PT422" ? 422 : e.code === "PT429" ? 429 : 500;
    throw new CatalogError(status, status === 500 ? "CATALOG_UNAVAILABLE" : (e.message ?? "INVALID_REQUEST"));
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CatalogError(500, "CATALOG_RESPONSE_INVALID");
  return parsed.data;
}

async function memberRpc<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S): Promise<z.output<S>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const e = error as RpcError;
    const status = PRIVATE_STATUS[e.code ?? ""] ?? 500;
    throw new DiaryError(status, status === 500 ? "COOK_UNAVAILABLE" : e.code === "42501" ? "NOT_SIGNED_IN" : (e.message ?? "INVALID_REQUEST"));
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new DiaryError(500, "COOK_RESPONSE_INVALID");
  return parsed.data;
}

export function listRecipes(filters: RecipeFilters, diet: DietPreference): Promise<RecipeList> {
  return publicRpc(
    "recipe_list",
    {
      p: {
        includeDemo: FLAGS.allowDemoContent,
        q: filters.q || undefined,
        meal: filters.meal,
        cuisine: filters.cuisine,
        minProtein: filters.highProtein ? HIGH_PROTEIN_G : undefined,
        maxMinutes: filters.maxMinutes,
        view: filters.view,
        diet: diet.diet,
        exclusions: diet.exclusions,
        includeConditional: diet.includeConditional,
      },
    },
    recipeListSchema,
  );
}

export function getRecipe(foodItemId: string, options: RecipeOptions, diet: DietPreference): Promise<RecipeDetail> {
  return publicRpc(
    "recipe_detail",
    {
      p_food_item_id: foodItemId,
      p_servings: options.servings ?? null,
      p_swaps: options.swaps,
      p_diet: diet.diet,
      p_exclusions: diet.exclusions,
      p_include_conditional: diet.includeConditional,
      p_include_demo: FLAGS.allowDemoContent,
    },
    recipeDetailSchema,
  );
}

export async function startCookSession(input: StartCookInput, clock: { today: string; timeZone: string }): Promise<string> {
  const r = await memberRpc(
    "start_cook_session",
    {
      p_idempotency_key: input.idempotencyKey,
      p_food_item_id: input.foodItemId,
      p_servings: input.servings ?? null,
      p_swaps: input.swaps,
      p_local_date: clock.today,
      p_timezone: clock.timeZone,
      p_plan_id: input.planId ?? null,
      p_include_demo: FLAGS.allowDemoContent,
    },
    cookWriteSchema,
  );
  if (!r.sessionId) throw new DiaryError(500, "COOK_RESPONSE_INVALID");
  return r.sessionId;
}

export const getCookSession = (sessionId: string): Promise<CookSession> => memberRpc("my_cook_session", { p_session_id: sessionId }, cookSessionSchema);
export const getMyCooking = (today: string): Promise<MyCooking> => memberRpc("my_cooking", { p_today: today }, myCookingSchema);

export async function saveCookProgress(input: CookProgressInput): Promise<void> {
  await memberRpc(
    "save_cook_progress",
    { p_session_id: input.sessionId, p_current_step: input.currentStep, p_checked_ingredients: input.checkedIngredients },
    cookWriteSchema,
  );
}

export async function completeCookSession(sessionId: string, clock: { today: string; timeZone: string }): Promise<void> {
  await memberRpc("complete_cook_session", { p_session_id: sessionId, p_local_date: clock.today, p_timezone: clock.timeZone }, cookWriteSchema);
}
export async function abandonCookSession(sessionId: string): Promise<void> {
  await memberRpc("abandon_cook_session", { p_session_id: sessionId }, cookWriteSchema);
}
export async function declineCookLog(sessionId: string): Promise<void> {
  await memberRpc("decline_cook_log", { p_session_id: sessionId }, cookWriteSchema);
}

/** The one path from cooking to the diary: the member states how much they ate. */
export function logCookSession(input: LogCookInput, timeZone: string): Promise<WriteResult> {
  return memberRpc(
    "log_cook_session",
    {
      p_idempotency_key: input.idempotencyKey,
      p_session_id: input.sessionId,
      p_servings: input.servings,
      p_meal_slot: input.mealSlot,
      p_local_date: input.date,
      p_timezone: timeZone,
      p_additional: input.additional,
    },
    writeResultSchema,
  );
}

export async function planRecipe(input: PlanInput): Promise<string> {
  const r = await memberRpc(
    "plan_recipe",
    { p_food_item_id: input.foodItemId, p_date: input.date, p_servings: input.servings ?? null, p_meal_slot: input.mealSlot ?? null, p_include_demo: FLAGS.allowDemoContent },
    cookWriteSchema,
  );
  if (!r.planId) throw new DiaryError(500, "COOK_RESPONSE_INVALID");
  return r.planId;
}
export async function removePlan(planId: string): Promise<void> {
  await memberRpc("remove_plan", { p_plan_id: planId }, cookWriteSchema);
}
export const getPlan = (from: string, to: string): Promise<PlanItem[]> => memberRpc("my_plan", { p_from: from, p_to: to }, planSchema);
