import { catalogJson } from "@/server/http";
import { searchCatalog } from "@/server/catalog";
import { catalogRoute, parseCatalogInput } from "@/server/catalog/api";

/** GET /api/v1/catalog/search: public catalog search with the strict dietary views (R-D01, R-D02, R-D08). */
export async function GET(request: Request) {
  return catalogRoute(request, async () => {
    const input = await parseCatalogInput(Object.fromEntries(new URL(request.url).searchParams));
    if (input instanceof Response) return input;
    const result = await searchCatalog(input.filters, input.diet);
    return catalogJson(result, { nextOffset: result.nextOffset });
  });
}
