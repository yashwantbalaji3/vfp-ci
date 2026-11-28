import "server-only";
import { cache } from "react";
import { batchSummarySchema, reviewItemSchema, reviewListSchema, reviewSummarySchema, type BatchDecision, type RecordDecision } from "@/contracts/review";
import { writeSchema } from "@/contracts/social";
import { rpc } from "@/server/social";

/**
 * Founder identity review (docs/33). Every call runs as the signed-in person; the database refuses
 * anyone without the publisher role (FOUNDER_ONLY) and keeps every decision permanently. One call
 * records one decision about one place: there is no bulk call. No privileged key is used.
 */
export const getReviewSummary = cache(() => rpc("identity_review_summary", {}, reviewSummarySchema));
export const getReviewList = (queue: string, offset = 0) => rpc("identity_review_list", { p_queue: queue, p_offset: offset }, reviewListSchema);
export const getReviewItem = (candidateId: string, queue?: string) =>
  rpc("identity_review_item", { p_candidate: candidateId, p_queue: queue ?? null }, reviewItemSchema);
export const recordIdentityReview = (d: RecordDecision) =>
  rpc(
    "record_identity_review",
    { p_candidate: d.candidateId, p_decision: d.decision, p_reason: d.reason ?? null, p_note: d.note || null, p_queue: d.queue ?? null },
    writeSchema,
  );

/** Sample-reviewed batches (docs/35): founder only. Approving a batch publishes nothing by itself. */
export const getBatchSummary = () => rpc("batch_review_summary", {}, batchSummarySchema);
export const recordBatchDecision = (d: BatchDecision) =>
  rpc("record_batch_approval", { p_batch: d.batchId, p_decision: d.decision, p_acknowledged: d.acknowledged, p_note: d.note || null }, writeSchema);
