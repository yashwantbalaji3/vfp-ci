import { z } from "zod";
import { VIEWS, eligibilitySchema, freshnessMarkSchema, proteinFactsSchema } from "./catalog";
import { hoursStatusSchema, openNowLeftOutSchema } from "./hours";

/**
 * Map Discovery (MAP-1) request and response shapes. A position or a map rectangle is only
 * ever accepted in a request body, rounded to about 100 m, used once and not stored.
 */

/** Rounds to 3 decimal places (about 100 m). Applied in the browser and again on the server. */
export const roundCoord = (n: number) => Math.round(n * 1000) / 1000;

/** Distances people can choose, in metres (0.25, 0.5, 1, 3, 5 miles). MAP-D defaults: 0.5 mi phone, 1 mi desktop. */
export const RADII = [
  { label: "0.25 mile", meters: 402 },
  { label: "0.5 mile", meters: 805 },
  { label: "1 mile", meters: 1609 },
  { label: "3 miles", meters: 4828 },
  { label: "5 miles", meters: 8047 },
] as const;
export const RADIUS_METERS = RADII.map((r) => r.meters) as number[];
export const DEFAULT_RADIUS = { phone: 805, desktop: 1609 } as const;

const lat = z.number().min(-90).max(90).transform(roundCoord);
const lon = z.number().min(-180).max(180).transform(roundCoord);

export const mapAreaInputSchema = z.union([
  z.object({ kind: z.literal("radius"), lat, lon, radiusM: z.number().int().refine((m) => RADIUS_METERS.includes(m), "Choose one of the offered distances") }),
  z
    .object({ kind: z.literal("box"), west: lon, south: lat, east: lon, north: lat })
    .refine((b) => b.west < b.east && b.south < b.north && b.east - b.west <= 2 && b.north - b.south <= 2, "Map area is not valid"),
  z.object({ kind: z.literal("market") }),
]);
export type MapAreaInput = z.infer<typeof mapAreaInputSchema>;

export const mapRequestSchema = z.object({
  area: mapAreaInputSchema,
  view: z.enum(VIEWS).default("matches"),
});

export const mapAreaSchema = z.object({
  slug: z.string(),
  kind: z.enum(["neighborhood", "city", "zip"]),
  name: z.string(),
  context: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  approximate: z.boolean(),
});
export type MapArea = z.infer<typeof mapAreaSchema>;
export const mapAreasSchema = z.array(mapAreaSchema).nullish().transform((v) => v ?? []);

const personPickSchema = z.object({
  person: z.object({ handle: z.string().nullable(), displayName: z.string().nullable() }).passthrough(),
  rating: z.number(),
  audience: z.enum(["public", "friends"]).optional(),
});

export const mapDishSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  kind: z.literal("dish"),
  name: z.string(),
  brand: z.string().nullable(),
  isDemo: z.boolean(),
  distanceM: z.number().nullable(),
  protein: proteinFactsSchema,
  eligibility: eligibilitySchema,
  recommendedBy: z.array(personPickSchema).nullish(),
  freshness: freshnessMarkSchema.optional(),
});
export type MapDish = z.infer<typeof mapDishSchema>;

export const mapPlaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  neighborhood: z.string().nullable(),
  locality: z.string().nullable(),
  cuisines: z.array(z.string()).nullish(),
  priceBand: z.number().nullish(),
  venueType: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  distanceM: z.number().nullable(),
  dishCount: z.number(),
  dishes: z.array(mapDishSchema),
  mine: z
    .object({
      saved: z.boolean(),
      lists: z.array(z.object({ id: z.string(), title: z.string() })),
      recommendedBy: z.array(personPickSchema).nullish(),
    })
    .nullable(),
  freshness: freshnessMarkSchema.optional(),
  /** MAP-2: opening status from the database; absent means not known. */
  hours: hoursStatusSchema.optional(),
});
export type MapPlace = z.infer<typeof mapPlaceSchema>;

export const mapResultSchema = z.object({
  places: z.array(mapPlaceSchema),
  truncated: z.boolean(),
  counts: z.object({
    places: z.number(),
    dishes: z.number(),
    placesMatches: z.number(),
    placesNeedsConfirmation: z.number(),
    dishesMatches: z.number(),
    dishesNeedsConfirmation: z.number(),
    hidden: z.number(),
    notComparable: z.number(),
  }),
  applied: z.object({ view: z.string(), diet: z.string(), area: z.enum(["radius", "box", "market"]), radiusM: z.number().nullable(), market: z.string() }),
  openNowLeftOut: openNowLeftOutSchema.nullish(),
});
export type MapResult = z.infer<typeof mapResultSchema>;
