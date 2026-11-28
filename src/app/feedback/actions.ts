"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cleanWeek, noteSchema, weekSchema } from "@/contracts/beta-feedback";
import { getCurrentMember } from "@/server/auth/session";
import { deleteMyFeedback, sendFeedback } from "@/server/member/feedback";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/** Tester feedback (migration 20261123000300). Stored privately; nothing is sent anywhere. */
const PAGE = "/feedback";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard() {
  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(PAGE)}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
}
async function run(f: () => Promise<unknown>, ok: string) {
  try {
    await f();
  } catch (e) {
    if (e instanceof SocialError) redirect(`${PAGE}?e=${e.code}`);
    throw e;
  }
  redirect(`${PAGE}?m=${ok}`);
}
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : undefined);

export async function sendWeekAction(formData: FormData) {
  await guard();
  const w = weekSchema.safeParse({
    used: str(formData.get("used")),
    labels: str(formData.get("labels")),
    trust: str(formData.get("trust")),
    recommend: str(formData.get("recommend")),
    wrong: str(formData.get("wrong")) || undefined,
    missing: str(formData.get("missing")) || undefined,
  });
  if (!w.success) redirect(`${PAGE}?e=INVALID_FEEDBACK`);
  await run(() => sendFeedback("week", cleanWeek(w.data)), "week_sent");
}

export async function sendNoteAction(formData: FormData) {
  await guard();
  const page = str(formData.get("page"));
  const n = noteSchema.safeParse({ text: str(formData.get("text")), page: page || undefined });
  if (!n.success) redirect(`${PAGE}?e=INVALID_FEEDBACK`);
  await run(() => sendFeedback("note", n.data.page ? { text: n.data.text, page: n.data.page } : { text: n.data.text }), "note_sent");
}

export async function deleteFeedbackAction(formData: FormData) {
  await guard();
  const id = str(formData.get("id"));
  if (!id || !UUID.test(id)) redirect(`${PAGE}?e=INVALID_REQUEST`);
  await run(() => deleteMyFeedback(id), "deleted");
}
