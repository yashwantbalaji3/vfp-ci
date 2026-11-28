"use server";
import { redirect } from "next/navigation";
import type { z } from "zod";
import {
  customFoodInputSchema,
  dayStatusInputSchema,
  deleteEntryInputSchema,
  goalsInputSchema,
  isoDateSchema,
  logEntryInputSchema,
  ownFoodRemoveInputSchema,
  ownFoodUpdateInputSchema,
  repeatEntryInputSchema,
  updateEntryInputSchema,
  usdaChooseInputSchema,
  MEAL_SLOTS,
} from "@/contracts/diary";
import { idSchema } from "@/contracts/catalog";
import { getCurrentMember } from "@/server/auth/session";
import {
  DiaryError,
  chooseUsdaFood,
  deleteEntry,
  logCustomFood,
  logRealMeal,
  logEntry,
  repeatEntry,
  restoreEntry,
  saveGoals,
  setDayStatus,
  setOwnFoodRemoved,
  updateEntry,
  updateOwnFood,
} from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { getPreviewMeal } from "@/server/catalog/menu-preview";
import { headers } from "next/headers";
import { withinActionLimit } from "@/server/rate-limit";

/**
 * Diary and goals form actions. Each one checks the session itself, validates the
 * form with the shared contracts and then calls the server layer, which acts as
 * the member. A guest is sent to sign in; nothing is ever logged on their behalf.
 */
/** `values` echoes what was typed, so a form with a mistake comes back filled in rather than empty. */
export type FormState = { status: "idle" | "error"; message?: string; fields?: Record<string, string>; values?: Record<string, string> };

const MESSAGES: Record<string, string> = {
  VERSION_CONFLICT: "This entry was changed somewhere else. Go back to your diary and try again.",
  UNSUPPORTED_MASS_CONVERSION: "We don't have a serving weight for this food, so it can't be logged in grams. Choose a portion instead.",
  FOOD_NOT_FOUND: "This food is no longer available.",
  ENTRY_NOT_FOUND: "We couldn't find that entry. It may have been removed.",
  SOURCE_FOOD_DELETED: "The food this entry came from was removed, so its amount can't be changed. You can still remove the entry.",
  INVALID_PORTION: "That portion is no longer offered for this food. Go back and choose again.",
  INVALID_AMOUNT: "Enter an amount more than 0.",
  INVALID_CUSTOM_FOOD: "Something in the food details isn't valid. Check the numbers and try again.",
  INVALID_NAME: "Give it a name.",
  INVALID_NUTRIENT_VALUE: "One of the nutrition numbers isn't valid.",
  CUSTOM_FOOD_LIMIT: "You've reached the limit for foods of your own.",
  GOAL_OUT_OF_RANGE: "That goal is outside the range we can save.",
  IDEMPOTENCY_KEY_REUSED: "This form was already used for something else. Reload the page and try again.",
  MORE_THAN_COOKED: "That is more than you cooked. Enter a smaller amount.",
  UNDO_EXPIRED: "It's too late to undo that. You can log it again.",
  NOT_EDITABLE: "This food can't be changed here.",
};
const messageFor = (e: unknown) =>
  e instanceof DiaryError ? (MESSAGES[e.code] ?? (e.status === 401 ? "Please sign in again." : "We couldn't save that just now. Please try again.")) : null;

function fieldsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? "form")] ??= issue.message;
  return out;
}
function echo(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$") && v.length <= 300) out[k] = v;
  return out;
}
const invalid = (error: z.ZodError, fd: FormData): FormState => ({
  status: "error",
  message: "Please check the highlighted fields.",
  fields: fieldsOf(error),
  values: echo(fd),
});
const text = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const dayPath = (date: string, extra: Record<string, string> = {}) => `/diary?${new URLSearchParams({ date, ...extra }).toString()}`;

async function requireMember(next: string) {
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(next)}`);
  // Per member (docs/14 PH-03): a burst of form presses is refused before anything is written.
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  return member;
}

export async function logEntryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireMember(text(fd, "here") ?? "/diary");
  const byGrams = fd.get("portionId") === "grams";
  const parsed = logEntryInputSchema.safeParse({
    idempotencyKey: fd.get("idempotencyKey"),
    revisionId: fd.get("revisionId"),
    portionId: byGrams ? undefined : text(fd, "portionId"),
    quantity: byGrams ? undefined : text(fd, "quantity"),
    grams: byGrams ? (text(fd, "grams") ?? "") : undefined,
    context: fd.get("context"),
    mealSlot: fd.get("mealSlot"),
    date: fd.get("date"),
  });
  if (!parsed.success) return invalid(parsed.error, fd);
  try {
    await logEntry(parsed.data, (await memberClock()).timeZone);
  } catch (e) {
    const message = messageFor(e);
    if (!message) throw e;
    return { status: "error", message, values: echo(fd) };
  }
  // The day page may offer a next step for a restaurant dish (rate it, open its place). The id is only a
  // pointer: the page looks the food up again as the member, and nothing is shared or posted.
  const food = idSchema.safeParse(fd.get("foodItemId"));
  redirect(dayPath(parsed.data.date, food.success ? { done: "logged", food: food.data } : { done: "logged" }));
}

export async function logCustomFoodAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireMember(text(fd, "here") ?? "/diary");
  const parsed = customFoodInputSchema.safeParse({
    idempotencyKey: fd.get("idempotencyKey"),
    name: fd.get("name") ?? "",
    brand: text(fd, "brand"),
    servingLabel: text(fd, "servingLabel"),
    servingGrams: fd.get("servingGrams") ?? "",
    quantity: text(fd, "quantity") ?? "",
    proteinG: fd.get("proteinG") ?? "",
    energyKcal: fd.get("energyKcal") ?? "",
    carbG: fd.get("carbG") ?? "",
    fatG: fd.get("fatG") ?? "",
    fiberG: fd.get("fiberG") ?? "",
    context: fd.get("context"),
    mealSlot: fd.get("mealSlot"),
    date: fd.get("date"),
  });
  if (!parsed.success) return invalid(parsed.error, fd);
  const mealId = idSchema.safeParse(fd.get("mealId"));
  try {
    if (mealId.success) {
      // A real restaurant meal: the source is read again on the server, never taken from the form (docs/63).
      const found = await getPreviewMeal(mealId.data);
      if (!found?.meal) return { status: "error", message: "This meal isn't available to log any more.", values: echo(fd) };
      const p = found.meal.protein;
      const usda = p.basis === "usda_range" && p.low !== null && p.high !== null ? { low: p.low, high: p.high, confidence: p.usda?.confidence ?? null } : null;
      await logRealMeal({ ...parsed.data, mealId: mealId.data, usda }, (await memberClock()).timeZone);
    } else await logCustomFood(parsed.data, (await memberClock()).timeZone);
  } catch (e) {
    const message = messageFor(e);
    if (!message) throw e;
    return { status: "error", message, values: echo(fd) };
  }
  redirect(dayPath(parsed.data.date, { done: "logged" }));
}

export async function updateEntryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireMember("/diary");
  const byGrams = fd.get("mode") === "grams";
  const cooked = fd.get("mode") === "cooked";
  const parsed = updateEntryInputSchema.safeParse({
    cooked: cooked || undefined,
    entryId: fd.get("entryId"),
    expectedVersion: fd.get("expectedVersion"),
    portionId: byGrams || cooked ? undefined : text(fd, "portionId"),
    quantity: byGrams ? undefined : (text(fd, "quantity") ?? ""),
    grams: byGrams ? (text(fd, "quantity") ?? "") : undefined,
    mealSlot: text(fd, "mealSlot"),
    date: text(fd, "date"),
  });
  if (!parsed.success) return invalid(parsed.error, fd);
  try {
    await updateEntry(parsed.data);
  } catch (e) {
    const message = messageFor(e);
    if (!message) throw e;
    return { status: "error", message, values: echo(fd) };
  }
  redirect(dayPath(parsed.data.date ?? (text(fd, "originalDate") as string), { done: "updated" }));
}

export async function deleteEntryAction(fd: FormData) {
  await requireMember("/diary");
  const date = isoDateSchema.safeParse(fd.get("date"));
  const parsed = deleteEntryInputSchema.safeParse({ entryId: fd.get("entryId"), expectedVersion: fd.get("expectedVersion") });
  if (!parsed.success || !date.success) redirect("/diary?problem=invalid");
  let problem: string | null = null;
  try {
    await deleteEntry(parsed.data.entryId, parsed.data.expectedVersion);
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    problem = e.status === 409 ? "conflict" : "failed";
  }
  redirect(dayPath(date.data, problem ? { problem } : { deleted: parsed.data.entryId }));
}

export async function restoreEntryAction(fd: FormData) {
  await requireMember("/diary");
  const date = isoDateSchema.safeParse(fd.get("date"));
  const parsed = deleteEntryInputSchema.shape.entryId.safeParse(fd.get("entryId"));
  if (!parsed.success || !date.success) redirect("/diary?problem=invalid");
  let problem: string | null = null;
  try {
    await restoreEntry(parsed.data);
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    problem = e.code === "UNDO_EXPIRED" ? "undo_expired" : "failed";
  }
  redirect(dayPath(date.data, problem ? { problem } : { done: "restored" }));
}

/** Logs a past entry again on the chosen day. The original entry is never changed. */
export async function repeatEntryAction(fd: FormData) {
  await requireMember("/diary");
  const parsed = repeatEntryInputSchema.safeParse({
    idempotencyKey: fd.get("idempotencyKey"),
    entryId: fd.get("entryId"),
    date: fd.get("date"),
    mealSlot: text(fd, "mealSlot"),
  });
  if (!parsed.success) redirect("/diary?problem=invalid");
  let outcome: Record<string, string>;
  try {
    const result = await repeatEntry(parsed.data, (await memberClock()).timeZone);
    outcome = { done: result.basis === "updated" ? "repeated_updated" : result.basis === "copied" ? "repeated_copied" : "repeated" };
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    outcome = { problem: e.code === "PORTION_CHANGED" ? "portion_changed" : e.status === 404 ? "missing" : "failed" };
  }
  // Logging again from Today returns to Today (docs/68, L1); "back" is a fixed word, never a free address.
  redirect(fd.get("back") === "today" ? `/today?${new URLSearchParams(outcome).toString()}` : dayPath(parsed.data.date, outcome));
}

export async function saveGoalsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireMember("/diary/goals");
  const parsed = goalsInputSchema.safeParse({ proteinPerDay: fd.get("proteinPerDay") ?? "", homeMealsPerWeek: fd.get("homeMealsPerWeek") ?? "" });
  if (!parsed.success) return invalid(parsed.error, fd);
  try {
    await saveGoals(parsed.data, (await memberClock()).today);
  } catch (e) {
    const message = messageFor(e);
    if (!message) throw e;
    return { status: "error", message, values: echo(fd) };
  }
  redirect("/diary/goals?done=saved");
}

export async function setDayStatusAction(fd: FormData) {
  const member = await requireMember("/diary");
  const parsed = dayStatusInputSchema.safeParse({ date: fd.get("date"), status: fd.get("status") });
  if (!parsed.success) redirect("/diary?problem=invalid");
  let problem: string | null = null;
  try {
    await setDayStatus(member.id, parsed.data.date, parsed.data.status);
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    problem = "failed";
  }
  redirect(dayPath(parsed.data.date, problem ? { problem } : { done: "noted" }));
}

/**
 * "Choose" on a USDA FoodData Central result: makes (or reuses) the member's private copy of that food,
 * then opens the ordinary log form for it. Nothing is logged until the member presses Log on that form.
 */
export async function chooseUsdaFoodAction(fd: FormData) {
  const date = isoDateSchema.safeParse(fd.get("date")).data;
  const slot = text(fd, "slot");
  const target = new URLSearchParams();
  if (date) target.set("date", date);
  if (slot && (MEAL_SLOTS as readonly string[]).includes(slot)) target.set("slot", slot);
  const back = `/diary/add?${target.toString()}`;
  await requireMember(back);
  const parsed = usdaChooseInputSchema.safeParse({ releaseId: fd.get("releaseId"), fdcId: fd.get("fdcId") });
  if (!parsed.success) redirect(`${back}&problem=usda`);
  let foodItemId: string;
  try {
    foodItemId = (await chooseUsdaFood(parsed.data.releaseId, parsed.data.fdcId)).foodItemId;
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    redirect(`${back}&problem=${e.code === "CUSTOM_FOOD_LIMIT" ? "usda_limit" : "usda"}`);
  }
  target.set("food", foodItemId);
  redirect(`/diary/log?${target.toString()}`);
}

/**
 * Change a food of one's own (docs/56). Saved as a new version: entries already in the diary keep the
 * numbers they were logged with. A form opened before another change is refused rather than overwriting it.
 */
export async function updateOwnFoodAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = idSchema.safeParse(fd.get("foodItemId"));
  await requireMember(id.success ? `/diary/foods/${id.data}` : "/diary/foods");
  const parsed = ownFoodUpdateInputSchema.safeParse({
    foodItemId: fd.get("foodItemId"),
    expectedRevisionId: fd.get("expectedRevisionId"),
    name: fd.get("name") ?? "",
    brand: text(fd, "brand"),
    servingLabel: text(fd, "servingLabel"),
    servingGrams: fd.get("servingGrams") ?? "",
    proteinG: fd.get("proteinG") ?? "",
    energyKcal: fd.get("energyKcal") ?? "",
    carbG: fd.get("carbG") ?? "",
    fatG: fd.get("fatG") ?? "",
    fiberG: fd.get("fiberG") ?? "",
  });
  if (!parsed.success) return invalid(parsed.error, fd);
  try {
    await updateOwnFood(parsed.data);
  } catch (e) {
    if (e instanceof DiaryError && e.code === "VERSION_CONFLICT") {
      return { status: "error", message: "This food was changed somewhere else. Reload the page to see the latest version, then try again.", values: echo(fd) };
    }
    const message = messageFor(e);
    if (!message) throw e;
    return { status: "error", message, values: echo(fd) };
  }
  redirect(`/diary/foods?${new URLSearchParams({ done: "changed", food: parsed.data.foodItemId }).toString()}`);
}

/** Take a food of one's own off the list, or put it back (the "Undo" after removing). Nothing is deleted. */
export async function setOwnFoodRemovedAction(fd: FormData): Promise<void> {
  await requireMember("/diary/foods");
  const parsed = ownFoodRemoveInputSchema.safeParse({ foodItemId: fd.get("foodItemId"), remove: fd.get("remove") });
  if (!parsed.success) redirect("/diary/foods?problem=invalid");
  try {
    await setOwnFoodRemoved(parsed.data.foodItemId, parsed.data.remove);
  } catch (e) {
    if (e instanceof DiaryError && e.status === 404) redirect("/diary/foods?problem=missing");
    if (e instanceof DiaryError && e.status !== 500) redirect("/diary/foods?problem=failed");
    throw e;
  }
  redirect(`/diary/foods?${new URLSearchParams({ done: parsed.data.remove ? "removed" : "restored", food: parsed.data.foodItemId }).toString()}`);
}
