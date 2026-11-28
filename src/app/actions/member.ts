"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { correctionSchema, idSchema } from "@/contracts/catalog";
import { safeReturnPath } from "@/lib/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/server/auth/session";
import { toggleSave, type SaveTarget } from "@/server/member/saves";
import { withinActionLimit } from "@/server/rate-limit";

/**
 * Save or unsave a dish or place. A guest is sent to sign in and then brought back
 * to the same page; the save is NOT performed for them on return (R-001), so
 * nothing happens that they did not press themselves while signed in.
 */
export async function toggleSaveAction(formData: FormData) {
  const returnTo = safeReturnPath(formData.get("return") as string | null);
  const food = idSchema.safeParse(formData.get("foodItemId"));
  const venue = idSchema.safeParse(formData.get("venueId"));
  if (food.success === venue.success) redirect(returnTo);
  const target: SaveTarget = food.success ? { foodItemId: food.data } : { venueId: venue.data as string };
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  const [path, query = ""] = returnTo.split("?");
  const params = new URLSearchParams(query);
  // Per member (docs/14 PH-01). A refused press changes nothing and says so.
  const allowed = await withinActionLimit(await headers(), "save", member.id);
  params.set("saved", allowed ? await toggleSave(member.id, target) : "wait");
  redirect(`${path}?${params.toString()}`);
}

export type CorrectionState = { status: "idle" | "sent" | "error"; message?: string };

/** Sends a correction to the review queue. It never changes what the public sees by itself (R-D06). */
export async function submitCorrectionAction(_prev: CorrectionState, formData: FormData): Promise<CorrectionState> {
  const parsed = correctionSchema.safeParse({
    foodItemId: formData.get("foodItemId") || undefined,
    venueId: formData.get("venueId") || undefined,
    field: formData.get("field"),
    proposedValue: formData.get("proposedValue") ?? "",
    evidenceNote: (formData.get("evidenceNote") as string | null)?.trim() || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Please check the form and try again." };
  }
  const member = await getCurrentMember();
  if (!member) return { status: "error", message: "Please sign in to send a correction." };
  if (!(await withinActionLimit(await headers(), "correction"))) {
    return { status: "error", message: "You've sent several corrections in a short time. Please wait ten minutes and try again." };
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("submit_correction", {
    p_food_item_id: parsed.data.foodItemId ?? null,
    p_venue_id: parsed.data.venueId ?? null,
    p_field: parsed.data.field,
    p_proposed_value: parsed.data.proposedValue,
    p_evidence_note: parsed.data.evidenceNote ?? null,
  });
  if (error) {
    if (error.code === "PT429") return { status: "error", message: "You've sent a lot of corrections today. Please try again tomorrow." };
    if (error.code === "PT404") return { status: "error", message: "This item is no longer available." };
    return { status: "error", message: "We couldn't send that just now. Please try again." };
  }
  return { status: "sent", message: "Thank you. A person will review this before anything on the page changes." };
}
