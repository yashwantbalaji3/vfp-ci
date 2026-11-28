import { z } from "zod";
import { cookProgressInputSchema, idInputSchema } from "@/contracts/recipes";
import { privateJson, statusJson } from "@/server/http";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";
import { abandonCookSession, completeCookSession, declineCookLog, getCookSession, saveCookProgress } from "@/server/recipes";

type Ctx = { params: Promise<{ id: string }> };
const patchSchema = z.object({
  currentStep: cookProgressInputSchema.shape.currentStep.optional(),
  checkedIngredients: cookProgressInputSchema.shape.checkedIngredients.optional(),
  action: z.enum(["complete", "abandon", "decline_log"]).optional(),
});

/** One of your own cooking sessions. Someone else's session answers exactly like one that does not exist. */
export async function GET(request: Request, { params }: Ctx) {
  return memberRoute(request, async () => {
    const id = idInputSchema.safeParse((await params).id);
    if (!id.success) return statusJson(404, "SESSION_NOT_FOUND");
    return privateJson(await getCookSession(id.data));
  });
}

/**
 * Save your place (`currentStep`, `checkedIngredients`) or send `action`:
 * "complete" (records the cooking, writes nothing to the diary), "abandon" or "decline_log".
 */
export async function PATCH(request: Request, { params }: Ctx) {
  return memberRoute(request, async () => {
    const id = idInputSchema.safeParse((await params).id);
    if (!id.success) return statusJson(404, "SESSION_NOT_FOUND");
    const input = patchSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_SESSION", fieldErrors(input.error));
    if (input.data.currentStep !== undefined) {
      await saveCookProgress({ sessionId: id.data, currentStep: input.data.currentStep, checkedIngredients: input.data.checkedIngredients ?? [] });
    }
    if (input.data.action === "complete") await completeCookSession(id.data, await memberClock());
    if (input.data.action === "abandon") await abandonCookSession(id.data);
    if (input.data.action === "decline_log") await declineCookLog(id.data);
    return privateJson(await getCookSession(id.data));
  });
}
