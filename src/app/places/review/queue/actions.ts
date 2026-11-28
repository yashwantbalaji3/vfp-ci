"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FLAGS } from "@/config/flags";
import { claimFacts } from "@/contracts/review-queue";
import { getCurrentMember } from "@/server/auth/session";
import { decideMenuFacts, getMenuPlace } from "@/server/catalog/menu-review";
import { addMealNote } from "@/server/catalog/review-queue";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * One meal's decision in the founder review queue (owner directive 25 Nov 2026 04:01 UTC, section 4.1). Fact
 * decisions go through public.menu_review_decide, one recorded decision per fact (confirm the transcription for a
 * private-pilot source, verify only where the source is cleared, or reject). Meal outcomes go to
 * public.meal_review_note_add. The database checks the founder role and every rule; nothing is published.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = "/places/review/queue";
// approve_one / reject_one: the per-field buttons, deciding exactly the one fact named after the colon.
const OPS = ["approve_claim", "approve_selected", "reject_selected", "approve_one", "reject_one", "needs_evidence", "restaurant_confirmation", "cleared"] as const;
type Op = (typeof OPS)[number];

export async function reviewMealAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(PAGE)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const dish = String(formData.get("dishId") ?? "");
  const place = String(formData.get("placeId") ?? "");
  // A per-field button sends "approve_one:<fact id>" or "reject_one:<fact id>".
  const [opRaw, oneRaw] = String(formData.get("op") ?? "").split(":");
  const op = opRaw as Op;
  const view = String(formData.get("view") ?? "");
  const todo = formData.get("todo") === "1";
  const sitting = /^[1-9][0-9]?$/.test(String(formData.get("sitting") ?? "")) ? String(formData.get("sitting")) : "";
  const back = (k: "m" | "e", v: string) =>
    `${PAGE}?${k}=${v}${/^(proposed|all|flagged)$/.test(view) ? `&view=${view}` : ""}${todo ? "&todo=1" : ""}${sitting && view === "proposed" ? `&sitting=${sitting}` : ""}#meal-${UUID.test(dish) ? dish : ""}`;
  if (!UUID.test(dish) || !UUID.test(place) || !OPS.includes(op)) redirect(back("e", "INVALID_REQUEST"));
  const note = String(formData.get("note") ?? "").trim().slice(0, 1000);
  try {
    if (op === "needs_evidence" || op === "restaurant_confirmation" || op === "cleared") {
      if (note.length < 3) redirect(back("e", "NOTE_NEEDED"));
      await addMealNote(dish, op, note);
      redirect(back("m", op));
    }
    // Facts are read again from the database, so only this meal's facts can be decided here.
    const menu = await getMenuPlace(place);
    const facts = menu.dishes.find((d) => d.dishId === dish)?.facts ?? [];
    let chosen = facts;
    if (op === "approve_claim") {
      const claim = String(formData.get("claim") ?? "");
      if (claim !== "vegetarian" && claim !== "vegan") redirect(back("e", "INVALID_REQUEST"));
      chosen = claimFacts(facts, claim);
    } else if (op === "approve_one" || op === "reject_one") {
      if (!UUID.test(oneRaw ?? "")) redirect(back("e", "INVALID_REQUEST"));
      chosen = facts.filter((f) => f.factId === oneRaw);
    } else {
      const picked = new Set(formData.getAll("fact").map(String));
      chosen = facts.filter((f) => picked.has(f.factId));
    }
    if (op === "reject_selected" || op === "reject_one") {
      if (note.length < 3) redirect(back("e", "NOTE_NEEDED"));
      chosen = chosen.filter((f) => f.canReject);
      if (!chosen.length) redirect(back("e", "NOTHING_SELECTED"));
      await decideMenuFacts(chosen.map((f) => ({ factId: f.factId, decision: "reject" as const, note })));
      redirect(back("m", `rejected_${chosen.length}`));
    }
    chosen = chosen.filter((f) => f.canConfirm && f.confirmAs);
    if (!chosen.length) redirect(back("e", "NOTHING_SELECTED"));
    await decideMenuFacts(
      chosen.map((f) => ({ factId: f.factId, decision: f.confirmAs === "verify" ? ("verify" as const) : ("confirm_transcription" as const), ...(note ? { note } : {}) })),
    );
    redirect(back("m", `approved_${chosen.length}`));
  } catch (e) {
    if (e instanceof SocialError) redirect(back("e", encodeURIComponent(e.code)));
    throw e;
  }
}
