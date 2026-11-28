import "server-only";
import { z } from "zod";
import { testerQueueSchema, type TesterQueue } from "@/contracts/tester-meals";
import { SocialError, rpc } from "@/server/social";

/**
 * The founder's tester-meal review (migration 20261123000200). Runs as the signed-in person; the database refuses
 * anyone without the publisher role, so this returns null for everyone else. No privileged key is used.
 */
export async function getTesterQueue(): Promise<TesterQueue | null> {
  try {
    return await rpc("tester_meal_queue", {}, testerQueueSchema);
  } catch (e) {
    if (e instanceof SocialError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

export const decideTesterMeal = (dishId: string, decision: "include" | "leave_out", reason: string) =>
  rpc(
    "tester_meal_decide",
    { p_dish: dishId, p_decision: decision, p_reason: reason },
    z.object({ dishId: z.string().uuid(), decision: z.enum(["include", "leave_out"]), included: z.boolean() }),
  );
