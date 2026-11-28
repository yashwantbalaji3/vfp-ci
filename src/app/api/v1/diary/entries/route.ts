import { customFoodInputSchema, logEntryInputSchema } from "@/contracts/diary";
import { privateJson, statusJson } from "@/server/http";
import { logCustomFood, logEntry } from "@/server/diary";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";

/**
 * Log something to the member's own diary. Send `revisionId` for a catalog or
 * saved custom food, or `name` to write down a new food of your own. The
 * `idempotencyKey` makes a repeated send return the first result.
 */
export async function POST(request: Request) {
  return memberRoute(request, async () => {
    const body = await readJson(request);
    const { timeZone } = await memberClock();
    const isCustom = typeof body === "object" && body !== null && "name" in body;
    if (isCustom) {
      const input = customFoodInputSchema.safeParse(body);
      if (!input.success) return statusJson(422, "INVALID_ENTRY", fieldErrors(input.error));
      const result = await logCustomFood(input.data, timeZone);
      return privateJson(result, { status: result.replayed ? 200 : 201 });
    }
    const input = logEntryInputSchema.safeParse(body);
    if (!input.success) return statusJson(422, "INVALID_ENTRY", fieldErrors(input.error));
    const result = await logEntry(input.data, timeZone);
    return privateJson(result, { status: result.replayed ? 200 : 201 });
  });
}
