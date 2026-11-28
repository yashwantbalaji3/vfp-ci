import "server-only";
import type { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import type { DietPreference } from "@/contracts/catalog";
import {
  collectionsSchema,
  connectionsSchema,
  correctionsQueueSchema,
  feedSchema,
  findPeopleSchema,
  listViewSchema,
  moderationQueueSchema,
  myListsSchema,
  myProfileSchema,
  myRankingSchema,
  myReviewsSchema,
  profileViewSchema,
  recommendationsSchema,
  suggestedPeopleSchema,
  targetReviewsSchema,
  writeSchema,
  type Audience,
  type ListItemsInput,
  type ModerateInput,
  type ProfileInput,
  type ReportInput,
  type SocialView,
  type TargetKind,
} from "@/contracts/social";

/**
 * Server-only access to everything social (docs/10, M5). Every call runs as the
 * visitor: the database takes the acting member from the verified session, never
 * from an argument, and decides what that person may see (block, audience,
 * publication state, then the reader's dietary rule). No privileged key is used.
 * Review text and names are never written to logs.
 */
export type SocialStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500;
export class SocialError extends Error {
  constructor(
    public status: SocialStatus,
    public code: string,
  ) {
    super(code);
  }
}
const STATUS: Record<string, SocialStatus> = { PT401: 401, PT403: 403, PT404: 404, PT409: 409, PT422: 422, PT429: 429, "42501": 401 };

export async function rpc<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S): Promise<z.output<S>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const status = STATUS[error.code ?? ""] ?? 500;
    throw new SocialError(status, status === 500 ? "SOCIAL_UNAVAILABLE" : error.code === "42501" ? "NOT_SIGNED_IN" : (error.message ?? "INVALID_REQUEST"));
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new SocialError(500, "SOCIAL_RESPONSE_INVALID");
  return parsed.data;
}
const demo = () => FLAGS.allowDemoContent;
const dietArgs = (d: DietPreference) => ({ p_diet: d.diet, p_exclusions: d.exclusions, p_include_conditional: d.includeConditional });

/* ---- profiles and people ---- */
export const getMyProfile = () => rpc("my_profile", {}, myProfileSchema);
export const saveMyProfile = (p: ProfileInput) =>
  rpc(
    "save_my_profile",
    {
      p_handle: p.handle,
      p_display_name: p.displayName || null,
      p_bio: p.bio || null,
      p_taste_tags: p.tasteTags,
      p_discoverable: p.discoverable,
      p_show_tastes: p.showTastes,
      p_show_diet: p.showDiet,
    },
    writeSchema,
  );
export const getProfile = (handle: string, view: SocialView, diet: DietPreference) =>
  rpc("profile_view", { p_handle: handle, p_view: view, ...dietArgs(diet), p_include_demo: demo() }, profileViewSchema);
export const findPeople = async (handle: string) => (await rpc("find_people", { p_handle: handle, p_include_demo: demo() }, findPeopleSchema)).results;
export const getSuggestedPeople = async () => (await rpc("suggested_people", { p_include_demo: demo() }, suggestedPeopleSchema)).people;
export const getConnections = () => rpc("my_connections", { p_include_demo: demo() }, connectionsSchema);

/* ---- relationships ---- */
export const follow = (handle: string) => rpc("follow_user", { p_handle: handle, p_include_demo: demo() }, writeSchema);
export const unfollow = (handle: string) => rpc("unfollow_user", { p_handle: handle }, writeSchema);
export const requestFriend = (handle: string) => rpc("request_friend", { p_handle: handle, p_include_demo: demo() }, writeSchema);
export const respondFriend = (handle: string, accept: boolean) => rpc("respond_friend", { p_handle: handle, p_accept: accept }, writeSchema);
export const removeFriend = (handle: string) => rpc("remove_friend", { p_handle: handle }, writeSchema);
export const blockUser = (handle: string) => rpc("block_user", { p_handle: handle }, writeSchema);
export const unblockUser = (handle: string) => rpc("unblock_user", { p_handle: handle }, writeSchema);

/* ---- reviews ---- */
export type ReviewWrite = { reviewId: string; version: number; audience: Audience; state: string };
export const saveReview = (r: { kind: TargetKind; targetId: string; rating: number; body?: string; visitDate?: string; expectedVersion?: number }) =>
  rpc(
    "save_review",
    {
      p_kind: r.kind,
      p_target_id: r.targetId,
      p_rating: r.rating,
      p_body: r.body || null,
      p_visit_date: r.visitDate || null,
      p_expected_version: r.expectedVersion ?? null,
      p_include_demo: demo(),
    },
    writeSchema,
  ) as Promise<ReviewWrite>;
export const setReviewAudience = (reviewId: string, audience: Audience) =>
  rpc("set_review_audience", { p_review_id: reviewId, p_audience: audience }, writeSchema) as Promise<ReviewWrite>;
export const deleteReview = (reviewId: string) => rpc("delete_review", { p_review_id: reviewId }, writeSchema);
export const getMyReviews = async () => (await rpc("my_reviews", { p_include_demo: demo() }, myReviewsSchema)).reviews;
export const getTargetReviews = (kind: TargetKind, id: string) =>
  rpc("target_reviews", { p_kind: kind, p_target_id: id, p_include_demo: demo() }, targetReviewsSchema);

/* ---- ranking ---- */
export const getMyRanking = () => rpc("my_ranking", { p_include_demo: demo() }, myRankingSchema);
export const setRanking = (venueIds: string[]) => rpc("set_ranking", { p_venue_ids: venueIds }, writeSchema);
export const publishRanking = () => rpc("publish_ranking", {}, writeSchema) as Promise<{ state: string }>;
export const withdrawRanking = () => rpc("withdraw_ranking", {}, writeSchema);

/* ---- lists ---- */
export const getMyLists = async () => (await rpc("my_lists", {}, myListsSchema)).lists;
export const saveList = (l: { listId?: string; title: string; description?: string }) =>
  rpc("save_list", { p_list_id: l.listId ?? null, p_title: l.title, p_description: l.description || null }, writeSchema) as Promise<{ listId: string }>;
export const setListItems = (listId: string, items: ListItemsInput) =>
  rpc("set_list_items", { p_list_id: listId, p_items: items, p_include_demo: demo() }, writeSchema);
export const addToList = (listId: string, kind: TargetKind, targetId: string, note?: string) =>
  rpc("add_to_list", { p_list_id: listId, p_kind: kind, p_target_id: targetId, p_note: note || null, p_include_demo: demo() }, writeSchema) as Promise<{ added: boolean }>;
export const publishList = (listId: string) => rpc("publish_list", { p_list_id: listId }, writeSchema) as Promise<{ state: string }>;
export const unpublishList = (listId: string) => rpc("unpublish_list", { p_list_id: listId }, writeSchema);
export const deleteList = (listId: string) => rpc("delete_list", { p_list_id: listId }, writeSchema);
export const getList = (listId: string, view: SocialView | "manage", diet: DietPreference) =>
  rpc("list_view", { p_list_id: listId, p_view: view, ...dietArgs(diet), p_include_demo: demo() }, listViewSchema);
export const getEditorialCollections = async () => (await rpc("editorial_collections", { p_include_demo: demo() }, collectionsSchema)).collections;
export const setListEditorial = (listId: string, on: boolean) => rpc("set_list_editorial", { p_list_id: listId, p_on: on }, writeSchema);

/* ---- feeds and recommendations ---- */
export const getFeed = (feed: "following" | "friends", view: SocialView, diet: DietPreference, before?: string, limit = 20) =>
  rpc("social_feed", { p_feed: feed, p_view: view, ...dietArgs(diet), p_before: before ?? null, p_limit: limit, p_include_demo: demo() }, feedSchema);
export const getRecommendations = (view: SocialView, diet: DietPreference) =>
  rpc("social_recommendations", { p_view: view, ...dietArgs(diet), p_include_demo: demo() }, recommendationsSchema);

/* ---- reports and moderation ---- */
export const reportContent = (r: ReportInput) =>
  rpc(
    "report_content",
    { p_type: r.type, p_id: r.id ?? null, p_handle: r.handle ?? null, p_reason: r.reason, p_details: r.details || null, p_include_demo: demo() },
    writeSchema,
  );
export const getModerationQueue = () => rpc("moderation_queue", {}, moderationQueueSchema);
export const moderate = (m: ModerateInput) => rpc("moderate", { p_type: m.type, p_id: m.id, p_action: m.action, p_reason: m.reason || null }, writeSchema);
export const dismissReports = (reportId: string, reason?: string) => rpc("dismiss_reports", { p_report_id: reportId, p_reason: reason || null }, writeSchema);
export const getCorrectionsQueue = () => rpc("corrections_queue", {}, correctionsQueueSchema);
export const decideCorrection = (id: string, state: "accepted" | "rejected" | "duplicate", note?: string) =>
  rpc("decide_correction", { p_correction_id: id, p_state: state, p_note: note || null }, writeSchema);

/* ---- account ---- */
export const deleteMyAccount = (confirm: string) => rpc("delete_my_account", { p_confirm: confirm }, writeSchema);
