import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DEFAULT_MARKET } from "@/config/markets";
import { FLAGS } from "@/config/flags";
import {
  placeDetailSchema,
  placeDirectorySchema,
  placeMapSchema,
  reportsQueueSchema,
  type PlaceDetail,
  type PlaceDirectory,
  type PlaceMap,
  type PlaceMapRequest,
  type PlaceReport,
} from "@/contracts/places";
import { writeSchema } from "@/contracts/social";
import { rpc } from "@/server/social";
import { z } from "zod";

/**
 * Real place directory (docs/32, docs/36). Runs as the visitor; the database decides what they may see:
 * preview listings only for the founder (publisher or admin role) and only when this server asks
 * for the preview, public listings for everyone (none while the real-place lock is off).
 */
export async function getPlaceDirectory(opts: { q?: string; area?: string; kind?: string; checked?: boolean; cuisine?: string; possible?: boolean; offset?: number; limit?: number; near?: PlaceMapRequest["near"] }): Promise<PlaceDirectory> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_directory", {
    p: {
      market: DEFAULT_MARKET,
      preview: FLAGS.realCatalogPreview,
      q: opts.q || undefined,
      area: opts.area || undefined,
      kind: opts.kind || undefined,
      checked: opts.checked || undefined,
      cuisine: opts.cuisine || undefined,
      possible: opts.possible || undefined,
      offset: opts.offset ?? 0,
      limit: opts.limit ?? 24,
      ...(opts.near ? { lat: opts.near.lat, lon: opts.near.lon, radiusM: opts.near.radiusM } : {}),
    },
  });
  if (error) throw new Error("PLACES_UNAVAILABLE");
  const parsed = placeDirectorySchema.safeParse(data);
  if (!parsed.success) throw new Error("PLACES_RESPONSE_INVALID");
  return parsed.data;
}

/** The map view: the same filters as the list, up to 500 places with minimal fields. */
export async function getPlaceMap(req: PlaceMapRequest): Promise<PlaceMap> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_directory", {
    p: {
      market: DEFAULT_MARKET,
      preview: FLAGS.realCatalogPreview,
      mode: "map",
      q: req.q || undefined,
      area: req.area || undefined,
      kind: req.kind || undefined,
      checked: req.checked || undefined,
      cuisine: req.cuisine || undefined,
      possible: req.possible || undefined,
      ...(req.box ?? {}),
      ...(req.near ? { lat: req.near.lat, lon: req.near.lon, radiusM: req.near.radiusM } : {}),
    },
  });
  if (error) throw new Error("PLACES_UNAVAILABLE");
  const parsed = placeMapSchema.safeParse(data);
  if (!parsed.success) throw new Error("PLACES_RESPONSE_INVALID");
  return parsed.data;
}

/** One real place by its slug, or null when it does not exist or this visitor may not see it. */
export async function getPlaceDetail(slug: string): Promise<PlaceDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_detail", { p_slug: slug, p_preview: FLAGS.realCatalogPreview });
  if (error) throw new Error("PLACES_UNAVAILABLE");
  if (data === null) return null;
  const parsed = placeDetailSchema.safeParse(data);
  if (!parsed.success) throw new Error("PLACES_RESPONSE_INVALID");
  return parsed.data;
}

/** A signed-in member reports a problem with a place. Never changes the listing. */
export const reportPlaceProblem = (r: PlaceReport) =>
  rpc("report_place_problem", { p_listing: r.listingId, p_reason: r.reason, p_note: r.note || null, p_preview: FLAGS.realCatalogPreview }, writeSchema);
/** The founder's list of reports. */
export const getReportsQueue = (openOnly = true) => rpc("place_reports_queue", { p_open_only: openOnly }, reportsQueueSchema);
export const resolvePlaceReport = (id: number, resolution: string, note?: string) =>
  rpc("resolve_place_report", { p_report: id, p_resolution: resolution, p_note: note || null }, writeSchema);

const venueIdSchema = z.string().uuid();

/**
 * The app's place record (a venue) for a real place, so saves, ratings and lists can point at it (docs/49).
 * Made the first time a signed-in member who may see the place opens it; identity fields only.
 * Null for a guest, and null when the visitor may not see the place.
 */
export async function linkPlaceVenue(listingId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_link_venue", { p_listing: listingId, p_preview: FLAGS.realCatalogPreview });
  if (error) {
    if (error.message === "NOT_FOUND" || error.message === "NOT_SIGNED_IN") return null;
    throw new Error("PLACES_UNAVAILABLE");
  }
  return venueIdSchema.parse(data);
}

/** The place page for an app place record that was made for a real place, if this visitor may see it. */
export async function getPlaceSlugForVenue(venueId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_slug_for_venue", { p_venue: venueId });
  if (error || typeof data !== "string") return null;
  return data;
}

/** The app place record of a real place without making one (for guests), or null. */
export async function getPlaceVenue(slug: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("place_venue", { p_slug: slug, p_preview: FLAGS.realCatalogPreview });
  if (error || typeof data !== "string") return null;
  return data;
}
