import "server-only";
import { z } from "zod";
import { menuPlaceSchema } from "@/contracts/menu-review";
import { rpc } from "@/server/social";

/**
 * Meal-level outcomes in the founder review queue (migration 20261125000100). Founder-only in the database; no
 * privileged key. A note changes no fact, dish, tester decision or publication state.
 */
export const mealNoteSchema = z.object({
  id: z.number(),
  dishId: z.string().uuid(),
  outcome: z.enum(["needs_evidence", "restaurant_confirmation", "cleared"]),
  note: z.string(),
  recordedAt: z.string(),
});
export type MealNote = z.infer<typeof mealNoteSchema>;

export const getMealNotes = () => rpc("meal_review_notes", {}, z.array(mealNoteSchema));
export const addMealNote = (dishId: string, outcome: MealNote["outcome"], note: string) =>
  rpc("meal_review_note_add", { p_dish: dishId, p_outcome: outcome, p_note: note }, mealNoteSchema);

/**
 * The founder's read-only preview of what an invited member would see for one meal (migration 20261125000400): the
 * member rule for facts, without the switch, enrolment and inclusion gates, plus each gate. Founder-only; writes nothing.
 */
const previewGatesSchema = z.object({
  evidence: z.boolean(),
  enrolled: z.boolean(),
  reviewed: z.boolean(),
  included: z.boolean(),
  switchOn: z.boolean(),
  visibleNow: z.boolean(),
  checks: z.record(z.string(), z.unknown()),
});
export type PreviewGates = z.infer<typeof previewGatesSchema>;
export const getMemberPreview = (dishId: string) =>
  rpc("member_preview_meal", { p_dish: dishId }, z.object({ gates: previewGatesSchema, place: menuPlaceSchema }));
