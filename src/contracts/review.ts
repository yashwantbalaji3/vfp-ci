import { z } from "zod";

/**
 * Founder identity review (docs/33). Identity only: nothing here describes a menu, a diet or a
 * nutrient, and a decision never publishes a place.
 */
export const DECISIONS = ["verify_identity", "reject", "needs_more_evidence"] as const;
export const REJECT_REASONS = ["not_public", "closed", "duplicate", "wrong_place", "not_restaurant", "other"] as const;
export type Decision = (typeof DECISIONS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];

export const DECISION_WORDS: Record<Decision, string> = {
  verify_identity: "Identity correct",
  reject: "Rejected",
  needs_more_evidence: "Needs more evidence",
};
export const REASON_WORDS: Record<RejectReason, string> = {
  not_public: "Not open to the public",
  closed: "Closed",
  duplicate: "Duplicate of another place",
  wrong_place: "Wrong place or address",
  not_restaurant: "Not a restaurant or café",
  other: "Other (say why in the note)",
};

/** Queue names, in plain words. Unknown names fall back to the raw name. */
export const QUEUE_WORDS: Record<string, string> = {
  sample: "Representative sample",
  sources_disagree_on_address: "Different house numbers",
  possible_duplicate: "Possible duplicate",
  near_twin: "Near twin (same name nearby)",
  open_status_unknown: "Open status unknown",
  possibly_not_public: "May not be open to the public",
  possibly_not_restaurant: "May not be a restaurant",
  sources_disagree_on_position: "Sources far apart",
  sources_disagree_on_name: "Sources name it differently",
  missing_address: "Missing address",
  category_unclear: "Food truck or stand",
  name_garbled: "Broken characters in name",
  source_absent: "Missing from latest source release",
  founder_needs_more_evidence: "You asked for more evidence",
  reported_by_visitor: "Reported by a visitor",
  decided: "Already decided",
};
export const queueWords = (q: string) => QUEUE_WORDS[q] ?? q.replace(/_/g, " ");

const decision = z.enum(DECISIONS);
const reason = z.enum(REJECT_REASONS);

export const reviewSummarySchema = z.object({
  queues: z.array(z.object({ queue: z.string(), total: z.number(), decided: z.number() })),
  sample: z
    .object({ seed: z.string(), total: z.number(), checked: z.number(), correct: z.number(), problems: z.number(), precheckAgree: z.number().default(0), precheckLook: z.number().default(0) })
    .nullable(),
  decisions: z.object({ verified: z.number(), rejected: z.number(), needsMoreEvidence: z.number() }),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

export const reviewListSchema = z.object({
  queue: z.string(),
  total: z.number(),
  decided: z.number(),
  items: z.array(
    z.object({
      candidateId: z.string(),
      name: z.string(),
      street: z.string().nullable(),
      postcode: z.string().nullable(),
      area: z.string().nullable(),
      queues: z.array(z.string()),
      decision: decision.nullable(),
      /** The automatic pre-check (docs/51); null until the next build. Never a decision. */
      precheck: z.object({ level: z.enum(["agree", "look"]), concerns: z.array(z.string().max(40)).max(20) }).nullable().default(null),
    }),
  ),
  nextOffset: z.number().nullable(),
});
export type ReviewList = z.infer<typeof reviewListSchema>;

const sourceRecord = z.object({
  source: z.string().nullable(),
  sourceKey: z.string(),
  release: z.string().nullable(),
  recordId: z.string().nullable(),
  name: z.string().nullable(),
  street: z.string().nullable(),
  postcode: z.string().nullable(),
  locality: z.string().nullable(),
  category: z.string().nullable(),
  website: z.string().nullable(),
  openStatus: z.string().nullable(),
  present: z.boolean().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});
export type SourceRecord = z.infer<typeof sourceRecord>;

export const reviewItemSchema = z.object({
  candidateId: z.string(),
  name: z.string(),
  street: z.string().nullable(),
  postcode: z.string().nullable(),
  area: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  queues: z.array(z.string()),
  active: z.boolean(),
  evidence: z.object({
    quality: z.string().nullable().optional(),
    reasons: z.array(z.object({ code: z.string(), words: z.string() })).default([]),
    records: z.array(sourceRecord).default([]),
    recordsApartMetres: z.number().nullable().optional(),
    lookalikes: z
      .array(z.object({ name: z.string(), street: z.string().nullable(), metres: z.number(), quality: z.string().nullable().optional() }))
      .default([]),
  }),
  history: z.array(
    z.object({ decision, reason: reason.nullable(), note: z.string().nullable(), queue: z.string(), by: z.string().nullable(), at: z.string() }),
  ),
  listing: z.object({ identityStatus: z.string(), menuStatus: z.string(), visibility: z.string() }).nullable(),
  next: z.string().nullable(),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const recordDecisionSchema = z
  .object({
    candidateId: z.string().uuid(),
    decision,
    reason: reason.optional(),
    note: z.string().trim().max(1000).optional(),
    queue: z.string().trim().min(1).max(60).optional(),
  })
  .refine((d) => (d.decision === "reject") === (d.reason !== undefined), { message: "REASON_REQUIRED" });
export type RecordDecision = z.infer<typeof recordDecisionSchema>;

/* ---- Sample-reviewed batches (docs/35) ---- */
export const batchStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  sampleSeed: z.string(),
  places: z.number(),
  frozenAt: z.string(),
  sampleSize: z.number(),
  checked: z.number(),
  problems: z.number(),
  upperBound: z.number(),
  passes: z.boolean(),
  rule: z.string(),
  approved: z.boolean(),
  approvalExpired: z.boolean(),
  excluded: z.number(),
  history: z.array(
    z.object({
      decision: z.enum(["approve", "withdraw"]),
      sampleSize: z.number(),
      checked: z.number(),
      problems: z.number(),
      upperBound: z.number(),
      note: z.string().nullable(),
      by: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export type BatchStatus = z.infer<typeof batchStatusSchema>;
export const batchSummarySchema = z.object({ switchOn: z.boolean(), batches: z.array(batchStatusSchema) });
export type BatchSummary = z.infer<typeof batchSummarySchema>;

export const batchDecisionSchema = z
  .object({
    batchId: z.string().uuid(),
    decision: z.enum(["approve", "withdraw"]),
    acknowledged: z.boolean(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.decision !== "approve" || d.acknowledged, { message: "ACKNOWLEDGEMENT_REQUIRED" });
export type BatchDecision = z.infer<typeof batchDecisionSchema>;

/** "With 95% confidence, no more than 4.8% of this batch is wrong." Percent with one decimal. */
export const boundPercent = (b: number) => `${(Math.round(b * 1000) / 10).toFixed(1)}%`;
