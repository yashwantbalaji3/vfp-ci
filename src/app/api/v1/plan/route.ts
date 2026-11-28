import { isoDateSchema } from "@/contracts/diary";
import { idInputSchema, planInputSchema } from "@/contracts/recipes";
import { addDays } from "@/domain/dates/week";
import { privateJson, statusJson } from "@/server/http";
import { fieldErrors, memberRoute, readJson } from "@/server/diary/api";
import { memberClock } from "@/server/diary/clock";
import { getPlan, planRecipe, removePlan } from "@/server/recipes";

/** Your planned recipes: `?from=&to=` (default: today and the next 13 days). A plan counts toward nothing. */
export async function GET(request: Request) {
  return memberRoute(request, async () => {
    const sp = new URL(request.url).searchParams;
    const today = (await memberClock()).today;
    const from = sp.get("from") === null ? today : isoDateSchema.safeParse(sp.get("from")).data;
    const to = sp.get("to") === null ? addDays(from ?? today, 13) : isoDateSchema.safeParse(sp.get("to")).data;
    if (!from || !to) return statusJson(422, "INVALID_DATE", { date: "Use a date like 2026-11-14" });
    return privateJson(await getPlan(from, to));
  });
}

/** Plan a recipe for a day. */
export async function POST(request: Request) {
  return memberRoute(request, async () => {
    const input = planInputSchema.safeParse(await readJson(request));
    if (!input.success) return statusJson(422, "INVALID_PLAN", fieldErrors(input.error));
    return privateJson({ planId: await planRecipe(input.data) }, { status: 201 });
  });
}

/** Remove one planned recipe: `?id=`. */
export async function DELETE(request: Request) {
  return memberRoute(request, async () => {
    const id = idInputSchema.safeParse(new URL(request.url).searchParams.get("id"));
    if (!id.success) return statusJson(404, "PLAN_NOT_FOUND");
    await removePlan(id.data);
    return privateJson({ removed: true });
  });
}
