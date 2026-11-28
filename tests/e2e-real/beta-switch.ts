import { test } from "@playwright/test";
import { pool } from "../helpers/db";

/**
 * Sets the staged local member beta switch (migration 20261122000600) for one spec file and puts it back afterwards,
 * so the "members see nothing" checks run with it off and the beta checks with it on, whatever state the database
 * was left in. Touches only the `enabled` and `meal_mode` columns; the record of who last changed it is kept. Files
 * run one at a time (workers: 1), so the setting never leaks into another file.
 *
 * `mode` (migration 20261123000200): "whole_place" shows every eligible meal of an enrolled restaurant (the earlier
 * local beta, which most journey files exercise); "reviewed_meals" shows only meals the founder included for testers.
 */
export function memberBetaForThisFile(on: boolean, mode: "whole_place" | "reviewed_meals" = "whole_place") {
  let before: { enabled: boolean; meal_mode: string } | null = null;
  test.beforeAll(async () => {
    const r = await pool.query("select enabled, meal_mode from staging.member_beta_switch");
    before = r.rows[0] ?? null;
    if (before) await pool.query("update staging.member_beta_switch set enabled = $1, meal_mode = $2", [on, mode]);
  });
  test.afterAll(async () => {
    if (before) await pool.query("update staging.member_beta_switch set enabled = $1, meal_mode = $2", [before.enabled, before.meal_mode]);
  });
}

/** Meals whose evidence passes every tester check except the founder's own source review (migration 20261125000300). */
export const READY_FOR_REVIEW = `staging.tester_meal_all_pass(staging.tester_meal_checks(d.id) || '{"reviewed": true}'::jsonb)`;

/**
 * Source-reviews, as a test founder, the facts testers see for each meal (menu item, price and the restaurant's diet
 * "yes"), through the same staging.confirm_transcription the founder's screens use. Test database only.
 */
export async function sourceReviewForTest(founder: string, dishes: string[]): Promise<void> {
  if (!dishes.length) return;
  const facts = (
    await pool.query(
      `select f.id from staging.facts f
        where f.dish_id = any($1::uuid[]) and f.status = 'submitted' and not f.is_unknown
          and not exists (select 1 from staging.fact_confirmations c where c.fact_id = f.id)
          and (f.kind in ('menu_item', 'price') or (f.kind = 'dietary_status' and f.subject in ('vegetarian', 'vegan') and f.value ->> 'status' = 'yes'))`,
      [dishes],
    )
  ).rows.map((r) => r.id as string);
  for (const id of facts) await pool.query("select staging.confirm_transcription($1, $2, 'Test source review (test database only)')", [founder, id]);
}

/**
 * Removes the source reviews a test founder made. Confirmations are append-only for the app (a trigger refuses any
 * delete), so this test-only cleanup lifts triggers for its own transaction and removes only that founder's rows.
 */
export async function removeTestSourceReviews(founder: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("delete from staging.fact_confirmations where confirmed_by = $1", [founder]);
    await c.query("delete from staging.events where actor_id = $1 and action = 'confirm_transcription'", [founder]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
