"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { FLAGS } from "@/config/flags";
import { cleanGroups } from "@/contracts/menu-prechecks";
import { BASIS_NOTES, CORRECTABLE, ROW_CHOICES, correctionValue, rowDecisions, type RowChoice } from "@/contracts/menu-review";
import { getCurrentMember } from "@/server/auth/session";
import { correctMenuFact, decideMenuFacts, getMenuPlace } from "@/server/catalog/menu-review";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * The founder's row choices for one place (docs/58). The form only says which rows the founder
 * confirmed or rejected; the facts in each row are read again from the database here, so a stale
 * or edited form cannot confirm anything the founder did not see. Rows left on "Later" record nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

async function founder(next: string) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
}

export async function decideRowsAction(formData: FormData) {
  const placeId = text(formData, "placeId") ?? "";
  if (!UUID.test(placeId)) redirect("/places/review/menus");
  const page = `/places/review/menus/${placeId}`;
  await founder(page);
  const note = text(formData, "note")?.slice(0, 500);
  let place;
  try {
    place = await getMenuPlace(placeId);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${page}?e=${e.code}`);
    throw e;
  }
  const choices: Record<string, RowChoice | undefined> = {};
  for (const d of place.dishes) {
    const c = text(formData, `row:${d.dishId}`);
    choices[d.dishId] = (ROW_CHOICES as readonly string[]).includes(c ?? "") ? (c as RowChoice) : undefined;
  }
  const decisions = rowDecisions(place.dishes, choices, note);
  if (decisions.length === 0) redirect(`${page}?e=NOTHING_CHOSEN`);
  let result;
  try {
    result = await decideMenuFacts(decisions);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${page}?e=${e.code}`);
    throw e;
  }
  redirect(`${page}?m=saved&v=${result.verified}&r=${result.rejected}&t=${result.transcribed}`);
}

/**
 * Confirm one group of clean rows (one source, one kind of confirmation) at once. Either the founder
 * ticks a box saying they compared these rows with the source, or (only where the automatic comparison
 * found every waiting value on the saved page) a box saying they accept that automatic comparison and
 * did not compare by hand. Without the box nothing is saved. The confirmation note records which one
 * it was, so an accepted automatic comparison is never shown as the founder's own. The group is
 * worked out again here from the database, so a row that has since gained a pre-check flag, been
 * decided, or changed source is left out. Large groups go in parts of at most 300 facts.
 */
export async function confirmCleanGroupAction(formData: FormData) {
  const placeId = text(formData, "placeId") ?? "";
  if (!UUID.test(placeId)) redirect("/places/review/menus");
  const page = `/places/review/menus/${placeId}`;
  await founder(page);
  const automatic = text(formData, "basis") === "automatic";
  if (automatic ? text(formData, "accepted") !== "yes" : text(formData, "compared") !== "yes")
    redirect(`${page}?e=${automatic ? "NOT_ACCEPTED" : "NOT_COMPARED"}`);
  const key = text(formData, "group") ?? "";
  let place;
  try {
    place = await getMenuPlace(placeId);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${page}?e=${e.code}`);
    throw e;
  }
  const group = cleanGroups(place).find((g) => g.key === key);
  if (!group) redirect(`${page}?e=GROUP_CHANGED`);
  if (automatic && !group.automaticAllFound) redirect(`${page}?e=AUTOMATIC_NOT_AVAILABLE`);
  const choices: Record<string, RowChoice | undefined> = {};
  for (const id of group.dishIds) choices[id] = "confirm";
  const basis = BASIS_NOTES[automatic ? "automatic_comparison" : "founder"];
  const own = text(formData, "note");
  const decisions = rowDecisions(place.dishes, choices, `${basis}${own ? ` ${own}` : ""}`.slice(0, 500));
  if (decisions.length === 0) redirect(`${page}?e=NOTHING_CHOSEN`);
  const total = { verified: 0, rejected: 0, transcribed: 0 };
  for (let i = 0; i < decisions.length; i += 300) {
    try {
      const r = await decideMenuFacts(decisions.slice(i, i + 300));
      total.verified += r.verified;
      total.transcribed += r.transcribed;
    } catch (e) {
      if (e instanceof SocialError) redirect(`${page}?e=${e.code}&v=${total.verified}&t=${total.transcribed}`);
      throw e;
    }
  }
  redirect(`${page}?m=saved&v=${total.verified}&r=0&t=${total.transcribed}`);
}

export async function correctFactAction(formData: FormData) {
  const placeId = text(formData, "placeId") ?? "";
  const factId = text(formData, "factId") ?? "";
  if (!UUID.test(placeId) || !UUID.test(factId)) redirect("/places/review/menus");
  const page = `/places/review/menus/${placeId}`;
  const fixPage = `${page}/fix/${factId}`;
  await founder(fixPage);
  let place;
  try {
    place = await getMenuPlace(placeId);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${page}?e=${e.code}`);
    throw e;
  }
  const fact = place.dishes.flatMap((d) => d.facts).find((f) => f.factId === factId);
  if (!fact || !fact.canReject || !CORRECTABLE.includes(fact.kind)) redirect(`${page}?e=NOT_CORRECTABLE`);
  const input: Record<string, string | undefined> = {};
  for (const k of ["usd", "listed", "status", "amount", "per", "grams", "items"]) input[k] = text(formData, k);
  const value = correctionValue(fact.kind, fact.subject, input);
  if (!value) redirect(`${fixPage}?e=INVALID_CORRECTION`);
  try {
    await correctMenuFact(factId, value, text(formData, "note")?.slice(0, 500));
  } catch (e) {
    if (e instanceof SocialError) redirect(`${fixPage}?e=${e.code}`);
    throw e;
  }
  redirect(`${page}?m=corrected`);
}
