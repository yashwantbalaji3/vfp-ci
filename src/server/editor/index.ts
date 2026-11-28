import "server-only";
import {
  alertsSchema,
  changeSchema,
  deskSchema,
  itemsSchema,
  memberHistorySchema,
  nutritionChecksSchema,
  myCorrectionsSchema,
  venueHistorySchema,
  type StaffAlerts,
} from "@/contracts/editor";
import { writeSchema } from "@/contracts/social";
import { rpc, SocialError } from "@/server/social";

/**
 * Server-only access to the editor and moderator tools (R2). Every call runs as
 * the signed-in person; the database checks the role and enforces the rule that
 * the person who checks a change is never the person who entered it. No
 * privileged key is used.
 */
export const getDesk = () => rpc("editor_desk", {}, deskSchema);
/** Open protein comparisons that need a person (NIE-A); staff only. */
export const getNutritionChecks = () => rpc("editor_nutrition_checks", {}, nutritionChecksSchema);
export const getItems = (query?: string) => rpc("editor_items", { p_query: query ?? null }, itemsSchema);
export const getChange = (id: string) => rpc("editor_change", { p_change_id: id }, changeSchema);
export const startChange = (foodItemId: string, correctionId?: string) =>
  rpc("editor_start_change", { p_food_item_id: foodItemId, p_correction_id: correctionId ?? null }, writeSchema);
export const startVenueChange = (venueId?: string, correctionId?: string) =>
  rpc("editor_start_venue_change", { p_venue_id: venueId ?? null, p_correction_id: correctionId ?? null }, writeSchema);
export const newFood = (p: { kind: "dish" | "recipe"; name: string; venueId?: string; description?: string; menuSection?: string }) => rpc("editor_new_food", { p }, writeSchema);
export const saveChange = (id: string, patch: Record<string, unknown>) => rpc("editor_save_change", { p_change_id: id, p_patch: patch }, writeSchema);
export const saveHours = (id: string, hours: Record<string, unknown> | null) => rpc("editor_save_hours", { p_change_id: id, p_hours: hours }, writeSchema);
export const submitChange = (id: string) => rpc("editor_submit_change", { p_change_id: id }, writeSchema);
export const withdrawChange = (id: string) => rpc("editor_withdraw_change", { p_change_id: id }, writeSchema);
export const reviewChange = (id: string, decision: "approve" | "reject", note: string | undefined, sourceChecked: boolean, rightsOk: boolean) =>
  rpc("editor_review_change", { p_change_id: id, p_decision: decision, p_note: note ?? null, p_source_checked: sourceChecked, p_rights_ok: rightsOk }, writeSchema);
export const flagNeedsReview = (foodItemId: string, reason: string, correctionId?: string) =>
  rpc("editor_flag_needs_review", { p_food_item_id: foodItemId, p_reason: reason, p_correction_id: correctionId ?? null }, writeSchema);

export const getMemberHistory = (handle: string) => rpc("member_history", { p_handle: handle }, memberHistorySchema);
export const setMemberSuspension = (handle: string, suspend: boolean, reason?: string) =>
  rpc("set_member_suspension", { p_handle: handle, p_suspend: suspend, p_reason: reason ?? null }, writeSchema);
export const getMyCorrections = () => rpc("my_corrections", {}, myCorrectionsSchema);
/** Every published change to a place, with the values before and after (editors only). */
export const getVenueHistory = (venueId: string) => rpc("venue_history", { p_venue_id: venueId }, venueHistorySchema);

/** Null for anyone who is not staff (including a guest), so pages can simply hide the staff links. */
export async function getStaffAlerts(): Promise<StaffAlerts | null> {
  try {
    return await rpc("staff_alerts", {}, alertsSchema);
  } catch (e) {
    if (e instanceof SocialError && e.status !== 500) return null;
    throw e;
  }
}

export { getFreshnessMarks } from "@/server/catalog";
