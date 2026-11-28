import { mapRequestSchema } from "@/contracts/map";
import { FLAGS } from "@/config/flags";
import { catalogJson, statusJson } from "@/server/http";
import { catalogRoute, fieldErrors, parseCatalogInput } from "@/server/catalog/api";
import { searchMap } from "@/server/catalog/map";

/**
 * POST /api/v1/map/search: places for the map and the area list (MAP-1).
 * The area (a rounded position with a distance, or a map rectangle) arrives in the request
 * body so it never appears in an address, browser history or access log. It is rounded again
 * here, used for this one query and not stored. Same rate limit as the other catalog routes.
 */
export async function POST(request: Request) {
  if (!FLAGS.mapEnabled) return statusJson(404, "NOT_FOUND");
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
    const req = mapRequestSchema.safeParse(body);
    if (!req.success) return statusJson(422, "INVALID_AREA", fieldErrors(req.error));
    const rest = { ...(body as Record<string, unknown>) };
    delete rest.area;
    const input = await parseCatalogInput(rest);
    if (input instanceof Response) return input;
    const result = await searchMap(input.filters, input.diet, req.data.area, req.data.view);
    return catalogJson(result);
  });
}
