import { goalsInputSchema } from "@/contracts/diary";
import { privateJson, statusJson } from "@/server/http";
import { getGoals, saveGoals } from "@/server/diary";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";

/** The member's own optional goals as they stand today. */
export async function GET(request: Request) {
  return memberRoute(request, async () => privateJson(await getGoals((await memberClock()).today)));
}

/** Set, change or remove (null) a goal from today onward. Earlier days keep the goal they had. */
export async function PUT(request: Request) {
  return memberRoute(request, async () => {
    const input = goalsInputSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_GOAL", fieldErrors(input.error));
    const { today } = await memberClock();
    await saveGoals(input.data, today);
    return privateJson(await getGoals(today));
  });
}
