"use server";
import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { FLAGS } from "@/config/flags";
import { MAX_FILE_BYTES, checkInputSchema, claimInputSchema, reviewInputSchema } from "@/contracts/partner";
import { getCurrentMember } from "@/server/auth/session";
import { createClaim, getLicence, recordCheck, reviewDish, submitMenu, withdrawClaim } from "@/server/partner";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";
import { partnerItemsFromText } from "../../../scripts/lib/partner-items.mjs";

/**
 * Restaurant submissions (docs/48). Each action names one claim or one dish; the database checks again
 * who may act and keeps every step permanently. Nothing here publishes anything.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const code = (e: unknown) => (e instanceof SocialError ? e.code : null);

async function signedIn(next: string) {
  if (!FLAGS.partnerSubmissions) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  return member;
}

export async function claimPlaceAction(formData: FormData) {
  const id = text(formData, "candidateId") ?? "";
  const back = UUID.test(id) ? `/partner/claim/${id}` : "/partner";
  await signedIn(back);
  const parsed = claimInputSchema.safeParse({
    candidateId: id, roleTitle: text(formData, "roleTitle") ?? "", email: text(formData, "email") ?? "", confirmed: formData.get("confirmed") === "yes",
  });
  if (!parsed.success) redirect(`${back}?e=${parsed.error.issues[0]?.message ?? "INVALID_REQUEST"}`);
  try {
    await createClaim(parsed.data.candidateId, parsed.data.roleTitle, parsed.data.email);
  } catch (e) {
    const c = code(e);
    if (c) redirect(`${back}?e=${c}`);
    throw e;
  }
  redirect("/partner?m=claimed");
}

export async function uploadMenuAction(formData: FormData) {
  const claimId = text(formData, "claimId") ?? "";
  if (!UUID.test(claimId)) redirect("/partner");
  const back = `/partner/${claimId}/upload`;
  await signedIn(back);
  const fail = (c: string) => redirect(`${back}?e=${c}`);
  const licence = await getLicence();
  if (formData.get("licence") !== licence.version || formData.get("accept") !== "yes") fail("LICENCE_REQUIRED");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("FILE_REQUIRED");
  if (file.size > MAX_FILE_BYTES) return fail("FILE_TOO_LARGE");
  const kind = /\.json$/i.test(file.name) ? "json" : /\.csv$/i.test(file.name) ? "csv" : null;
  if (!kind) return fail("FILE_TYPE");
  const bytes = Buffer.from(await file.arrayBuffer());
  let read: ReturnType<typeof partnerItemsFromText>;
  try {
    read = partnerItemsFromText(bytes.toString("utf8"), kind);
  } catch {
    return fail("FILE_UNREADABLE");
  }
  if (read.items.length === 0) return fail("FILE_EMPTY");
  if (read.items.length > 500) return fail("FILE_TOO_MANY");
  const dateRaw = text(formData, "documentDate") ?? (typeof read.documentDate === "string" ? read.documentDate : undefined);
  const documentDate = dateRaw && DATE.test(dateRaw) ? dateRaw : null;
  let result: Awaited<ReturnType<typeof submitMenu>>;
  try {
    result = await submitMenu(claimId, licence.version, file.name.slice(0, 200), createHash("sha256").update(bytes).digest("hex"), documentDate, read.items);
  } catch (e) {
    const c = code(e);
    if (c) return fail(c);
    throw e;
  }
  redirect(`/partner?m=submitted&dishes=${result.dishes}&flagged=${result.flagged}&unmapped=${read.unmapped.length}`);
}

export async function withdrawAction(formData: FormData) {
  const claimId = text(formData, "claimId") ?? "";
  await signedIn("/partner");
  if (!UUID.test(claimId) || formData.get("confirm") !== "yes") redirect("/partner?e=CONFIRM_REQUIRED");
  try {
    await withdrawClaim(claimId, text(formData, "reason")?.slice(0, 500) ?? null);
  } catch (e) {
    const c = code(e);
    if (c) redirect(`/partner?e=${c}`);
    throw e;
  }
  redirect("/partner?m=withdrawn");
}

const MOD = "/places/review/partner";

export async function recordCheckAction(formData: FormData) {
  await signedIn(MOD);
  const parsed = checkInputSchema.safeParse({
    claimId: text(formData, "claimId") ?? "", method: text(formData, "method"), outcome: text(formData, "outcome"), evidence: text(formData, "evidence") ?? "",
  });
  if (!parsed.success) redirect(`${MOD}?e=${parsed.error.issues[0]?.message === "EVIDENCE_REQUIRED" ? "EVIDENCE_REQUIRED" : "INVALID_REQUEST"}`);
  try {
    await recordCheck(parsed.data.claimId, parsed.data.method, parsed.data.outcome, parsed.data.evidence);
  } catch (e) {
    const c = code(e);
    if (c) redirect(`${MOD}?e=${c}`);
    throw e;
  }
  redirect(`${MOD}?m=check_recorded`);
}

export async function reviewDishAction(formData: FormData) {
  await signedIn(MOD);
  const parsed = reviewInputSchema.safeParse({ itemId: text(formData, "itemId") ?? "", decision: text(formData, "decision"), note: text(formData, "note") });
  if (!parsed.success) redirect(`${MOD}?e=INVALID_REQUEST`);
  try {
    await reviewDish(parsed.data.itemId, parsed.data.decision, parsed.data.note ?? null);
  } catch (e) {
    const c = code(e);
    if (c) redirect(`${MOD}?e=${c}`);
    throw e;
  }
  redirect(`${MOD}?m=dish_${parsed.data.decision}`);
}
