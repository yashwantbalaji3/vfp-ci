import { logCookInputSchema } from "@/contracts/recipes";
import { privateJson, statusJson } from "@/server/http";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";
import { logCookSession } from "@/server/recipes";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The only way cooking reaches the diary: the member says how many servings they ate.
 * A second send for the same session is refused (409 ALREADY_LOGGED) unless
 * `additional: true` says it is a later helping from the same batch.
 */
export async function POST(request: Request, { params }: Ctx) {
  return memberRoute(request, async () => {
    const input = logCookInputSchema.safeParse({ ...((await readJson(request)) as object), sessionId: (await params).id });
    if (!input.success) return statusJson(422, "INVALID_ENTRY", fieldErrors(input.error));
    const result = await logCookSession(input.data, (await memberClock()).timeZone);
    return privateJson(result, { status: result.replayed ? 200 : 201 });
  });
}
