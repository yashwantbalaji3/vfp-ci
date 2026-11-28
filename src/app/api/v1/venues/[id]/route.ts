import { idSchema } from "@/contracts/catalog";
import { catalogJson, statusJson } from "@/server/http";
import { getVenue } from "@/server/catalog";
import { catalogRoute } from "@/server/catalog/api";

/** GET /api/v1/venues/:id: one public place with its sourced facts. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return catalogRoute(request, async () => {
    const id = idSchema.safeParse((await ctx.params).id);
    if (!id.success) return statusJson(404, "VENUE_NOT_FOUND");
    return catalogJson(await getVenue(id.data));
  });
}
