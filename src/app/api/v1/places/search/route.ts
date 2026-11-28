import { FLAGS } from "@/config/flags";
import { placeMapRequestSchema } from "@/contracts/places";
import { catalogJson, statusJson } from "@/server/http";
import { catalogRoute, fieldErrors } from "@/server/catalog/api";
import { getPlaceDirectory, getPlaceMap } from "@/server/catalog/places";

/**
 * POST /api/v1/places/search: real places for the map, or for "near me" in the list (docs/36).
 * A position or a map rectangle arrives only in the request body, so it never appears in an
 * address, browser history or access log; it is rounded to about 100 m, used for this one query
 * and not stored. The database decides what this visitor may see (founder preview, or public).
 */
export async function POST(request: Request) {
  if (!FLAGS.realCatalogPreview) return statusJson(404, "NOT_FOUND");
  return catalogRoute(request, async () => {
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > 2000) return statusJson(422, "BODY_TOO_LARGE");
      body = JSON.parse(text);
    } catch {
      return statusJson(422, "INVALID_JSON");
    }
    const req = placeMapRequestSchema.safeParse(body);
    if (!req.success) return statusJson(422, "INVALID_REQUEST", fieldErrors(req.error));
    if (req.data.mode === "list") {
      if (!req.data.near) return statusJson(422, "NEAR_REQUIRED");
      return catalogJson(await getPlaceDirectory({ q: req.data.q, area: req.data.area, kind: req.data.kind, checked: req.data.checked, cuisine: req.data.cuisine, possible: req.data.possible, near: req.data.near, limit: 24 }));
    }
    return catalogJson(await getPlaceMap(req.data));
  });
}
