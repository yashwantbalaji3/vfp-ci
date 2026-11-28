import { compareIdsSchema } from "@/contracts/catalog";
import { catalogJson, statusJson } from "@/server/http";
import { compareFoods } from "@/server/catalog";
import { catalogRoute } from "@/server/catalog/api";

/** GET /api/v1/protein/compare?ids=a,b,c: one to three foods side by side (R-P04). */
export async function GET(request: Request) {
  return catalogRoute(request, async () => {
    const url = new URL(request.url);
    const ids = compareIdsSchema.safeParse((url.searchParams.get("ids") ?? "").split(",").filter(Boolean));
    if (!ids.success) return statusJson(422, "COMPARE_ONE_TO_THREE", { ids: "Choose one to three foods to compare." });
    return catalogJson(await compareFoods(ids.data, url.searchParams.get("includeEstimates") === "true"));
  });
}
