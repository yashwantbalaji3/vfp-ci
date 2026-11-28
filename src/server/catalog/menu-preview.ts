import "server-only";
import { cache } from "react";
import { z } from "zod";
import { FLAGS } from "@/config/flags";
import { builderFor, type Builder } from "@/contracts/meal-builder";
import { distinctBranchNames, previewIndexSchema, previewMeals, type PreviewIndexEntry, type PreviewMeal } from "@/contracts/menu-preview";
import { menuPlaceSchema, type MenuPlace } from "@/contracts/menu-review";
import { getMenuPlace } from "@/server/catalog/menu-review";
import { SocialError, rpc } from "@/server/social";

/**
 * The founder-only private beta on real data (docs/59). Every call runs as the signed-in person and the
 * database refuses anyone but the founder (FOUNDER_ONLY), so an ordinary account or a visitor gets
 * null here and sees nothing of the drafted menus. Only available where the real-place preview is on.
 * No privileged key is used and nothing is written.
 */
export type PreviewPlace = PreviewIndexEntry & { meals: PreviewMeal[]; otherRows: number };

/**
 * Who is reading: the founder (every drafted menu), a signed-in member while the staged local member beta is on
 * (owner decision 22 Nov 2026 15:26 UTC; migration 20261122000600: only the enrolled places, and only facts the
 * founder verified or the automatic page comparison found), or nobody.
 */
export type PreviewAudience = "founder" | "member_beta";
const access = cache(async (): Promise<{ audience: PreviewAudience; entries: PreviewIndexEntry[] } | null> => {
  if (!FLAGS.realCatalogPreview) return null;
  try {
    return { audience: "founder", entries: distinctBranchNames(await rpc("menu_preview_index", {}, previewIndexSchema)) };
  } catch (e) {
    if (!(e instanceof SocialError && (e.status === 401 || e.status === 403))) throw e;
    if (e.status === 401) return null;
  }
  try {
    return { audience: "member_beta", entries: distinctBranchNames(await rpc("member_beta_index", {}, previewIndexSchema)) };
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
});
const index = cache(async (): Promise<PreviewIndexEntry[] | null> => (await access())?.entries ?? null);
/** "founder", "member_beta", or null when the signed-in person sees no real menus. */
export const getPreviewAudience = cache(async (): Promise<PreviewAudience | null> => (await access())?.audience ?? null);

const menuFor = cache(async (placeId: string) =>
  (await getPreviewAudience()) === "member_beta" ? rpc("member_beta_place", { p_place: placeId }, menuPlaceSchema) : getMenuPlace(placeId),
);

const place = cache(async (entry: PreviewIndexEntry): Promise<PreviewPlace> => {
  const p = await menuFor(entry.placeId);
  const meals = previewMeals(p);
  return { ...entry, meals, otherRows: p.dishes.length - meals.length };
});

/** Null unless the signed-in person is the founder. */
export const getPreviewIndex = index;

/** Every linked researched place with its meals, or null unless the signed-in person is the founder. */
export const getPreviewPlaces = cache(async (): Promise<PreviewPlace[] | null> => {
  const entries = await index();
  if (!entries) return null;
  return Promise.all(entries.map((e) => place(e)));
});

/** The researched menu behind one catalog place, or null (not the founder, or no researched menu). */
export async function getPreviewForSlug(slug: string): Promise<PreviewPlace | null> {
  const entries = await index();
  const entry = entries?.find((e) => e.slug === slug);
  return entry ? place(entry) : null;
}

const savedSchema = z.array(z.string().uuid());
/** The founder's saved preview meals (dish ids), or an empty list for anyone else. */
export async function getSavedMeals(): Promise<string[]> {
  try {
    return await rpc("menu_preview_saved", {}, savedSchema);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return [];
    throw e;
  }
}
const plannedSchema = z.array(
  z.object({ planId: z.string().uuid(), dishId: z.string().uuid(), date: z.string(), mealSlot: z.enum(["breakfast", "lunch", "dinner", "snack"]).nullable() }),
);
export type PlannedMeal = z.infer<typeof plannedSchema>[number];
/** The founder's real restaurant meals planned between two dates (the week plan), or none for anyone else. */
export async function getPlannedMeals(from: string, to: string): Promise<PlannedMeal[]> {
  if (!FLAGS.realCatalogPreview) return [];
  try {
    return await rpc("menu_preview_plans", { p_from: from, p_to: to }, plannedSchema);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return [];
    throw e;
  }
}
export const planMeal = (dishId: string, date: string, slot: string | null) =>
  rpc("menu_preview_plan", { p_dish: dishId, p_date: date, p_slot: slot }, z.object({ planId: z.string().uuid() }));
export const unplanMeal = (planId: string) => rpc("menu_preview_unplan", { p_plan: planId }, z.object({ planId: z.string().uuid(), removed: z.boolean() }));
export const saveMeal = (dishId: string, saved: boolean) =>
  rpc("menu_preview_save", { p_dish: dishId, p_saved: saved }, z.object({ dishId: z.string().uuid(), saved: z.boolean() }));

/**
 * One real meal for its own page, with the place it belongs to. Null unless the signed-in person is the
 * founder and the meal is a complete or build-your-own meal at a place in the preview.
 */
export async function getPreviewMeal(dishId: string): Promise<{ place: PreviewPlace; menu: MenuPlace; meal: PreviewMeal | null; builder: Builder | null } | null> {
  const entries = await index();
  if (!entries) return null;
  // Every menu at once, not one after another (P2 part 2 speed): the page waited on each place in turn.
  const menus = await Promise.all(entries.map((e) => menuFor(e.placeId)));
  for (const [i, e] of entries.entries()) {
    const menu = menus[i];
    if (!menu.dishes.some((d) => d.dishId === dishId)) continue;
    const p = await place(e);
    const meal = p.meals.find((m) => m.dishId === dishId) ?? null;
    const builder = meal ? null : builderFor(menu, dishId);
    return meal || builder ? { place: p, menu, meal, builder } : null;
  }
  return null;
}

/** The build-your-own meals at a place (none at most places). */
export async function getBuilders(placeId: string): Promise<Builder[]> {
  const menu = await menuFor(placeId);
  return menu.dishes.filter((d) => d.structure?.type === "customizable_meal").map((d) => builderFor(menu, d.dishId)!).filter(Boolean);
}

const okOrEmpty = async <T,>(f: () => Promise<T>, empty: T): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return empty;
    throw e;
  }
};

const entriesSchema = z.array(z.object({ dishId: z.string().uuid(), addedAt: z.string() }));
/** The real meals on one of the founder's own lists (empty for anyone else). Only the owner ever sees them. */
export const getListMeals = (listId: string) => okOrEmpty(() => rpc("menu_preview_list_entries", { p_list: listId }, entriesSchema), []);
const mealListsSchema = z.array(z.object({ listId: z.string().uuid(), title: z.string() }));
/** Which of the founder's lists hold this meal. */
export const getMealLists = (dishId: string) => okOrEmpty(() => rpc("menu_preview_meal_lists", { p_dish: dishId }, mealListsSchema), []);
export const setListMeal = (listId: string, dishId: string, on: boolean) =>
  rpc("menu_preview_list_set", { p_list: listId, p_dish: dishId, p_on: on }, z.object({ listId: z.string(), dishId: z.string(), on: z.boolean() }));

export const mealReviewSchema = z.object({
  dishId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  body: z.string().nullable(),
  visitDate: z.string().nullable(),
  version: z.number().int(),
  updatedAt: z.string(),
});
export type MealReview = z.infer<typeof mealReviewSchema>;
/** The founder's own private reviews of real meals. */
export const getMealReviews = () => okOrEmpty(() => rpc("menu_preview_reviews", {}, z.array(mealReviewSchema)), []);
export const setMealReview = (dishId: string, rating: number, body: string | null, visitDate: string | null) =>
  rpc("menu_preview_review_set", { p_dish: dishId, p_rating: rating, p_body: body, p_visit_date: visitDate }, z.object({ dishId: z.string(), rating: z.number(), version: z.number() }));
export const deleteMealReview = (dishId: string) => rpc("menu_preview_review_delete", { p_dish: dishId }, z.object({ dishId: z.string(), deleted: z.boolean() }));

/** Every preview meal by id, for Saved, lists and reviews. Null unless the founder. */
export const getPreviewMealIndex = cache(async (): Promise<Map<string, { meal: PreviewMeal | null; builder: Builder | null; place: PreviewPlace }> | null> => {
  const places = await getPreviewPlaces();
  if (!places) return null;
  const out = new Map<string, { meal: PreviewMeal | null; builder: Builder | null; place: PreviewPlace }>();
  for (const p of places) {
    for (const m of p.meals) out.set(m.dishId, { meal: m, builder: null, place: p });
    for (const b of await getBuilders(p.placeId)) out.set(b.dishId, { meal: null, builder: b, place: p });
  }
  return out;
});

const waitingSchema = z.array(
  z.object({ label: z.string(), candidateId: z.string().uuid(), name: z.string(), street: z.string().nullable(), postcode: z.string().nullable(), quality: z.string(), listing: z.string().nullable() }),
);
export type WaitingMenu = z.infer<typeof waitingSchema>[number];
/** Linked menus whose catalog place is not in the preview yet (most often: waiting for the founder's identity check). Founder only. */
export const getWaitingMenus = () => okOrEmpty(() => rpc("menu_preview_waiting", {}, waitingSchema), [] as WaitingMenu[]);
