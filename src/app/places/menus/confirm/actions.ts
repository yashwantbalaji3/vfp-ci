"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FLAGS } from "@/config/flags";
import { dietConfirmationInputSchema } from "@/contracts/diet-confirmation";
import { getCurrentMember } from "@/server/auth/session";
import { recordDietConfirmation, withdrawDietConfirmation } from "@/server/catalog/diet-confirmations";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * The founder records, or withdraws, a documented dietary answer for one dish (migration 20261124000900). The
 * database checks the founder role and every field and keeps the record append-only. Nothing is published, no menu
 * fact changes, and nothing is shown to members or testers.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

export async function recordDietConfirmationAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const dish = str(formData, "dishId");
  const page = UUID.test(dish) ? `/places/menus/confirm/${dish}` : "/places/menus/confirm";
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(page)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const parsed = dietConfirmationInputSchema.safeParse({
    dishId: dish,
    claim: str(formData, "claim"),
    answer: str(formData, "answer"),
    topics: formData.getAll("topics").filter((t) => typeof t === "string"),
    answerNote: str(formData, "answerNote"),
    method: str(formData, "method"),
    methodNote: str(formData, "methodNote"),
    sourceRole: str(formData, "sourceRole"),
    sourceIdentity: str(formData, "sourceIdentity"),
    scope: str(formData, "scope"),
    limitations: str(formData, "limitations"),
    obtainedOn: str(formData, "obtainedOn"),
  });
  if (!parsed.success) redirect(`${page}?e=INVALID_REQUEST#record`);
  try {
    await recordDietConfirmation(parsed.data);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${page}?e=${encodeURIComponent(e.code)}#record`);
    throw e;
  }
  redirect(`${page}?m=recorded`);
}

export async function withdrawDietConfirmationAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const dish = str(formData, "dishId");
  const page = UUID.test(dish) ? `/places/menus/confirm/${dish}` : "/places/menus/confirm";
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(page)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const id = str(formData, "id");
  const reason = str(formData, "reason").trim();
  if (!UUID.test(id) || reason.length < 3 || reason.length > 500) redirect(`${page}?e=INVALID_REQUEST`);
  try {
    await withdrawDietConfirmation(id, reason);
  } catch (e) {
    if (e instanceof SocialError) redirect(`${page}?e=${encodeURIComponent(e.code)}`);
    throw e;
  }
  redirect(`${page}?m=withdrawn`);
}
