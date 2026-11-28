import "server-only";
import type { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { FLAGS } from "@/config/flags";
import { DEFAULT_MARKET } from "@/config/markets";
import {
  filterOptionsSchema,
  freshnessMarksSchema,
  type FreshnessMarks,
  foodDetailSchema,
  proteinExplanationSchema,
  type ProteinExplanation,
  searchResultSchema,
  venueDetailSchema,
  type DietPreference,
  type Eligibility,
  type FilterOptions,
  type FoodDetail,
  type Nearby,
  type SearchFilters,
  type SearchResult,
  type VenueDetail,
} from "@/contracts/catalog";
import { getHoursStatuses, getOpenNowLeftOut } from "@/server/catalog/hours";

/**
 * Server-only catalog access (docs/10). Every call runs as the visitor (guest or
 * member) through database functions that enforce what is public; the eligibility
 * rule lives in the database and is never re-implemented here. Demo content is
 * requested only when ALLOW_DEMO_CONTENT is on.
 */
export class CatalogError extends Error {
  constructor(
    public status: 404 | 422 | 429 | 401 | 500,
    public code: string,
  ) {
    super(code);
  }
}

type RpcError = { code?: string; message?: string } | null;

function toCatalogError(error: NonNullable<RpcError>): CatalogError {
  const status = error.code === "PT404" ? 404 : error.code === "PT422" ? 422 : error.code === "PT429" ? 429 : error.code === "PT401" ? 401 : 500;
  // Database messages for our PTxxx codes are stable identifiers such as FOOD_NOT_FOUND; anything else stays generic.
  return new CatalogError(status, status === 500 ? "CATALOG_UNAVAILABLE" : (error.message ?? "INVALID_REQUEST"));
}

async function rpc<S extends z.ZodType>(fn: string, args: Record<string, unknown>, schema: S): Promise<z.output<S>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toCatalogError(error);
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CatalogError(500, "CATALOG_RESPONSE_INVALID");
  return parsed.data;
}

export function searchParamsFor(filters: SearchFilters, diet: DietPreference, nearby?: Nearby): Record<string, unknown> {
  return {
    market: DEFAULT_MARKET,
    includeDemo: FLAGS.allowDemoContent,
    q: filters.q || undefined,
    view: filters.view,
    kinds: filters.kinds?.length ? filters.kinds : undefined,
    diet: diet.diet === "none" ? undefined : diet.diet,
    exclusions: diet.exclusions,
    includeConditional: diet.includeConditional,
    neighborhood: filters.neighborhood,
    cuisine: filters.cuisine,
    maxPriceBand: filters.maxPriceBand,
    venueType: filters.venueType,
    venueId: filters.venueId,
    minProtein: filters.minProtein,
    basis: filters.basis,
    evidenceMode: filters.includeEstimates ? "include_estimates" : "published_calculated",
    openNow: filters.openNow || undefined,
    sort: filters.sort,
    limit: filters.limit,
    offset: filters.offset,
    ...(nearby ? { lat: nearby.lat, lon: nearby.lon, radiusM: nearby.radiusM } : {}),
  };
}

const NO_MARKS: FreshnessMarks = { foods: {}, venues: {} };

/**
 * "May be out of date" and "Being re-checked" marks for a set of records, in one
 * call. A failure here never hides a page: the labels are simply absent.
 */
export async function getFreshnessMarks(foodItemIds: string[], venueIds: string[] = []): Promise<FreshnessMarks> {
  const foods = [...new Set(foodItemIds.filter(Boolean))];
  const venues = [...new Set(venueIds.filter(Boolean))];
  if (foods.length === 0 && venues.length === 0) return NO_MARKS;
  try {
    return await rpc("freshness_marks", { p_food_item_ids: foods, p_venue_ids: venues, p_include_demo: FLAGS.allowDemoContent }, freshnessMarksSchema);
  } catch {
    return NO_MARKS;
  }
}

export async function searchCatalog(filters: SearchFilters, diet: DietPreference, nearby?: Nearby): Promise<SearchResult> {
  const p = searchParamsFor(filters, diet, nearby);
  const result = await rpc("search_catalog", { p }, searchResultSchema);
  const leftOut = filters.openNow ? await getOpenNowLeftOut(p) : null;
  if (result.items.length === 0) return { ...result, openNowLeftOut: leftOut };
  const [marks, hours] = await Promise.all([
    getFreshnessMarks(result.items.map((i) => i.foodItemId)),
    getHoursStatuses(result.items.map((i) => i.venue?.id ?? "")),
  ]);
  return {
    ...result,
    openNowLeftOut: leftOut,
    items: result.items.map((i) => {
      const withVenue = i.venue && hours[i.venue.id] ? { ...i, venue: { ...i.venue, hours: hours[i.venue.id] } } : i;
      return marks.foods[i.foodItemId] ? { ...withVenue, freshness: marks.foods[i.foodItemId] } : withVenue;
    }),
  };
}

export async function getFood(id: string, includeEstimates = false): Promise<FoodDetail> {
  return rpc(
    "food_detail",
    { p_food_item_id: id, p_include_demo: FLAGS.allowDemoContent, p_include_estimates: includeEstimates },
    foodDetailSchema,
  );
}

/** NIE N-4: the "How we got this" explanation for a dish's protein. Estimates stay hidden unless asked for. */
export async function getProteinExplanation(id: string, includeEstimates = false): Promise<ProteinExplanation> {
  return rpc(
    "protein_explanation",
    { p_food_item_id: id, p_include_demo: FLAGS.allowDemoContent, p_include_estimates: includeEstimates },
    proteinExplanationSchema,
  );
}

export async function getVenue(id: string): Promise<VenueDetail> {
  return rpc("venue_detail", { p_venue_id: id, p_include_demo: FLAGS.allowDemoContent }, venueDetailSchema);
}

export async function compareFoods(ids: string[], includeEstimates = false): Promise<FoodDetail[]> {
  return rpc(
    "protein_compare",
    { p_food_item_ids: ids, p_include_demo: FLAGS.allowDemoContent, p_include_estimates: includeEstimates },
    // The database returns null when none of the requested foods is public any more.
    foodDetailSchema.array().nullish().transform((v) => v ?? []),
  );
}

export async function getFilterOptions(): Promise<FilterOptions> {
  return rpc("catalog_filter_options", { p_market: DEFAULT_MARKET, p_include_demo: FLAGS.allowDemoContent }, filterOptionsSchema);
}

/** Eligibility of one item for the visitor's own filter, decided by the database rule. */
export async function checkEligibility(revisionId: string, diet: DietPreference): Promise<Eligibility | null> {
  if (diet.diet === "none" && diet.exclusions.length === 0) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("check_eligibility", {
    p_revision_id: revisionId,
    p_diet: diet.diet,
    p_exclusions: diet.exclusions,
    p_include_conditional: diet.includeConditional,
  });
  if (error) throw toCatalogError(error);
  const d = data as { status?: Eligibility["status"]; reasons?: Eligibility["reasons"] } | null;
  if (!d?.status) throw new CatalogError(500, "CATALOG_RESPONSE_INVALID");
  return { status: d.status, reasons: d.reasons ?? [] };
}
