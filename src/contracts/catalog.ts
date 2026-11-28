import { z } from "zod";
import { INGREDIENT_FAMILIES } from "@/domain/dietary/families";
import { hoursStatusSchema, openNowLeftOutSchema } from "@/contracts/hours";

/**
 * Shared input and response contracts for the catalog (docs/11). Inputs are
 * validated before they reach the database; responses are parsed so pages and
 * API routes only ever pass on the fields listed here.
 */
export const KINDS = ["dish", "recipe", "packaged", "ingredient"] as const;
export const BASES = ["serving", "100g", "100kcal"] as const;
export const VIEWS = ["matches", "needs_confirmation"] as const;
export type Kind = (typeof KINDS)[number];
export type Basis = (typeof BASES)[number];
export type ResultView = (typeof VIEWS)[number];

const uuid = z.uuid();
const family = z.enum(INGREDIENT_FAMILIES);

/** The dietary filter a person chose. Stored in a first-party cookie, never guessed. */
export const dietPreferenceSchema = z.object({
  diet: z.enum(["none", "vegetarian", "vegan"]).default("none"),
  exclusions: z.array(family).max(INGREDIENT_FAMILIES.length).default([]),
  includeConditional: z.boolean().default(false),
});
export type DietPreference = z.infer<typeof dietPreferenceSchema>;
export const NO_DIET_PREFERENCE: DietPreference = { diet: "none", exclusions: [], includeConditional: false };

/** Filters that travel in the page address so a search can be shared or reloaded. */
export const searchFiltersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  view: z.enum(VIEWS).default("matches"),
  kinds: z.array(z.enum(KINDS)).max(KINDS.length).optional(),
  neighborhood: z.string().trim().min(1).max(80).optional(),
  cuisine: z.string().trim().min(1).max(40).optional(),
  maxPriceBand: z.coerce.number().int().min(1).max(4).optional(),
  venueType: z.enum(["restaurant", "cafe", "bakery", "food_truck", "market_stall", "other"]).optional(),
  venueId: uuid.optional(),
  minProtein: z.coerce.number().min(1).max(200).optional(),
  basis: z.enum(BASES).default("serving"),
  includeEstimates: z.boolean().default(false),
  /** MAP-2: only dishes at places open now by checked hours (app.venue_hours_status). */
  openNow: z.boolean().default(false),
  /** protein_per_dollar: Protein Explorer's "Per dollar" ranking (docs/53). */
  sort: z.enum(["default", "protein", "protein_per_dollar"]).default("default"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

/** A location is only ever accepted in a request body, used once and not stored. */
export const nearbySchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  radiusM: z.number().int().min(100).max(50000).default(5000),
});
export type Nearby = z.infer<typeof nearbySchema>;

export const idSchema = uuid;
export const compareIdsSchema = z.array(uuid).min(1).max(3);

// ---- responses -------------------------------------------------------------
const num = z.number().nullable();
const sourceSchema = z
  .object({
    publisher: z.string().nullable(),
    sourceType: z.string().nullable(),
    observedAt: z.string().nullable(),
    summary: z.string().nullable(),
    url: z.string().nullable(),
    isDemo: z.boolean().nullable(),
  })
  .nullable();
export type Source = z.infer<typeof sourceSchema>;

export const proteinFactsSchema = z.object({
  method: z.string().nullable(),
  basis: z.object({ kind: z.string(), amount: z.number(), unit: z.string() }),
  basisValue: num,
  servingLabel: z.string().nullable(),
  servingGrams: num,
  perServing: num,
  perServingReason: z.string().nullable(),
  per100g: num,
  per100gReason: z.string().nullable(),
  per100kcal: num,
  per100kcalReason: z.string().nullable(),
  energyKcalPerServing: num,
  energyMethod: z.string().nullable(),
  /** An estimate's low and high ends on the record's own basis (same basis as basisValue); null unless the shown value is an estimated range. */
  estimateLow: num.optional(),
  estimateHigh: num.optional(),
});
export type ProteinFacts = z.infer<typeof proteinFactsSchema>;

/** NIE N-4: where a dish's protein figure came from and how reliable it is ("How we got this"). */
export const proteinExplanationLineSchema = z.object({
  lineNo: z.number(),
  label: z.string(),
  usdaDescription: z.string().nullable(),
  fdcId: z.number(),
  usdaDataset: z.string().nullable(),
  usdaRelease: z.string().nullable(),
  usdaState: z.enum(["raw", "cooked", "as_sold"]),
  weighedAs: z.enum(["raw", "cooked", "as_sold"]),
  preparation: z.string().nullable(),
  amountBasis: z.enum(["stated", "measured", "typical"]),
  grams: z.number(),
  gramsLow: z.number(),
  gramsHigh: z.number(),
  yieldFactor: num,
  yieldSource: z.string().nullable(),
  substitutes: z.number(),
  proteinG: num,
  lowG: num,
  highG: num,
});
export type ProteinExplanationLine = z.infer<typeof proteinExplanationLineSchema>;
export const proteinExplanationSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  state: z.enum(["restaurant_published", "published", "calculated", "estimated_range", "estimate_hidden", "unknown"]),
  value: num,
  low: num,
  high: num,
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  basis: z.object({ kind: z.string(), amount: z.number(), unit: z.string() }),
  missingReason: z.string().nullable(),
  assumptions: z.string().nullable(),
  source: sourceSchema,
  calculation: z
    .object({
      computedAt: z.string(),
      engineVersion: z.string(),
      inputsSha256: z.string(),
      quantityBasis: z.enum(["restaurant_verified", "editorial_typical"]),
      servingBasis: z.enum(["stated", "measured", "typical"]),
      servingFactorLow: z.number(),
      servingFactorHigh: z.number(),
      modelAssumptions: z.string().nullable(),
      lines: z.array(proteinExplanationLineSchema).nullable(),
      references: z
        .array(z.object({ dataset: z.string(), release: z.string(), sourceUrl: z.string(), contentSha256: z.string() }))
        .nullable(),
    })
    .nullable(),
});
export type ProteinExplanation = z.infer<typeof proteinExplanationSchema>;

export const eligibilitySchema = z.object({
  status: z.enum(["eligible", "conditional", "needs_confirmation", "excluded"]),
  reasons: z
    .array(z.object({ code: z.string(), family: z.string().nullish(), diet: z.string().nullish(), modifications: z.string().nullish() }))
    .default([]),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;

export const venueRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  neighborhood: z.string().nullable(),
  locality: z.string().nullish(),
  cuisines: z.array(z.string()).nullish(),
  priceBand: z.number().nullish(),
  /** MAP-2: added by the server after the search; absent means not known. */
  hours: hoursStatusSchema.optional(),
});

/** Whether a record is older than the agreed age, or has been marked as needing review (R2). */
export const freshnessMarkSchema = z.object({
  checkedAt: z.string().nullable(),
  state: z.enum(["current", "due", "out_of_date"]),
  underReview: z.boolean().optional(),
});
export type FreshnessMark = z.infer<typeof freshnessMarkSchema>;
export const freshnessMarksSchema = z.object({ foods: z.record(z.string(), freshnessMarkSchema), venues: z.record(z.string(), freshnessMarkSchema) });
export type FreshnessMarks = z.infer<typeof freshnessMarksSchema>;

export const searchItemSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  kind: z.enum(KINDS),
  name: z.string(),
  brand: z.string().nullable(),
  isDemo: z.boolean(),
  venue: venueRefSchema.nullable(),
  distanceM: num,
  protein: proteinFactsSchema,
  /** The dish's newest dated, sourced price; null when it has none. */
  price: z
    .object({ amountMinor: z.number().int(), currency: z.string(), servingDescription: z.string().nullable(), checkedAt: z.string() })
    .nullish()
    .transform((v) => v ?? null),
  /** Grams of protein per dollar, only when the protein is published or calculated and the price is dated. */
  proteinPerDollar: num.optional().transform((v) => v ?? null),
  eligibility: eligibilitySchema,
  families: z.array(z.object({ family: z.string(), label: z.string(), presence: z.string() })).nullish(),
  /** Added by the server after the search; absent means nothing to say. */
  freshness: freshnessMarkSchema.optional(),
});
export type SearchItem = z.infer<typeof searchItemSchema>;

export const searchResultSchema = z.object({
  items: z.array(searchItemSchema).nullish().transform((v) => v ?? []),
  nextOffset: z.number().nullable(),
  counts: z.object({
    matches: z.number(),
    needsConfirmation: z.number(),
    hidden: z.number(),
    notComparable: z.number(),
    /** Results that cannot be ranked per dollar (no sourced protein per serving or no dated price). */
    notPricedComparable: z.number().default(0),
  }),
  hiddenReasons: z
    .array(z.object({ code: z.string(), family: z.string().nullable(), count: z.number() }))
    .nullish()
    .transform((v) => v ?? []),
  applied: z.object({
    diet: z.string().nullable(),
    exclusions: z.array(z.string()).nullish().transform((v) => v ?? []),
    view: z.string(),
    basis: z.string(),
    sort: z.string(),
    market: z.string(),
  }),
  /** MAP-2: with "Open now" on, places left out because their hours need confirmation. */
  openNowLeftOut: openNowLeftOutSchema.nullish(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

const familyDetailSchema = z.object({
  family: z.string(),
  label: z.string(),
  presence: z.string(),
  detail: z.string().nullable(),
  checkedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  source: sourceSchema,
});
export type FamilyDetail = z.infer<typeof familyDetailSchema>;

export const foodDetailSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  revisionNo: z.number(),
  kind: z.enum(KINDS),
  name: z.string(),
  brand: z.string().nullable(),
  description: z.string().nullable(),
  publishedAt: z.string().nullable(),
  isDemo: z.boolean(),
  basis: z.object({ kind: z.string(), amount: z.number(), unit: z.string() }),
  protein: proteinFactsSchema,
  venue: venueRefSchema
    .extend({ region: z.string().nullish(), menuSection: z.string().nullish(), availability: z.string().nullish() })
    .nullable(),
  nutrients: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        unit: z.string(),
        value: num,
        method: z.string().nullable(),
        missingReason: z.string().nullable(),
        source: sourceSchema,
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
  portions: z.array(z.object({ id: z.string(), label: z.string(), amount: z.number(), unit: z.string(), grams: num })),
  dietaryClaims: z.array(
    z.object({
      diet: z.string(),
      outcome: z.string(),
      evidenceTier: z.string().nullable(),
      conflictState: z.string().nullable(),
      modifications: z.string().nullable(),
      checkedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      expired: z.boolean(),
      source: sourceSchema,
    }),
  ),
  families: z.array(familyDetailSchema).nullish().transform((v) => v ?? []),
  allergens: z.array(
    z.object({ allergen: z.string(), presence: z.string(), crossContact: z.string().nullish(), checkedAt: z.string().nullish() }),
  ),
  prices: z.array(
    z.object({ amountMinor: z.number(), currency: z.string(), servingDescription: z.string().nullish(), checkedAt: z.string().nullish() }),
  ),
  recipe: z
    .object({
      yieldServings: num,
      prepMinutes: num,
      cookMinutes: num,
      equipment: z.array(z.string()).nullish(),
      trialCookedAt: z.string().nullable(),
      ingredients: z.array(
        z.object({
          position: z.number(),
          name: z.string(),
          quantity: num,
          unit: z.string().nullable(),
          optional: z.boolean(),
          includedByDefault: z.boolean(),
          foodItemId: z.string().nullable(),
        }),
      ),
      steps: z.array(z.object({ ordinal: z.number(), instruction: z.string(), timerSeconds: num })),
    })
    .nullable(),
});
export type FoodDetail = z.infer<typeof foodDetailSchema>;

export const venueDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  neighborhood: z.string().nullable(),
  street: z.string().nullable(),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  venueType: z.string().nullable(),
  status: z.string(),
  isDemo: z.boolean(),
  cuisines: z.array(z.string()).nullish().transform((v) => v ?? []),
  priceBand: num,
  reviewedAt: z.string().nullable(),
  facts: z.array(
    z.object({ field: z.string(), value: z.unknown(), checkedAt: z.string().nullable(), expired: z.boolean().nullish(), source: sourceSchema }),
  ),
});
export type VenueDetail = z.infer<typeof venueDetailSchema>;

export const filterOptionsSchema = z.object({
  neighborhoods: z.array(z.string()).nullish().transform((v) => v ?? []),
  cuisines: z.array(z.string()).nullish().transform((v) => v ?? []),
  families: z.array(z.object({ code: z.string(), label: z.string() })),
});
export type FilterOptions = z.infer<typeof filterOptionsSchema>;

export const savesSchema = z.object({
  foods: z.array(
    z.object({
      saveId: z.string(),
      foodItemId: z.string(),
      kind: z.enum(KINDS),
      name: z.string(),
      brand: z.string().nullable(),
      isDemo: z.boolean(),
      venue: z.object({ id: z.string(), name: z.string(), neighborhood: z.string().nullable() }).nullable(),
      protein: proteinFactsSchema,
      /** How this saved food stands against the member's current dietary filter. */
      eligibility: eligibilitySchema,
    }),
  ),
  venues: z.array(
    z.object({
      saveId: z.string(),
      id: z.string(),
      name: z.string(),
      neighborhood: z.string().nullable(),
      locality: z.string().nullable(),
      cuisines: z.array(z.string()).nullish(),
      priceBand: num,
      isDemo: z.boolean(),
    }),
  ),
  /** Saved real places (docs/49). Identity only: their menus are not checked. */
  places: z
    .array(
      z.object({
        saveId: z.string(),
        venueId: z.string(),
        slug: z.string(),
        name: z.string(),
        area: z.string().nullable(),
        street: z.string().nullable(),
        category: z.string(),
        menuStatus: z.string(),
      }),
    )
    .default([]),
  total: z.number(),
});
export type Saves = z.infer<typeof savesSchema>;

export const CORRECTION_FIELDS = [
  "name", "ingredients", "dietary", "egg", "dairy", "allergen", "nutrition", "portion", "price", "hours", "closed", "other",
] as const;
export const correctionSchema = z
  .object({
    foodItemId: uuid.optional(),
    venueId: uuid.optional(),
    field: z.enum(CORRECTION_FIELDS),
    proposedValue: z.string().trim().min(3, "Tell us what should change (at least 3 characters).").max(1000),
    evidenceNote: z.string().trim().max(1000).optional(),
  })
  .refine((v) => Boolean(v.foodItemId) !== Boolean(v.venueId), { message: "Choose one item." });
