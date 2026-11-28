"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { FLAGS } from "@/config/flags";
import { getCurrentMember } from "@/server/auth/session";
import { deleteMealReview, planMeal, saveMeal, setListMeal, setMealReview, unplanMeal } from "@/server/catalog/menu-preview";
import { safeReturn } from "@/lib/preview-paths";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError, saveList } from "@/server/social";

/**
 * The founder's own actions on real meals in the private preview (docs/59, docs/60): save, put on a list,
 * rate and review. All of them stay private to the founder; nothing is shared or published.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const withMsg = (to: string, k: "m" | "e", v: string) => {
  const u = new URL(to, "http://local");
  u.searchParams.delete("m");
  u.searchParams.delete("e");
  u.searchParams.set(k, v);
  return `${u.pathname}${u.search}${u.hash}`;
};
/** Only pages that show real meals may be returned to. */
const back = (v: FormDataEntryValue | null) => safeReturn(v);

async function guard(formData: FormData) {
  const to = back(formData.get("returnTo"));
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(to)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const dish = formData.get("dishId");
  if (typeof dish !== "string" || !UUID.test(dish)) redirect(to);
  return { to, dish };
}
async function run(to: string, ok: string, f: () => Promise<unknown>) {
  try {
    await f();
  } catch (e) {
    if (e instanceof SocialError) redirect(withMsg(to, "e", e.code));
    throw e;
  }
  redirect(withMsg(to, "m", ok));
}

/** Save or unsave a meal. */
export async function saveMealAction(formData: FormData) {
  const { to, dish } = await guard(formData);
  const saved = formData.get("saved") === "yes";
  await run(to, saved ? "meal_saved" : "meal_unsaved", () => saveMeal(dish, saved));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLOTS = ["breakfast", "lunch", "dinner", "snack"];
/** Put a real meal on a day of the week plan, or take a planned one off. Nothing is logged. */
export async function planMealAction(formData: FormData) {
  const { to, dish } = await guard(formData);
  const planId = formData.get("planId");
  if (typeof planId === "string" && UUID.test(planId)) {
    await run(to, "meal_unplanned", () => unplanMeal(planId));
    return;
  }
  const date = formData.get("date");
  const slot = formData.get("slot");
  if (typeof date !== "string" || !DATE.test(date)) redirect(withMsg(to, "e", "INVALID_DATE"));
  await run(to, "meal_planned", () => planMeal(dish, date as string, typeof slot === "string" && SLOTS.includes(slot) ? slot : null));
}

/** Put a meal on one of your lists, start a new private list with it, or take it off a list. */
export async function mealListAction(formData: FormData) {
  const { to, dish } = await guard(formData);
  const op = formData.get("op");
  const list = formData.get("listId");
  if (op === "new") {
    const title = String(formData.get("title") ?? "").trim();
    if (!title || title.length > 80) redirect(withMsg(to, "e", "TITLE_REQUIRED"));
    await run(to, "meal_listed", async () => {
      const created = await saveList({ title });
      await setListMeal(created.listId, dish, true);
    });
  }
  if (typeof list !== "string" || !UUID.test(list)) redirect(to);
  await run(to, op === "remove" ? "meal_unlisted" : "meal_listed", () => setListMeal(list, dish, op !== "remove"));
}

/** Rate and review a meal (always private), or delete the review. */
export async function mealReviewAction(formData: FormData) {
  const { to, dish } = await guard(formData);
  if (formData.get("op") === "delete") {
    await run(to, "meal_review_deleted", () => deleteMealReview(dish));
  }
  const rating = Number(formData.get("rating"));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) redirect(withMsg(to, "e", "INVALID_RATING"));
  const body = String(formData.get("body") ?? "").trim() || null;
  const visit = String(formData.get("visitDate") ?? "").trim() || null;
  if (visit && !/^\d{4}-\d{2}-\d{2}$/.test(visit)) redirect(withMsg(to, "e", "INVALID_DATE"));
  await run(to, "meal_reviewed", () => setMealReview(dish, rating, body, visit));
}
