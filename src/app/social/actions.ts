"use server";
import { redirect } from "next/navigation";
import { NO_DIET_PREFERENCE, idSchema } from "@/contracts/catalog";
import {
  AUDIENCES,
  handleSchema,
  listInputSchema,
  moderateInputSchema,
  profileInputSchema,
  reportInputSchema,
  reviewInputSchema,
  targetKindSchema,
  type ListItemsInput,
} from "@/contracts/social";
import { safeReturnPath } from "@/lib/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/server/auth/session";
import { getPlaceSlugForVenue } from "@/server/catalog/places";
import * as social from "@/server/social";
import { SocialError } from "@/server/social";

/**
 * Every social change is a plain form post handled here. Each action checks the
 * session, validates the form, calls one database function that re-checks
 * everything, and then returns to the page with a short code saying what happened.
 * A guest is sent to sign in and brought back; the action is NOT replayed for them.
 */
type Outcome = string | { to: string; code: string };
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

function withCode(path: string, key: "m" | "e", code: string): string {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.delete("m");
  params.delete("e");
  params.set(key, code);
  return `${base}?${params.toString()}`;
}

async function act(formData: FormData, fallback: string, fn: () => Promise<Outcome>): Promise<never> {
  const returnTo = safeReturnPath(formData.get("return") as string | null, fallback);
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  let outcome: Outcome;
  try {
    outcome = await fn();
  } catch (e) {
    if (e instanceof SocialError) redirect(withCode(returnTo, "e", e.code));
    throw e;
  }
  redirect(typeof outcome === "string" ? withCode(returnTo, "m", outcome) : withCode(outcome.to, "m", outcome.code));
}
const invalid = (): never => {
  throw new SocialError(422, "INVALID_REQUEST");
};

/* ---- profile ---- */
export async function saveProfileAction(formData: FormData) {
  await act(formData, "/friends/profile", async () => {
    const parsed = profileInputSchema.safeParse({
      handle: formData.get("handle") ?? "",
      displayName: text(formData, "displayName"),
      bio: text(formData, "bio"),
      tasteTags: (text(formData, "tasteTags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      discoverable: formData.get("discoverable") === "on",
      showTastes: formData.get("showTastes") === "on",
      showDiet: formData.get("showDiet") === "on",
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      throw new SocialError(422, field === "handle" ? "INVALID_HANDLE" : field === "tasteTags" ? "INVALID_TASTES" : "INVALID_REQUEST");
    }
    await social.saveMyProfile(parsed.data);
    return "profile_saved";
  });
}

/* ---- relationships ---- */
export async function relationshipAction(formData: FormData) {
  await act(formData, "/friends/people", async () => {
    const handle = handleSchema.safeParse(formData.get("handle"));
    if (!handle.success) return invalid();
    switch (formData.get("op")) {
      case "follow":
        await social.follow(handle.data);
        return "following";
      case "unfollow":
        await social.unfollow(handle.data);
        return "unfollowed";
      case "request": {
        const r = (await social.requestFriend(handle.data)) as { friendship?: string };
        return r.friendship === "friends" ? "friend_accepted" : "friend_requested";
      }
      case "accept":
        await social.respondFriend(handle.data, true);
        return "friend_accepted";
      case "decline":
        await social.respondFriend(handle.data, false);
        return "friend_declined";
      case "unfriend":
        await social.removeFriend(handle.data);
        return "friend_removed";
      case "block":
        await social.blockUser(handle.data);
        return { to: "/friends/people", code: "blocked" };
      case "unblock":
        await social.unblockUser(handle.data);
        return "unblocked";
      default:
        return invalid();
    }
  });
}

/* ---- reviews ---- */
export async function saveReviewAction(formData: FormData) {
  await act(formData, "/friends/reviews", async () => {
    const parsed = reviewInputSchema.safeParse({
      kind: formData.get("kind"),
      targetId: formData.get("targetId"),
      rating: formData.get("rating") ?? "",
      body: text(formData, "body"),
      visitDate: text(formData, "visitDate"),
      audience: formData.get("audience") ?? "private",
      expectedVersion: text(formData, "expectedVersion"),
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "");
      throw new SocialError(422, field === "rating" ? "INVALID_RATING" : field === "body" ? "TEXT_TOO_LONG" : field === "visitDate" ? "INVALID_DATE" : "INVALID_REQUEST");
    }
    const saved = await social.saveReview(parsed.data);
    // Choosing who can see it is a separate, explicit step in the database.
    const result = saved.audience === parsed.data.audience && saved.state !== "removed" ? saved : await social.setReviewAudience(saved.reviewId, parsed.data.audience);
    // A real place's review returns to its place page (docs/49); other places and dishes to their own page.
    const placeSlug = parsed.data.kind === "venue" ? await getPlaceSlugForVenue(parsed.data.targetId) : null;
    const to = placeSlug ? `/places/${placeSlug}` : parsed.data.kind === "venue" ? `/venues/${parsed.data.targetId}` : `/foods/${parsed.data.targetId}`;
    const code = result.state === "pending" ? "review_pending" : result.audience === "public" ? "review_public" : result.audience === "friends" ? "review_friends" : "review_private";
    return { to: safeReturnPath(formData.get("after") as string | null, to), code };
  });
}

export async function reviewAudienceAction(formData: FormData) {
  await act(formData, "/friends/reviews", async () => {
    const id = idSchema.safeParse(formData.get("reviewId"));
    const audience = AUDIENCES.find((a) => a === formData.get("audience"));
    if (!id.success || !audience) return invalid();
    const r = await social.setReviewAudience(id.data, audience);
    return r.state === "pending" ? "review_pending" : audience === "public" ? "review_public" : audience === "friends" ? "review_friends" : "review_private";
  });
}

export async function deleteReviewAction(formData: FormData) {
  await act(formData, "/friends/reviews", async () => {
    const id = idSchema.safeParse(formData.get("reviewId"));
    if (!id.success) return invalid();
    await social.deleteReview(id.data);
    return "review_deleted";
  });
}

/* ---- ranking ---- */
export async function rankingAction(formData: FormData) {
  await act(formData, "/friends/ranking", async () => {
    const op = formData.get("op");
    if (op === "publish") return (await social.publishRanking()).state === "pending" ? "ranking_pending" : "ranking_public";
    if (op === "withdraw") {
      await social.withdrawRanking();
      return "ranking_withdrawn";
    }
    const venue = idSchema.safeParse(formData.get("venueId"));
    if (!venue.success) return invalid();
    const order = (await social.getMyRanking()).entries.map((e) => e.venueId);
    const at = order.indexOf(venue.data);
    if (op === "add" && at < 0) order.push(venue.data);
    else if (op === "remove" && at >= 0) order.splice(at, 1);
    else if (op === "up" && at > 0) [order[at - 1], order[at]] = [order[at], order[at - 1]];
    else if (op === "down" && at >= 0 && at < order.length - 1) [order[at + 1], order[at]] = [order[at], order[at + 1]];
    await social.setRanking(order);
    return "ranking_saved";
  });
}

/* ---- lists ---- */
export async function saveListAction(formData: FormData) {
  await act(formData, "/friends/lists", async () => {
    const parsed = listInputSchema.safeParse({ listId: text(formData, "listId"), title: formData.get("title") ?? "", description: text(formData, "description") });
    if (!parsed.success) throw new SocialError(422, "TITLE_REQUIRED");
    const { listId } = await social.saveList(parsed.data);
    // Coming from a dish or place page: put that item straight onto the new list.
    const kind = targetKindSchema.safeParse(formData.get("kind"));
    const target = idSchema.safeParse(formData.get("targetId"));
    if (!parsed.data.listId && kind.success && target.success) {
      await social.addToList(listId, kind.data, target.data);
      return "list_added";
    }
    return parsed.data.listId ? "list_saved" : { to: `/friends/lists/${listId}`, code: "list_created" };
  });
}

export async function addToListAction(formData: FormData) {
  await act(formData, "/friends/lists", async () => {
    const list = idSchema.safeParse(formData.get("listId"));
    const kind = targetKindSchema.safeParse(formData.get("kind"));
    const target = idSchema.safeParse(formData.get("targetId"));
    if (!list.success || !kind.success || !target.success) return invalid();
    return (await social.addToList(list.data, kind.data, target.data, text(formData, "note"))).added ? "list_added" : "list_already";
  });
}

export async function listItemAction(formData: FormData) {
  await act(formData, "/friends/lists", async () => {
    const list = idSchema.safeParse(formData.get("listId"));
    const item = idSchema.safeParse(formData.get("itemId"));
    if (!list.success || !item.success) return invalid();
    const current = (await social.getList(list.data, "manage", NO_DIET_PREFERENCE)).items;
    const at = current.findIndex((i) => i.itemId === item.data);
    if (at < 0) return invalid();
    const op = formData.get("op");
    if (op === "remove") current.splice(at, 1);
    else if (op === "up" && at > 0) [current[at - 1], current[at]] = [current[at], current[at - 1]];
    else if (op === "down" && at < current.length - 1) [current[at + 1], current[at]] = [current[at], current[at + 1]];
    else if (op === "note") current[at] = { ...current[at], note: text(formData, "note") ?? null };
    const items: ListItemsInput = current.map((i) => ({ kind: i.target.kind === "venue" ? "venue" : "food", id: i.target.id, note: i.note ?? undefined }));
    await social.setListItems(list.data, items);
    return "list_saved";
  });
}

export async function listStateAction(formData: FormData) {
  await act(formData, "/friends/lists", async () => {
    const list = idSchema.safeParse(formData.get("listId"));
    if (!list.success) return invalid();
    switch (formData.get("op")) {
      case "publish":
        return (await social.publishList(list.data)).state === "pending" ? "list_pending" : "list_public";
      case "unpublish":
        await social.unpublishList(list.data);
        return "list_private";
      case "delete":
        await social.deleteList(list.data);
        return { to: "/friends/lists", code: "list_deleted" };
      case "editorial_on":
      case "editorial_off":
        await social.setListEditorial(list.data, formData.get("op") === "editorial_on");
        return "list_saved";
      default:
        return invalid();
    }
  });
}

/* ---- reports and moderation ---- */
export async function reportAction(formData: FormData) {
  await act(formData, "/friends", async () => {
    const parsed = reportInputSchema.safeParse({
      type: formData.get("type"),
      id: text(formData, "id"),
      handle: text(formData, "handle"),
      reason: formData.get("reason"),
      details: text(formData, "details"),
    });
    if (!parsed.success) return invalid();
    await social.reportContent(parsed.data);
    return "reported";
  });
}

export async function moderateAction(formData: FormData) {
  await act(formData, "/moderation", async () => {
    const report = idSchema.safeParse(formData.get("reportId"));
    if (formData.get("action") === "dismiss" && report.success) {
      await social.dismissReports(report.data, text(formData, "reason"));
      return "dismissed";
    }
    const parsed = moderateInputSchema.safeParse({ type: formData.get("type"), id: formData.get("id"), action: formData.get("action"), reason: text(formData, "reason") });
    if (!parsed.success) return invalid();
    await social.moderate(parsed.data);
    return "moderated";
  });
}

export async function correctionAction(formData: FormData) {
  await act(formData, "/moderation/corrections", async () => {
    const id = idSchema.safeParse(formData.get("correctionId"));
    const state = (["accepted", "rejected", "duplicate"] as const).find((s) => s === formData.get("state"));
    if (!id.success || !state) return invalid();
    await social.decideCorrection(id.data, state, text(formData, "note"));
    return "corrected";
  });
}

/* ---- account deletion ---- */
export async function deleteAccountAction(formData: FormData) {
  const member = await getCurrentMember();
  if (!member) redirect("/login?next=/account/delete");
  try {
    await social.deleteMyAccount(String(formData.get("confirm") ?? ""));
  } catch (e) {
    if (e instanceof SocialError) redirect(withCode("/account/delete", "e", e.code));
    throw e;
  }
  // The account is gone; clear this browser's session cookies as well.
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  redirect("/account/deleted");
}
