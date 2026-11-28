import "server-only";
import { connection } from "next/server";
import { z } from "zod";
import {
  BASES,
  KINDS,
  dietPreferenceSchema,
  searchFiltersSchema,
  type DietPreference,
  type SearchFilters,
} from "@/contracts/catalog";
import { INGREDIENT_FAMILIES } from "@/domain/dietary/families";
import { limitRefusal, statusJson } from "@/server/http";
import { checkRateLimit } from "@/server/rate-limit";
import { CatalogError } from "@/server/catalog";
import { readDietPreference } from "@/server/catalog/diet";

const list = (value: unknown) =>
  typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(value) ? value : undefined;
const bool = (value: unknown) => (value === "true" || value === true ? true : value === "false" || value === false ? false : undefined);

/** Raw address or body values to validated filters. Unknown keys are ignored; bad values are reported per field. */
export const apiFiltersSchema = z.object({
  q: z.string().optional(),
  view: z.string().optional(),
  kinds: z.preprocess(list, z.array(z.enum(KINDS)).optional()),
  neighborhood: z.string().optional(),
  cuisine: z.string().optional(),
  maxPriceBand: z.union([z.string(), z.number()]).optional(),
  venueType: z.string().optional(),
  venueId: z.string().optional(),
  minProtein: z.union([z.string(), z.number()]).optional(),
  basis: z.enum(BASES).optional(),
  includeEstimates: z.preprocess(bool, z.boolean().optional()),
  openNow: z.preprocess(bool, z.boolean().optional()),
  sort: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  offset: z.union([z.string(), z.number()]).optional(),
});

const apiDietSchema = z.object({
  diet: z.enum(["none", "vegetarian", "vegan"]).optional(),
  exclusions: z.preprocess(list, z.array(z.enum(INGREDIENT_FAMILIES)).optional()),
  includeConditional: z.preprocess(bool, z.boolean().optional()),
});

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[issue.path.join(".") || "request"] = issue.message;
  return out;
}

export type ParsedCatalogInput = { filters: SearchFilters; diet: DietPreference };

/**
 * Filters come from the request. The dietary filter comes from the request when
 * given, otherwise from the visitor's saved choice.
 */
export async function parseCatalogInput(raw: Record<string, unknown>): Promise<ParsedCatalogInput | Response> {
  const loose = apiFiltersSchema.safeParse(raw);
  if (!loose.success) return statusJson(422, "INVALID_FILTERS", fieldErrors(loose.error));
  const filters = searchFiltersSchema.safeParse(loose.data);
  if (!filters.success) return statusJson(422, "INVALID_FILTERS", fieldErrors(filters.error));
  const dietRaw = apiDietSchema.safeParse(raw);
  if (!dietRaw.success) return statusJson(422, "INVALID_DIET", fieldErrors(dietRaw.error));
  const explicit = dietRaw.data.diet !== undefined || dietRaw.data.exclusions !== undefined;
  const diet = explicit ? dietPreferenceSchema.parse(dietRaw.data) : await readDietPreference();
  return { filters: filters.data, diet };
}

/** Shared wrapper: rate limit first, then run, then turn known failures into the documented error shape. */
export async function catalogRoute(request: Request, run: () => Promise<Response>): Promise<Response> {
  // Always answered at request time; never prerendered or shared.
  await connection();
  try {
    const refused = limitRefusal(await checkRateLimit(request));
    if (refused) return refused;
    return await run();
  } catch (e) {
    if (e instanceof CatalogError) return statusJson(e.status, e.code);
    // Never echo request details (which may include a location) into logs.
    console.error("catalog_route_error", e instanceof Error ? e.name : "unknown");
    return statusJson(500, "CATALOG_UNAVAILABLE");
  }
}
