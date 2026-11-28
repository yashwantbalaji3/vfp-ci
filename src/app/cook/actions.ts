"use server";
import { redirect } from "next/navigation";
import { cookProgressInputSchema, idInputSchema, logCookInputSchema, planInputSchema, startCookInputSchema, swapsSchema } from "@/contracts/recipes";
import { safeReturnPath } from "@/lib/format";
import { getCurrentMember } from "@/server/auth/session";
import { DiaryError } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { headers } from "next/headers";
import { withinActionLimit } from "@/server/rate-limit";
import {
  abandonCookSession,
  completeCookSession,
  declineCookLog,
  logCookSession,
  planRecipe,
  removePlan,
  saveCookProgress,
  startCookSession,
} from "@/server/recipes";

/**
 * Cooking form actions. Each one checks the session itself, validates the form with
 * the shared contracts and then calls the server layer, which acts as the member.
 * A guest is sent to sign in and brought back; nothing is started, planned or logged
 * on their behalf. Finishing a cook session never writes to the diary: only
 * logCookAction does, and only with the amount the member typed.
 */
export type CookFormState = { status: "idle" | "error"; message?: string; fields?: Record<string, string>; values?: Record<string, string> };

const MESSAGES: Record<string, string> = {
  RECIPE_NOT_FOUND: "This recipe is no longer available.",
  SESSION_NOT_FOUND: "We couldn't find that cooking session.",
  SESSION_CLOSED: "This cooking session is already finished.",
  INVALID_SUBSTITUTION: "That swap isn't one of the approved options for this recipe.",
  SUBSTITUTION_EXCLUDED: "That swap contains something your dietary filter leaves out, so we haven't started. Choose a different option.",
  INVALID_SERVINGS: "Choose between a quarter serving and 100 servings.",
  COOK_NOT_FINISHED: "Finish cooking first, then tell us how much you ate.",
  ALREADY_LOGGED: "This meal is already in your diary. Use “Log more from this batch” if you ate more later.",
  MORE_THAN_COOKED: "That's more than the servings you cooked in this batch.",
  INVALID_AMOUNT: "Enter an amount more than 0.",
  INVALID_DATE: "Choose a day within the next year.",
  PLAN_NOT_FOUND: "That plan was already removed.",
  TOO_MANY_PLANS: "Your plan is full. Remove something first.",
  IDEMPOTENCY_KEY_REUSED: "This form was already used. Reload the page and try again.",
};
const wordsFor = (e: unknown) =>
  e instanceof DiaryError ? (MESSAGES[e.code] ?? (e.status === 401 ? "Please sign in again." : "We couldn't save that just now. Please try again.")) : null;

const text = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
function echo(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$") && v.length <= 300) out[k] = v;
  return out;
}
function swapsOf(fd: FormData) {
  try {
    return swapsSchema.safeParse(JSON.parse(text(fd, "swaps") ?? "{}"));
  } catch {
    return swapsSchema.safeParse(null);
  }
}
async function requireMember(next: string) {
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(safeReturnPath(next, "/cook"))}`);
  // Per member (docs/14 PH-03): a burst of form presses is refused before anything is written.
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  return member;
}
const withNote = (path: string, key: string, value: string) => {
  const [p, q = ""] = path.split("?");
  const params = new URLSearchParams(q);
  params.set(key, value);
  return `${p}?${params.toString()}`;
};

/** Start (or start over) a cook session for the recipe exactly as shown: servings and swaps included. */
export async function startCookAction(fd: FormData) {
  const here = safeReturnPath(text(fd, "here"), "/cook");
  await requireMember(here);
  const swaps = swapsOf(fd);
  const parsed = startCookInputSchema.safeParse({
    idempotencyKey: fd.get("idempotencyKey"),
    foodItemId: fd.get("foodItemId"),
    servings: text(fd, "servings"),
    swaps: swaps.success ? swaps.data : undefined,
    planId: text(fd, "planId"),
  });
  if (!parsed.success || !swaps.success) redirect(withNote(here, "note", "invalid"));
  const replace = idInputSchema.safeParse(text(fd, "replaceSessionId"));
  let sessionId: string;
  try {
    if (replace.success) await abandonCookSession(replace.data).catch(() => undefined);
    sessionId = await startCookSession(parsed.data, await memberClock());
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    redirect(withNote(here, "note", e.code === "SUBSTITUTION_EXCLUDED" ? "excluded" : e.code === "RECIPE_NOT_FOUND" ? "gone" : "failed"));
  }
  redirect(`/cook/session/${sessionId}`);
}

/** Called by cook mode as the cook moves on, so a reload or another device resumes at the same place. */
export async function saveCookProgressAction(input: { sessionId: string; currentStep: number; checkedIngredients: string[] }): Promise<{ ok: boolean }> {
  const member = await getCurrentMember();
  const parsed = cookProgressInputSchema.safeParse(input);
  if (!member || !parsed.success) return { ok: false };
  try {
    await saveCookProgress(parsed.data);
    return { ok: true };
  } catch (e) {
    if (e instanceof DiaryError) return { ok: false };
    throw e;
  }
}

/** Finishing records the cooking. It writes nothing to the diary; the next screen asks, and "Not now" is always there. */
export async function finishCookAction(fd: FormData) {
  const id = idInputSchema.safeParse(fd.get("sessionId"));
  if (!id.success) redirect("/cook");
  await requireMember(`/cook/session/${id.data}`);
  try {
    await completeCookSession(id.data, await memberClock());
  } catch (e) {
    if (!(e instanceof DiaryError)) throw e;
    redirect(e.status === 404 ? "/cook?note=gone" : `/cook/session/${id.data}`);
  }
  redirect(`/cook/session/${id.data}/done`);
}

export async function abandonCookAction(fd: FormData) {
  const id = idInputSchema.safeParse(fd.get("sessionId"));
  if (!id.success) redirect("/cook");
  await requireMember("/cook");
  await abandonCookSession(id.data).catch((e) => {
    if (!(e instanceof DiaryError)) throw e;
  });
  redirect("/cook?note=stopped");
}

/** "Not now": nothing is logged. The session stays under "Cooked recently" in case they change their mind. */
export async function declineLogAction(fd: FormData) {
  const id = idInputSchema.safeParse(fd.get("sessionId"));
  if (!id.success) redirect("/cook");
  await requireMember(`/cook/session/${id.data}/done`);
  await declineCookLog(id.data).catch((e) => {
    if (!(e instanceof DiaryError)) throw e;
  });
  redirect("/cook?note=cooked");
}

export async function logCookAction(_prev: CookFormState, fd: FormData): Promise<CookFormState> {
  const sessionId = text(fd, "sessionId") ?? "";
  await requireMember(`/cook/session/${sessionId}/done`);
  const choice = text(fd, "servingsChoice");
  const parsed = logCookInputSchema.safeParse({
    idempotencyKey: fd.get("idempotencyKey"),
    sessionId,
    servings: choice && choice !== "other" ? choice : (text(fd, "servingsOther") ?? ""),
    mealSlot: fd.get("mealSlot"),
    date: fd.get("date"),
    additional: fd.get("additional") === "1",
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? "form")] ??= issue.message;
    return { status: "error", message: "Please check the highlighted fields.", fields, values: echo(fd) };
  }
  try {
    await logCookSession(parsed.data, (await memberClock()).timeZone);
  } catch (e) {
    const message = wordsFor(e);
    if (!message) throw e;
    const field = e instanceof DiaryError && (e.code === "MORE_THAN_COOKED" || e.code === "INVALID_AMOUNT") ? { servings: message } : undefined;
    return { status: "error", message, fields: field, values: echo(fd) };
  }
  redirect(`/diary?${new URLSearchParams({ date: parsed.data.date, done: "logged" }).toString()}`);
}

export async function planRecipeAction(_prev: CookFormState, fd: FormData): Promise<CookFormState> {
  const here = safeReturnPath(text(fd, "here"), "/cook");
  await requireMember(here);
  const parsed = planInputSchema.safeParse({
    foodItemId: fd.get("foodItemId"),
    date: fd.get("date"),
    servings: text(fd, "servings"),
    mealSlot: text(fd, "mealSlot"),
  });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? "form")] ??= issue.message;
    return { status: "error", message: "Please check the highlighted fields.", fields, values: echo(fd) };
  }
  try {
    await planRecipe(parsed.data);
  } catch (e) {
    const message = wordsFor(e);
    if (!message) throw e;
    return { status: "error", message, fields: e instanceof DiaryError && e.code === "INVALID_DATE" ? { date: message } : undefined, values: echo(fd) };
  }
  redirect(`/cook/plan?${new URLSearchParams({ date: parsed.data.date, note: "planned" }).toString()}`);
}

export async function removePlanAction(fd: FormData) {
  const id = idInputSchema.safeParse(fd.get("planId"));
  await requireMember("/cook/plan");
  if (id.success) {
    await removePlan(id.data).catch((e) => {
      if (!(e instanceof DiaryError)) throw e;
    });
  }
  redirect("/cook/plan?note=removed");
}
