import { nearbySchema } from "@/contracts/catalog";
import { catalogJson, statusJson } from "@/server/http";
import { searchCatalog } from "@/server/catalog";
import { catalogRoute, fieldErrors, parseCatalogInput } from "@/server/catalog/api";

/**
 * POST /api/v1/catalog/nearby: search around a point (R-D03, R-D04).
 * The coordinates arrive in the request body so they never appear in an address,
 * browser history or access log. They are used for this one query and not stored.
 */
export async function POST(request: Request) {
  return catalogRoute(request, async () => {
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 4000) return statusJson(422, "BODY_TOO_LARGE");
      body = JSON.parse(text);
    } catch {
      return statusJson(422, "INVALID_JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return statusJson(422, "INVALID_JSON");
    const point = nearbySchema.safeParse(body);
    if (!point.success) return statusJson(422, "INVALID_LOCATION", fieldErrors(point.error));
    const input = await parseCatalogInput(body as Record<string, unknown>);
    if (input instanceof Response) return input;
    const result = await searchCatalog(input.filters, input.diet, point.data);
    return catalogJson(result, { nextOffset: result.nextOffset });
  });
}
