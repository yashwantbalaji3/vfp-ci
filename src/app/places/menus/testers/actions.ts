"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FLAGS } from "@/config/flags";
import { getCurrentMember } from "@/server/auth/session";
import { decideTesterMeal } from "@/server/catalog/tester-meals";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * Include a real meal in the set invited testers may see, or leave it out (migration 20261123000200). The database
 * checks the founder role, re-runs every check and keeps an append-only record. Nothing is confirmed or published:
 * testers see the set only once the member beta switch is on, which is the owner's separate decision.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = "/places/menus/testers";
const VIEW = /^(suggested|ready|included|left_out|not_eligible)$/;

export async function decideTesterMealAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(PAGE)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const dish = formData.get("dishId");
  const decision = formData.get("decision");
  const view = formData.get("view");
  const anchor = typeof dish === "string" && UUID.test(dish) ? `#meal-${dish}` : "";
  const to = (k: "m" | "e", v: string) => `${PAGE}?${k}=${v}${typeof view === "string" && VIEW.test(view) ? `&view=${view}` : ""}${anchor}`;
  if (typeof dish !== "string" || !UUID.test(dish) || (decision !== "include" && decision !== "leave_out")) redirect(to("e", "INVALID_REQUEST"));
  const raw = formData.get("reason");
  const reason = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 300) : decision === "include" ? "Meets every check; chosen for the tester set" : "Left out by the founder";
  try {
    await decideTesterMeal(dish, decision, reason);
  } catch (e) {
    if (e instanceof SocialError) redirect(to("e", e.code));
    throw e;
  }
  redirect(to("m", decision === "include" ? "included" : "left_out"));
}

/**
 * The founder approves a list of clean meals together (overnight directive 24 Nov 2026, part 6.2). The page lists
 * each meal before the button. Each meal is still its own call: the database checks the role, re-runs every check
 * and keeps one append-only record per meal, so a meal that stopped passing is refused on its own. At most 30.
 */
export async function approveCleanMealsAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(PAGE)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const ids = [...new Set(formData.getAll("dishId").filter((d): d is string => typeof d === "string" && UUID.test(d)))];
  if (ids.length === 0 || ids.length > 30) redirect(`${PAGE}?e=INVALID_REQUEST&view=suggested`);
  let done = 0;
  let refused = 0;
  for (const id of ids) {
    try {
      await decideTesterMeal(id, "include", "Clean meal (every check passes, no conflict); approved by the founder from the listed batch");
      done++;
    } catch (e) {
      if (e instanceof SocialError) refused++;
      else throw e;
    }
  }
  redirect(`${PAGE}?m=batch_${done}_${refused}&view=suggested`);
}
