"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { detailsJson, detailsSchema, KINDS } from "@/contracts/community";
import { getCurrentMember } from "@/server/auth/session";
import { reviewSuggestion, submitSuggestion, withdrawSuggestion } from "@/server/member/community";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/** Community evidence (migration 20261124000300). A suggestion is a research lead; nothing here changes a fact. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,120}$/;
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : undefined);

async function guard(next: string) {
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
}

export async function submitSuggestionAction(formData: FormData) {
  const kind = str(formData.get("kind")) ?? "";
  const place = str(formData.get("place"));
  const listing = str(formData.get("listing"));
  const dish = str(formData.get("dishId"));
  const back = `/contribute?kind=${encodeURIComponent(kind)}${place && SLUG.test(place) ? `&place=${place}` : ""}${dish && UUID.test(dish) ? `&dish=${dish}` : ""}`;
  await guard(back);
  if (!KINDS.some((k) => k.v === kind)) redirect("/contribute?e=INVALID_SUGGESTION");
  if (str(formData.get("agree")) !== "yes") redirect(`${back}&e=TERMS_NOT_AGREED`);
  const raw: Record<string, unknown> = { kind };
  for (const k of ["name", "street", "area", "website", "dish", "diet", "quote", "ingredients", "price", "protein", "unit", "url", "source", "seenOn", "note", "field", "wrong", "right"]) {
    const v = str(formData.get(k));
    if (v !== undefined) raw[k] = v;
  }
  const parsed = detailsSchema.safeParse(raw);
  if (!parsed.success) redirect(`${back}&e=INVALID_SUGGESTION`);
  try {
    await submitSuggestion(kind, listing && UUID.test(listing) ? listing : null, dish && UUID.test(dish) ? dish : null, detailsJson(parsed.data));
  } catch (e) {
    if (e instanceof SocialError) redirect(`${back}&e=${encodeURIComponent(e.code)}`);
    throw e;
  }
  redirect(`/contribute?m=sent${place && SLUG.test(place) ? `&place=${place}` : ""}`);
}

export async function withdrawSuggestionAction(formData: FormData) {
  await guard("/contribute");
  const id = str(formData.get("id"));
  if (!id || !UUID.test(id)) redirect("/contribute?e=INVALID_REQUEST");
  try {
    await withdrawSuggestion(id);
  } catch (e) {
    if (e instanceof SocialError) redirect(`/contribute?e=${encodeURIComponent(e.code)}`);
    throw e;
  }
  redirect("/contribute?m=withdrawn");
}

/** The founder records what happened to one lead (useful, needs more, not used). No fact changes. */
export async function reviewSuggestionAction(formData: FormData) {
  await guard("/places/contributions");
  const id = str(formData.get("id"));
  const status = str(formData.get("status"));
  const note = (str(formData.get("note")) ?? "").slice(0, 500);
  if (!id || !UUID.test(id) || !(status === "useful_lead" || status === "needs_more" || status === "not_used")) redirect("/places/contributions?e=INVALID_REQUEST");
  try {
    await reviewSuggestion(id, status, note);
  } catch (e) {
    if (e instanceof SocialError) redirect(`/places/contributions?e=${encodeURIComponent(e.code)}`);
    throw e;
  }
  redirect(`/places/contributions?m=${status}`);
}
