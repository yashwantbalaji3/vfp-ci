"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { FLAGS } from "@/config/flags";
import { RESOLUTIONS, reportSchema } from "@/contracts/places";
import { getCurrentMember } from "@/server/auth/session";
import { reportPlaceProblem, resolvePlaceReport } from "@/server/catalog/places";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * Report a problem with a real place (docs/36). A signed-in member sends one report about one place;
 * the database checks they can see the place, refuses repeats and caps reports per day. A report never
 * changes the listing: the founder reviews it.
 */
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const SLUG = /^[a-z0-9-]{2,120}$/;

export async function reportPlaceAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const slugRaw = text(formData, "slug") ?? "";
  const slug = SLUG.test(slugRaw) ? slugRaw : null;
  const back = slug ? `/places/${slug}` : "/places";
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(back)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const parsed = reportSchema.safeParse({ listingId: text(formData, "listingId"), reason: text(formData, "reason"), note: text(formData, "note") });
  if (!parsed.success) {
    const code = parsed.error.issues.some((i) => i.message === "NOTE_REQUIRED") ? "NOTE_REQUIRED" : "INVALID_REQUEST";
    redirect(`${back}?re=${code}#report`);
  }
  try {
    await reportPlaceProblem(parsed.data);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${back}?re=${encodeURIComponent(e.code)}#report`);
    throw e;
  }
  redirect(`${back}?m=reported`);
}

/** The founder resolves one report. Never changes the listing. */
export async function resolveReportAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect("/login?next=%2Fplaces%2Freview%2Freports");
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const id = Number(text(formData, "reportId"));
  const resolution = text(formData, "resolution");
  if (!Number.isInteger(id) || id <= 0 || !RESOLUTIONS.includes(resolution as (typeof RESOLUTIONS)[number])) redirect("/places/review/reports?e=INVALID_REQUEST");
  const note = text(formData, "note");
  if (note && note.length > 500) redirect("/places/review/reports?e=NOTE_TOO_LONG");
  try {
    await resolvePlaceReport(id, resolution!, note);
  } catch (e) {
    if (e instanceof SocialError) redirect(`/places/review/reports?e=${encodeURIComponent(e.code)}`);
    throw e;
  }
  redirect("/places/review/reports?m=resolved");
}
