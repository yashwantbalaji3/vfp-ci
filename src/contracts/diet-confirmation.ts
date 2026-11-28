import { z } from "zod";
import type { DietEvidence } from "./meal-eligibility";
import { confirmationRow } from "./needs-confirmation";

/**
 * Independent dietary confirmation records (owner decision 24 Nov 2026 21:20 UTC, decision 2; migration
 * 20261124000900). Founder-only. A record is one documented answer about one exact dish at one branch. It never
 * changes a menu fact, and nothing ever creates one except the founder's own form.
 *
 * The evidence categories below are kept apart, for vegetarian and for vegan separately, and are never merged:
 *   - restaurant_published: the restaurant's own published words say so (and nothing it lists conflicts).
 *   - staff_confirmed: no published statement, but a current record documents that staff or an authorized
 *     representative said it is suitable, for exactly this claim. Shown with its method, date, source and limits.
 *   - ingredient_supported: our reading of the restaurant's listed ingredients names no meat, fish or (for vegan)
 *     animal ingredient. A classification only: lists can be incomplete, so it is never "suitable".
 *   - unknown: none of the above, and no explicit conflict.
 *   - conflict: explicit evidence against (the restaurant's words, a listed ingredient, the name, or a current
 *     record whose answer is "not suitable").
 * A vegan answer never stands in for vegetarian or the other way round; identity, cuisine and meal names are never
 * evidence.
 */
export const CLAIMS = ["vegetarian", "vegan"] as const;
export const ANSWERS = ["suitable", "not_suitable", "unclear"] as const;
export const TOPICS = ["whole_dish", "meat_or_fish_stock", "fish_sauce", "egg", "dairy", "animal_rennet", "gelatin", "honey", "shared_fryer"] as const;
export const METHODS = ["staff_in_person", "staff_phone", "printed_in_person", "restaurant_written", "restaurant_submission", "other_documented"] as const;

export const ANSWER_WORDS: Record<(typeof ANSWERS)[number], string> = {
  suitable: "Suitable",
  not_suitable: "Not suitable",
  unclear: "Unclear or would not say",
};
export const TOPIC_WORDS: Record<(typeof TOPICS)[number], string> = {
  whole_dish: "The whole dish as served",
  meat_or_fish_stock: "Meat or fish stock",
  fish_sauce: "Fish sauce or shrimp paste",
  egg: "Egg (including egg wash)",
  dairy: "Dairy (milk, butter, cheese, ghee)",
  animal_rennet: "Animal rennet in cheese",
  gelatin: "Gelatin",
  honey: "Honey",
  shared_fryer: "Shared fryer or cooking surface",
};
export const METHOD_WORDS: Record<(typeof METHODS)[number], string> = {
  staff_in_person: "Asked staff in person",
  staff_phone: "Asked staff by phone",
  printed_in_person: "Printed statement seen in person",
  restaurant_written: "The restaurant's written reply",
  restaurant_submission: "Submitted by the restaurant",
  other_documented: "Other documented source",
};
export const STATE_WORDS = {
  current: "Current",
  expired: "Lapsed (older than 120 days)",
  menu_changed: "Lapsed (the dish's menu facts changed after it was recorded)",
  withdrawn: "Withdrawn",
} as const;

export const dietConfirmationSchema = z.object({
  id: z.string().uuid(),
  placeId: z.string().uuid(),
  dishId: z.string().uuid(),
  claim: z.enum(CLAIMS),
  answer: z.enum(ANSWERS),
  topics: z.array(z.enum(TOPICS)).min(1),
  answerNote: z.string(),
  method: z.enum(METHODS),
  methodNote: z.string().nullable(),
  sourceRole: z.string(),
  sourceIdentity: z.string().nullable(),
  scope: z.string(),
  limitations: z.string(),
  obtainedOn: z.string(),
  expiresOn: z.string(),
  recordedAt: z.string(),
  state: z.enum(["current", "expired", "menu_changed", "withdrawn"]),
  withdrawnAt: z.string().nullable(),
  withdrawnReason: z.string().nullable(),
});
export type DietConfirmation = z.infer<typeof dietConfirmationSchema>;
export const dietConfirmationsSchema = z.array(dietConfirmationSchema);

/** The form's input, checked the same way the database checks it. */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const dietConfirmationInputSchema = z
  .object({
    dishId: z.string().uuid(),
    claim: z.enum(CLAIMS),
    answer: z.enum(ANSWERS),
    topics: z.array(z.enum(TOPICS)).min(1).max(8),
    answerNote: text(3, 1000),
    method: z.enum(METHODS),
    methodNote: z.union([text(3, 500), z.literal("")]).transform((v) => v || null),
    sourceRole: text(2, 120),
    sourceIdentity: z.union([text(2, 120), z.literal("")]).transform((v) => v || null),
    scope: text(3, 500),
    limitations: text(3, 1000),
    obtainedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((v) => v.method !== "other_documented" || v.methodNote, { path: ["methodNote"] });
export type DietConfirmationInput = z.output<typeof dietConfirmationInputSchema>;

export type EvidenceCategory = "restaurant_published" | "staff_confirmed" | "ingredient_supported" | "unknown" | "conflict";
export const CATEGORY_WORDS: Record<EvidenceCategory, string> = {
  restaurant_published: "Restaurant-published claim",
  staff_confirmed: "Staff-confirmed (documented answer)",
  ingredient_supported: "Ingredient-supported classification only",
  unknown: "Unknown",
  conflict: "Explicit conflict",
};
export const CATEGORY_ORDER: EvidenceCategory[] = ["restaurant_published", "staff_confirmed", "ingredient_supported", "unknown", "conflict"];

export type CategoryRow = { vegetarian: EvidenceCategory; vegan: EvidenceCategory; records: { vegetarian?: DietConfirmation; vegan?: DietConfirmation } };

/**
 * The evidence category of one meal for each claim. Pure. Only current records for exactly that claim count; a
 * current "not suitable" answer is a conflict; an "unclear" answer changes nothing. A restaurant's published claim
 * stays in its own category even when a record agrees with it.
 */
export function evidenceCategories(e: DietEvidence, records: DietConfirmation[]): CategoryRow {
  const row = confirmationRow(e);
  const out: CategoryRow = { vegetarian: "unknown", vegan: "unknown", records: {} };
  for (const c of CLAIMS) {
    const base = row[c];
    const current = records.filter((r) => r.claim === c && r.state === "current" && r.answer !== "unclear");
    const against = current.find((r) => r.answer === "not_suitable");
    const support = current.find((r) => r.answer === "suitable");
    if (base === "conflict" || against) {
      out[c] = "conflict";
      if (against) out.records[c] = against;
    } else if (base === "stated") out[c] = "restaurant_published";
    else if (support) {
      out[c] = "staff_confirmed";
      out.records[c] = support;
    } else if (row.lead === "ingredients_clear" && !(c === "vegan" && e.found.length > 0)) out[c] = "ingredient_supported";
    else out[c] = "unknown";
  }
  return out;
}

/** One line for a record, in its own words: "Staff said … (asked staff in person, 3 Dec 2026)". */
export function recordLine(r: DietConfirmation): string {
  return `${ANSWER_WORDS[r.answer]} for ${r.claim}: ${r.answerNote} (${METHOD_WORDS[r.method].toLowerCase()}, ${r.sourceRole}, ${r.obtainedOn})`;
}
