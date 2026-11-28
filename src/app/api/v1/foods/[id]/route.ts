import { idSchema } from "@/contracts/catalog";
import { catalogJson, statusJson } from "@/server/http";
import { getFood } from "@/server/catalog";
import { catalogRoute } from "@/server/catalog/api";

/** GET /api/v1/foods/:id: one public dish, recipe, packaged food or ingredient with sources (R-005). */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return catalogRoute(request, async () => {
    const id = idSchema.safeParse((await ctx.params).id);
    if (!id.success) return statusJson(404, "FOOD_NOT_FOUND");
    const estimates = new URL(request.url).searchParams.get("includeEstimates") === "true";
    return catalogJson(await getFood(id.data, estimates));
  });
}
