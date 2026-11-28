import "server-only";
import { dietConfirmationSchema, dietConfirmationsSchema, type DietConfirmationInput } from "@/contracts/diet-confirmation";
import { rpc } from "@/server/social";

/**
 * Founder-only dietary confirmation records (migration 20261124000900). Every call runs as the signed-in person; the
 * database refuses anyone but the founder (FOUNDER_ONLY), checks every field, keeps records append-only and lets a
 * record be withdrawn once, with a reason. No privileged key is used, and nothing here changes a menu fact.
 */
export const getDietConfirmations = (dishId?: string) => rpc("diet_confirmations", { p_dish: dishId ?? null }, dietConfirmationsSchema);

export const recordDietConfirmation = (i: DietConfirmationInput) =>
  rpc(
    "diet_confirmation_record",
    {
      p_dish: i.dishId,
      p_claim: i.claim,
      p_answer: i.answer,
      p_topics: i.topics,
      p_answer_note: i.answerNote,
      p_method: i.method,
      p_method_note: i.methodNote,
      p_source_role: i.sourceRole,
      p_source_identity: i.sourceIdentity,
      p_scope: i.scope,
      p_limitations: i.limitations,
      p_obtained_on: i.obtainedOn,
    },
    dietConfirmationSchema,
  );

export const withdrawDietConfirmation = (id: string, reason: string) => rpc("diet_confirmation_withdraw", { p_id: id, p_reason: reason }, dietConfirmationSchema);
