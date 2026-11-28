import { z } from "zod";

/**
 * Real place listings (docs/32): identity only. There is deliberately no dietary, menu, dish or
 * nutrition field: a listing can never be read as a vegetarian, vegan or protein match.
 */
/** How a listing's identity is known: the founder's own check, a sample-checked batch, or two public datasets. */
const identityBasis = z.enum(["verified", "batch_sampled", "corroborated", "single_source"]);
export type IdentityBasis = z.infer<typeof identityBasis>;

/**
 * Cuisine or style from Overture Maps' own category (docs/49 "Cuisine"): "dataset_primary" is Overture's main
 * category for the place; "dataset_alternate" appears only among its other categories and is shown as "possibly".
 * Never checked by us, never a dietary claim.
 */
const cuisineBasis = z.enum(["dataset_primary", "dataset_alternate"]);
const placeCuisineSchema = z.object({ cuisine: z.string(), basis: cuisineBasis });
export type PlaceCuisine = z.infer<typeof placeCuisineSchema>;
/** "Italian", or "Italian (possibly Pizza)", or null when no cuisine is known. */
export function cuisineWords(cs: PlaceCuisine[]): string | null {
  const sure = cs.filter((c) => c.basis === "dataset_primary").map((c) => c.cuisine);
  const maybe = cs.filter((c) => c.basis === "dataset_alternate").map((c) => c.cuisine);
  if (!sure.length && !maybe.length) return null;
  if (!sure.length) return `Possibly ${maybe.join(" or ")}`;
  return maybe.length ? `${sure.join(", ")} (possibly ${maybe.join(" or ")})` : sure.join(", ");
}

/**
 * A place-level hint from Overture Maps' own category (owner 20 Nov 2026 21:20 UTC, item 5; docs/64): the open map
 * lists the place as a vegetarian or vegan restaurant. Shown only with that attribution, never as a dish's diet,
 * never in a diet filter or count. "dataset_alternate" is one of the map's other categories ("may be").
 */
export const dietHintSchema = z.object({ hint: z.enum(["vegetarian", "vegan"]), basis: cuisineBasis, category: z.string().nullable().optional() });
export type DietHint = z.infer<typeof dietHintSchema>;
/** "Listed as a vegan restaurant in Overture Maps", or null. The strongest hint wins (vegan over vegetarian, primary over alternate). */
export function dietHintWords(hs: DietHint[] | undefined): string | null {
  const rank = (x: DietHint) => (x.basis === "dataset_primary" ? 0 : 2) + (x.hint === "vegan" ? 0 : 1);
  const h = [...(hs ?? [])].sort((a, b) => rank(a) - rank(b))[0];
  if (!h) return null;
  return h.basis === "dataset_primary" ? `Listed as a ${h.hint} restaurant in Overture Maps` : `Overture Maps also lists it as a possible ${h.hint} restaurant`;
}

export const placeListingSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  street: z.string(),
  locality: z.string().nullable(),
  postcode: z.string(),
  area: z.string().nullable(),
  category: z.string(),
  lat: z.number(),
  lon: z.number(),
  distanceM: z.number().nullable(),
  identityStatus: z.enum(["corroborated", "verified", "single_source"]),
  identityBasis: identityBasis,
  menuStatus: z.literal("not_checked"),
  visibility: z.enum(["preview", "public"]),
  reported: z.boolean(),
  cuisines: z.array(placeCuisineSchema).default([]),
  sources: z.array(z.object({ title: z.string().nullable(), attribution: z.string().nullable() })),
});
export type PlaceListing = z.infer<typeof placeListingSchema>;

export const placeDirectorySchema = z.object({
  items: z.array(placeListingSchema),
  total: z.number(),
  nextOffset: z.number().nullable(),
  areas: z.array(z.object({ area: z.string(), count: z.number() })),
  /** Kinds of place among those this visitor may see, with counts (identity only). */
  kinds: z.array(z.object({ kind: z.string(), count: z.number() })).default([]),
  /** How many of them the founder has checked individually. */
  checked: z.number().default(0),
  /** Cuisines from Overture's main category among those this visitor may see, with counts. */
  cuisines: z.array(z.object({ cuisine: z.string(), count: z.number() })).default([]),
  preview: z.boolean(),
});
export type PlaceDirectory = z.infer<typeof placeDirectorySchema>;

export const PLACE_KINDS = ["Restaurant", "Café", "Coffee shop", "Juice bar", "Food truck", "Food court", "Quick service"] as const;
/** Filters shared by the list, the map and near-me, so all three always show the same places. */
const kind = z.enum(PLACE_KINDS).optional();
const checked = z.preprocess((v) => v === true || v === "true" || v === "1", z.boolean()).optional();
const cuisine = z.string().trim().min(1).max(40).optional();
/** Also match places whose cuisine is only "possibly" (Overture's other categories). */
const possible = checked;

export const placeQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  kind,
  checked,
  cuisine,
  possible,
  offset: z.coerce.number().int().min(0).max(5000).optional(),
  view: z.enum(["list", "map"]).optional(),
});

/** The plain words for each identity basis (docs/36). Only "verified" says "checked by us". */
export const IDENTITY_WORDS: Record<IdentityBasis, string> = {
  verified: "Identity checked by us",
  batch_sampled: "Address from two public datasets. Not checked by us individually; a random sample of its batch was checked",
  corroborated: "Address from two public datasets (not yet checked by us)",
  single_source: "One source, not cross-checked: name and address from one public dataset only",
};

/** The same states, short enough for a list card. The full wording is on the place page. */
export const IDENTITY_SHORT: Record<IdentityBasis, string> = {
  verified: "Identity checked by us",
  batch_sampled: "Address sample-checked, not yet checked by us individually",
  corroborated: "Address from public data, not yet checked by us",
  single_source: "One source, not cross-checked",
};

/* ---- Map view: minimal fields, up to 500 places ---- */
export const placePinSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  street: z.string(),
  category: z.string(),
  area: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  distanceM: z.number().nullable(),
  identityBasis: identityBasis,
});
export type PlacePin = z.infer<typeof placePinSchema>;
export const placeMapSchema = z.object({ items: z.array(placePinSchema), total: z.number(), preview: z.boolean() });
export type PlaceMap = z.infer<typeof placeMapSchema>;

const coord = (min: number, max: number) => z.number().min(min).max(max).transform((n) => Math.round(n * 1000) / 1000);
/** A map or near-me request. A position is rounded to about 100 m, sent in the body, used once and never stored. */
export const placeMapRequestSchema = z.object({
  q: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  kind,
  checked,
  cuisine,
  possible,
  box: z
    .object({ west: coord(-180, 180), south: coord(-90, 90), east: coord(-180, 180), north: coord(-90, 90) })
    .refine((b) => b.west < b.east && b.south < b.north && b.east - b.west <= 2 && b.north - b.south <= 2, "Map area is not valid")
    .optional(),
  near: z.object({ lat: coord(-90, 90), lon: coord(-180, 180), radiusM: z.union([z.literal(402), z.literal(805), z.literal(1609), z.literal(4828)]) }).optional(),
  mode: z.enum(["map", "list"]).default("map"),
});
export type PlaceMapRequest = z.infer<typeof placeMapRequestSchema>;

/* ---- One place ---- */
export const placeDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  street: z.string(),
  locality: z.string().nullable(),
  postcode: z.string(),
  area: z.string().nullable(),
  category: z.string(),
  lat: z.number(),
  lon: z.number(),
  identityStatus: z.enum(["corroborated", "verified", "single_source"]),
  identityBasis: identityBasis,
  menuStatus: z.literal("not_checked"),
  visibility: z.enum(["preview", "public"]),
  updatedAt: z.string(),
  batch: z.object({ name: z.string(), sampleSize: z.number(), problems: z.number(), upperBound: z.number(), approvedAt: z.string() }).nullable(),
  reported: z.boolean(),
  cuisines: z.array(placeCuisineSchema.extend({ category: z.string().nullable() })).default([]),
  sources: z.array(z.object({ title: z.string().nullable(), attribution: z.string().nullable(), release: z.string().nullable() })),
});
export type PlaceDetail = z.infer<typeof placeDetailSchema>;


/* ---- Report a problem ---- */
export const REPORT_REASONS = ["wrong_address", "duplicate", "closed", "not_public", "other"] as const;
export const REPORT_WORDS: Record<(typeof REPORT_REASONS)[number], string> = {
  wrong_address: "The address or map position is wrong",
  duplicate: "It is listed twice",
  closed: "It has closed",
  not_public: "It is not open to the public",
  other: "Something else (please say what)",
};
export const reportSchema = z
  .object({ listingId: z.string().uuid(), reason: z.enum(REPORT_REASONS), note: z.string().trim().max(500).optional() })
  .refine((r) => r.reason !== "other" || (r.note ?? "").length > 0, { message: "NOTE_REQUIRED" });
export type PlaceReport = z.infer<typeof reportSchema>;

export const RESOLUTIONS = ["fixed", "no_change", "already_known"] as const;
export const RESOLUTION_WORDS: Record<(typeof RESOLUTIONS)[number], string> = {
  fixed: "Fixed (I decided the place in identity review)",
  no_change: "No change needed",
  already_known: "Already known",
};
export const reportsQueueSchema = z.object({
  open: z.number(),
  items: z.array(
    z.object({
      id: z.number(),
      reason: z.enum(REPORT_REASONS),
      note: z.string().nullable(),
      createdAt: z.string(),
      resolution: z.enum(RESOLUTIONS).nullable(),
      resolutionNote: z.string().nullable(),
      resolvedAt: z.string().nullable(),
      listing: z.object({ slug: z.string(), name: z.string(), street: z.string(), postcode: z.string(), candidateId: z.string(), visibility: z.string() }),
      inReview: z.boolean(),
    }),
  ),
});
export type ReportsQueue = z.infer<typeof reportsQueueSchema>;
