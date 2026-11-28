import "server-only";
import { z } from "zod";
import { feedbackRowSchema, type FeedbackRow } from "@/contracts/beta-feedback";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SocialError, rpc } from "@/server/social";

/** Tester feedback (migration 20261123000300). Runs as the signed-in person; no privileged key. */
export const sendFeedback = (form: "week" | "note", answers: Record<string, unknown>) =>
  rpc("beta_feedback_send", { p_form: form, p_answers: answers }, z.object({ id: z.string().uuid(), form: z.string(), testerCode: z.string() }));

export const getMyTesterCode = () => rpc("beta_my_tester_code", {}, z.string());

/** The signed-in member's own feedback, newest first (row rules allow only their own rows). */
export async function getMyFeedback(): Promise<FeedbackRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("beta_feedback").select("id, form, answers, created_at").order("created_at", { ascending: false }).limit(50);
  if (error) throw new SocialError(500, "SOCIAL_UNAVAILABLE");
  return z.array(feedbackRowSchema).parse((data ?? []).map((r) => ({ id: r.id, form: r.form, answers: r.answers, createdAt: r.created_at })));
}

export async function deleteMyFeedback(id: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("beta_feedback").delete().eq("id", id);
  if (error) throw new SocialError(500, "SOCIAL_UNAVAILABLE");
}

/** Everyone's feedback by tester code, or null for anyone but the founder. */
export async function getAllFeedback(): Promise<FeedbackRow[] | null> {
  try {
    return await rpc("beta_feedback_all", {}, z.array(feedbackRowSchema));
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}
