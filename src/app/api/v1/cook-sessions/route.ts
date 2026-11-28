import { startCookInputSchema } from "@/contracts/recipes";
import { privateJson, statusJson } from "@/server/http";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";
import { getCookSession, getMyCooking, startCookSession } from "@/server/recipes";

/** Your own cooking: sessions in progress and recently finished ones. Never anyone else's. */
export async function GET(request: Request) {
  return memberRoute(request, async () => privateJson(await getMyCooking((await memberClock()).today)));
}

/** Start cooking a recipe with the chosen servings and swaps. Starting never logs food. */
export async function POST(request: Request) {
  return memberRoute(request, async () => {
    const input = startCookInputSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_SESSION", fieldErrors(input.error));
    const sessionId = await startCookSession(input.data, await memberClock());
    return privateJson(await getCookSession(sessionId), { status: 201 });
  });
}
