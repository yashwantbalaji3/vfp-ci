import { idSchema } from "@/contracts/catalog";
import { recipeOptionsSchema } from "@/contracts/recipes";
import { swapsFromParams } from "@/domain/recipes/quantity";
import { catalogJson, statusJson } from "@/server/http";
import { catalogRoute, fieldErrors } from "@/server/catalog/api";
import { readDietPreference } from "@/server/catalog/diet";
import { getRecipe } from "@/server/recipes";

/**
 * GET /api/v1/recipes/:id: one recipe for `?servings=` and approved swaps
 * (`?swap_<group>=<ingredient line id>`). Amounts, nutrition and the dietary result
 * are recalculated together for exactly that version of the recipe.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return catalogRoute(request, async () => {
    const id = idSchema.safeParse((await ctx.params).id);
    if (!id.success) return statusJson(404, "RECIPE_NOT_FOUND");
    const sp = Object.fromEntries(new URL(request.url).searchParams.entries());
    const options = recipeOptionsSchema.safeParse({ servings: sp.servings, swaps: swapsFromParams(sp) });
    if (!options.success) return statusJson(422, "INVALID_OPTIONS", fieldErrors(options.error));
    return catalogJson(await getRecipe(id.data, options.data, await readDietPreference()));
  });
}
