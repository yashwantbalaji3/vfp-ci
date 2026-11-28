import { recipeFiltersSchema } from "@/contracts/recipes";
import { catalogJson, statusJson } from "@/server/http";
import { catalogRoute, fieldErrors } from "@/server/catalog/api";
import { readDietPreference } from "@/server/catalog/diet";
import { listRecipes } from "@/server/recipes";

/**
 * GET /api/v1/recipes: published recipes. `q`, `meal`, `cuisine`, `protein=high`,
 * `maxMinutes`, `view=matches|needs_confirmation`. The visitor's saved dietary
 * filter always applies: recipes that contain an excluded ingredient are never returned.
 */
export async function GET(request: Request) {
  return catalogRoute(request, async () => {
    const sp = new URL(request.url).searchParams;
    const filters = recipeFiltersSchema.safeParse({
      q: sp.get("q") ?? undefined,
      meal: sp.get("meal") ?? undefined,
      cuisine: sp.get("cuisine") ?? undefined,
      highProtein: sp.get("protein") === "high",
      maxMinutes: sp.get("maxMinutes") ?? undefined,
      view: sp.get("view") ?? undefined,
    });
    if (!filters.success) return statusJson(422, "INVALID_FILTERS", fieldErrors(filters.error));
    return catalogJson(await listRecipes(filters.data, await readDietPreference()));
  });
}
