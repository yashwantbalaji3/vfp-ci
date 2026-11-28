import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import { DEFAULT_MARKET } from "@/config/markets";
import type { DietPreference, SearchFilters } from "@/contracts/catalog";
import { mapAreasSchema, mapResultSchema, type MapArea, type MapAreaInput, type MapResult } from "@/contracts/map";
import { CatalogError, getFreshnessMarks, searchParamsFor } from "@/server/catalog";
import { getHoursStatuses, getOpenNowLeftOut } from "@/server/catalog/hours";

/**
 * Map Discovery (MAP-1). The map reads the same database search as the list
 * (app.catalog_candidates), so the two cannot disagree. A position or rectangle is
 * passed straight to the database for this one query: it is not logged, cached or kept.
 */

/** Approximate neighbourhood, city and ZIP centres (decision M-4). Empty on failure. */
export async function getMapAreas(): Promise<MapArea[]> {
  if (!FLAGS.mapEnabled) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("map_areas", { p_market: DEFAULT_MARKET });
    if (error) return [];
    const parsed = mapAreasSchema.safeParse(data);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function searchMap(filters: SearchFilters, diet: DietPreference, area: MapAreaInput, view: SearchFilters["view"]): Promise<MapResult> {
  // The list's own parameters, without the ones that only page or sort a list.
  const p: Record<string, unknown> = { ...searchParamsFor(filters, diet), view };
  for (const key of ["limit", "offset", "sort", "kinds"]) delete p[key];
  if (area.kind === "radius") Object.assign(p, { lat: area.lat, lon: area.lon, radiusM: area.radiusM });
  if (area.kind === "box") p.bbox = { west: area.west, south: area.south, east: area.east, north: area.north };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_map", { p });
  if (error) {
    const status = error.code === "PT422" ? 422 : error.code === "PT429" ? 429 : 500;
    throw new CatalogError(status, status === 500 ? "CATALOG_UNAVAILABLE" : (error.message ?? "INVALID_REQUEST"));
  }
  const parsed = mapResultSchema.safeParse(data);
  if (!parsed.success) throw new CatalogError(500, "CATALOG_RESPONSE_INVALID");
  const leftOut = filters.openNow ? await getOpenNowLeftOut(p) : null;
  const result = { ...parsed.data, openNowLeftOut: leftOut };
  if (result.places.length === 0) return result;
  // "May be out of date" and "Being re-checked", exactly as on the list; opening status (MAP-2).
  const [marks, hours] = await Promise.all([
    getFreshnessMarks(
      result.places.flatMap((pl) => pl.dishes.map((d) => d.foodItemId)),
      result.places.map((pl) => pl.id),
    ),
    getHoursStatuses(result.places.map((pl) => pl.id)),
  ]);
  return {
    ...result,
    places: result.places.map((pl) => ({
      ...pl,
      ...(marks.venues[pl.id] ? { freshness: marks.venues[pl.id] } : {}),
      ...(hours[pl.id] ? { hours: hours[pl.id] } : {}),
      dishes: pl.dishes.map((d) => (marks.foods[d.foodItemId] ? { ...d, freshness: marks.foods[d.foodItemId] } : d)),
    })),
  };
}
