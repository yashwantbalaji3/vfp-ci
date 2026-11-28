import "server-only";
import { z } from "zod";
import { TERMS_VERSION, queueItemSchema, submissionSchema, type QueueItem, type Submission } from "@/contracts/community";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SocialError, rpc } from "@/server/social";

/** Community evidence (migration 20261124000300). Runs as the signed-in person; no privileged key. */

/** Whether the signed-in person may suggest: the founder always, members once the owner turns the switch on. */
export async function communityOpen(): Promise<boolean> {
  try {
    return await rpc("community_submissions_open", {}, z.boolean());
  } catch {
    return false;
  }
}

export const submitSuggestion = (kind: string, listingId: string | null, dishId: string | null, details: Record<string, string>) =>
  rpc(
    "community_submit",
    { p_kind: kind, p_listing: listingId, p_dish: dishId, p_details: details, p_terms: TERMS_VERSION },
    z.object({ id: z.string().uuid(), status: z.string(), contributor: z.string() }),
  );

export const withdrawSuggestion = (id: string) => rpc("community_withdraw", { p_id: id }, z.any());

/** The signed-in person's own suggestions, newest first (row rules allow only their own rows). */
export async function getMySuggestions(): Promise<Submission[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("community_submissions")
    .select("id, kind, status, details, listing_id, dish_id, review_note, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new SocialError(500, "SOCIAL_UNAVAILABLE");
  return z.array(submissionSchema).parse(
    (data ?? []).map((r) => ({ id: r.id, kind: r.kind, status: r.status, details: r.details, listingId: r.listing_id, dishId: r.dish_id, reviewNote: r.review_note, createdAt: r.created_at })),
  );
}

/** The founder's queue, or null for anyone else. */
export async function getSuggestionQueue(): Promise<QueueItem[] | null> {
  try {
    return await rpc("community_queue", {}, z.array(queueItemSchema));
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

export const reviewSuggestion = (id: string, status: "useful_lead" | "needs_more" | "not_used", note: string) =>
  rpc("community_review", { p_id: id, p_status: status, p_note: note }, z.any());
