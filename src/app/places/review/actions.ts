"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { FLAGS } from "@/config/flags";
import { batchDecisionSchema, recordDecisionSchema } from "@/contracts/review";
import { getCurrentMember } from "@/server/auth/session";
import { recordBatchDecision, recordIdentityReview } from "@/server/catalog/review";
import { withinActionLimit } from "@/server/rate-limit";
import { SocialError } from "@/server/social";

/**
 * One founder decision about one place (docs/33). The form names one place; the database checks the
 * publisher role again, keeps the decision permanently and never publishes. Then the founder moves
 * on to the next undecided place in the same queue.
 */
const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE = /^[a-z0-9_]{1,60}$/;

function itemPath(id: string, queue: string | undefined, key: "m" | "e", code: string) {
  const p = new URLSearchParams();
  if (queue) p.set("queue", queue);
  p.set(key, code);
  return `/places/review/${id}?${p.toString()}`;
}

export async function recordDecisionAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const id = text(formData, "candidateId") ?? "";
  const queueRaw = text(formData, "queue");
  const queue = queueRaw && QUEUE.test(queueRaw) ? queueRaw : undefined;
  const nextRaw = text(formData, "next");
  const next = nextRaw && UUID.test(nextRaw) && nextRaw !== id ? nextRaw : undefined;
  const back = UUID.test(id) ? itemPath(id, queue, "e", "INVALID_REQUEST") : "/places/review";

  const member = await getCurrentMember();
  if (!member) redirect(`/login?next=${encodeURIComponent(UUID.test(id) ? `/places/review/${id}` : "/places/review")}`);
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");

  const parsed = recordDecisionSchema.safeParse({
    candidateId: id,
    decision: text(formData, "decision"),
    reason: text(formData, "decision") === "reject" ? text(formData, "reason") : undefined,
    note: text(formData, "note"),
    queue,
  });
  if (!parsed.success) {
    const reasonMissing = parsed.error.issues.some((i) => i.message === "REASON_REQUIRED");
    redirect(reasonMissing && UUID.test(id) ? itemPath(id, queue, "e", "REASON_REQUIRED") : back);
  }
  try {
    await recordIdentityReview(parsed.data);
  } catch (e) {
    if (e instanceof SocialError && UUID.test(id)) redirect(itemPath(id, queue, "e", e.code));
    throw e;
  }
  if (next) redirect(itemPath(next, queue, "m", "recorded"));
  redirect(`/places/review?${new URLSearchParams({ ...(queue ? { queue } : {}), m: "queue_done" }).toString()}`);
}

/** Gate 1 (docs/35): one founder decision about one batch. Publishes nothing by itself. */
export async function batchDecisionAction(formData: FormData) {
  if (!FLAGS.realCatalogPreview) redirect("/discover");
  const member = await getCurrentMember();
  if (!member) redirect("/login?next=%2Fplaces%2Freview%2Fbatches");
  if (!(await withinActionLimit(await headers(), "memberAction", member.id))) redirect("/slow-down");
  const parsed = batchDecisionSchema.safeParse({
    batchId: text(formData, "batchId"),
    decision: text(formData, "decision"),
    acknowledged: formData.get("acknowledged") === "yes",
    note: text(formData, "note"),
  });
  if (!parsed.success) {
    const ack = parsed.error.issues.some((i) => i.message === "ACKNOWLEDGEMENT_REQUIRED");
    redirect(`/places/review/batches?e=${ack ? "ACKNOWLEDGEMENT_REQUIRED" : "INVALID_REQUEST"}`);
  }
  try {
    await recordBatchDecision(parsed.data);
  } catch (e) {
    if (e instanceof SocialError) redirect(`/places/review/batches?e=${encodeURIComponent(e.code)}`);
    throw e;
  }
  redirect(`/places/review/batches?m=${parsed.data.decision === "approve" ? "approved" : "withdrawn"}`);
}
