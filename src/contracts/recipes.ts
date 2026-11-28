import { z } from "zod";
import { MEAL_SLOTS, isoDateSchema } from "@/contracts/diary";

/**
 * Recipes, cook sessions and the week plan (docs/09, M4). Inputs are validated here
 * before anything reaches the database; responses are parsed so a screen never shows
 * a shape it did not expect. A nutrient value is a number or null. Null means "not known".
 */
export const CUISINES = ["indian", "asian", "mediterranean", "middle_eastern", "mexican", "italian", "east_african", "american", "everyday"] as const;
export type Cuisine = (typeof CUISINES)[number];
export const CUISINE_LABELS: Record<Cuisine, string> = {
  indian: "Indian",
  asian: "Asian",
  mediterranean: "Mediterranean",
  middle_eastern: "Middle Eastern",
  mexican: "Mexican",
  italian: "Italian",
  east_african: "East African",
  american: "American",
  everyday: "Everyday",
};
export const RECIPE_VIEWS = ["matches", "needs_confirmation"] as const;
/** "High protein" on the recipe list means at least this much protein in one serving. */
export const HIGH_PROTEIN_G = 20;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Not a valid id");
const groupKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** Chosen substitutions: approved group -> the ingredient line chosen for it. */
export const swapsSchema = z.record(groupKey, uuid).refine((v) => Object.keys(v).length <= 12, "Too many swaps");
export type Swaps = z.infer<typeof swapsSchema>;
const servings = z.coerce.number("Enter servings as a number").min(0.25, "Enter at least a quarter serving").max(100, "That's more than we can scale to (100 at most)");

export const recipeFiltersSchema = z.object({
  q: z.string().trim().max(120).optional(),
  meal: z.enum(MEAL_SLOTS).optional(),
  cuisine: z.enum(CUISINES).optional(),
  highProtein: z.boolean().default(false),
  maxMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  view: z.enum(RECIPE_VIEWS).default("matches"),
});
export type RecipeFilters = z.infer<typeof recipeFiltersSchema>;

export const recipeOptionsSchema = z.object({ servings: servings.optional(), swaps: swapsSchema.default({}) });
export type RecipeOptions = z.infer<typeof recipeOptionsSchema>;

export const startCookInputSchema = z.object({
  idempotencyKey: uuid,
  foodItemId: uuid,
  servings: servings.optional(),
  swaps: swapsSchema.default({}),
  planId: uuid.optional(),
});
export type StartCookInput = z.infer<typeof startCookInputSchema>;

export const cookProgressInputSchema = z.object({
  sessionId: uuid,
  currentStep: z.coerce.number().int().min(0).max(200),
  checkedIngredients: z.array(uuid).max(200).default([]),
});
export type CookProgressInput = z.infer<typeof cookProgressInputSchema>;

export const logCookInputSchema = z.object({
  idempotencyKey: uuid,
  sessionId: uuid,
  servings: z.coerce.number("Enter how many servings you ate").positive("Enter an amount more than 0").max(100, "That's more than we can record"),
  mealSlot: z.enum(MEAL_SLOTS, "Choose a meal"),
  date: isoDateSchema,
  additional: z.boolean().default(false),
});
export type LogCookInput = z.infer<typeof logCookInputSchema>;

export const planInputSchema = z.object({
  foodItemId: uuid,
  date: isoDateSchema,
  servings: servings.optional(),
  mealSlot: z.enum(MEAL_SLOTS).optional(),
});
export type PlanInput = z.infer<typeof planInputSchema>;
export const idInputSchema = uuid;

// ----- responses -----
const num = z.number().nullable();
const reason = z.looseObject({ code: z.string(), family: z.string().nullish(), ingredient: z.string().nullish(), modifications: z.string().nullish() });
const STATUSES = ["eligible", "conditional", "needs_confirmation", "excluded"] as const;
const eligibility = z.object({ status: z.enum(STATUSES), reasons: z.array(reason), basis: z.enum(["as_written", "ingredients"]).optional() });
export type RecipeEligibility = z.infer<typeof eligibility>;

export const recipeCardSchema = z.object({
  foodItemId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDemo: z.boolean(),
  mealTypes: z.array(z.string()),
  cuisine: z.string().nullable(),
  prepMinutes: num,
  cookMinutes: num,
  yieldServings: z.number(),
  proteinG: num,
  proteinMethod: z.string().nullable(),
  energyKcal: num,
  swapGroups: z.number(),
  eligibility,
});
export type RecipeCard = z.infer<typeof recipeCardSchema>;
/** A recipe that does not fit the filter as written but does with these approved swaps (docs/55). */
export const canBeMadeSchema = z.object({
  foodItemId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDemo: z.boolean(),
  mealTypes: z.array(z.string()),
  cuisine: z.string().nullable(),
  prepMinutes: num,
  cookMinutes: num,
  yieldServings: z.number(),
  swaps: z.record(z.string(), z.string()),
  swapNames: z.array(z.object({ group: z.string(), from: z.string(), to: z.string() })),
});
export type CanBeMade = z.infer<typeof canBeMadeSchema>;
export const recipeListSchema = z.object({
  items: z.array(recipeCardSchema),
  /** Never part of items or counts.matches. */
  canBeMade: z.array(canBeMadeSchema).default([]),
  counts: z.object({
    matches: z.number(),
    needsConfirmation: z.number(),
    hidden: z.number(),
    notComparable: z.number(),
    canBeMade: z.number().default(0),
  }),
});
export type RecipeList = z.infer<typeof recipeListSchema>;

const nutrientCell = z.object({
  value: num,
  unit: z.string(),
  method: z.string(),
  missingReason: z.string().nullable(),
  missingIngredients: z.number(),
  ingredientCount: z.number(),
  knownSubtotal: z.number(),
});
export type RecipeNutrient = z.infer<typeof nutrientCell>;
const alternative = z.object({
  id: z.string(),
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  note: z.string().nullable(),
  isDefault: z.boolean(),
  selected: z.boolean(),
  status: z.enum(STATUSES),
});
export type RecipeAlternative = z.infer<typeof alternative>;
const ingredient = z.object({
  id: z.string(),
  position: z.number(),
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
  grams: num,
  optional: z.boolean(),
  included: z.boolean(),
  group: z.string().nullable(),
  prepNote: z.string().nullable(),
  isDefault: z.boolean(),
  calculable: z.boolean(),
  alternatives: z.array(alternative),
});
export type RecipeIngredient = z.infer<typeof ingredient>;
const sourceSummary = z.looseObject({ publisher: z.string().nullish(), summary: z.string().nullish(), isDemo: z.boolean().nullish() }).nullable();

export const recipeDetailSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDemo: z.boolean(),
  mealTypes: z.array(z.string()),
  cuisine: z.string().nullable(),
  prepMinutes: num,
  cookMinutes: num,
  yieldServings: z.number(),
  servings: z.number(),
  scale: z.number(),
  servingNote: z.string().nullable(),
  equipment: z.array(z.string()),
  trialCookedAt: z.string().nullable(),
  swaps: z.record(z.string(), z.string()),
  swapped: z.boolean(),
  ingredients: z.array(ingredient),
  steps: z.array(z.object({ ordinal: z.number(), title: z.string().nullable(), instruction: z.string(), timerSeconds: num })),
  nutrients: z.record(z.string(), nutrientCell),
  eligibility,
  suitability: z.object({ vegetarian: z.enum(STATUSES), vegan: z.enum(STATUSES) }),
  families: z.array(z.string()),
  allergens: z.object({ contains: z.array(z.string()), unconfirmed: z.array(z.string()) }),
  source: z.object({ recipe: sourceSummary, nutritionMethod: z.string(), ingredientSources: z.array(sourceSummary) }),
  portion: z.object({ id: z.string(), label: z.string() }).nullable(),
});
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;

export const cookSessionSchema = z.object({
  sessionId: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  abandonedAt: z.string().nullable(),
  date: z.string(),
  servings: z.number(),
  currentStep: z.number(),
  checkedIngredients: z.array(z.string()),
  logPrompt: z.enum(["pending", "declined", "logged"]),
  version: z.number(),
  loggedServings: z.number(),
  entries: z.array(z.object({ entryId: z.string(), date: z.string(), mealSlot: z.string(), servings: z.number(), proteinG: num })),
  recipe: recipeDetailSchema,
});
export type CookSession = z.infer<typeof cookSessionSchema>;

export const myCookingSchema = z.object({
  inProgress: z.array(
    z.object({ sessionId: z.string(), foodItemId: z.string(), name: z.string(), date: z.string(), servings: z.number(), currentStep: z.number(), stepCount: z.number() }),
  ),
  recent: z.array(
    z.object({
      sessionId: z.string(), foodItemId: z.string(), name: z.string(), date: z.string(), servings: z.number(),
      substituted: z.boolean(), logPrompt: z.string(), loggedServings: z.number(),
    }),
  ),
});
export type MyCooking = z.infer<typeof myCookingSchema>;

export const planSchema = z.array(
  z.object({
    planId: z.string(), date: z.string(), mealSlot: z.string().nullable(), servings: z.number(), foodItemId: z.string(), name: z.string(),
    prepMinutes: num, cookMinutes: num, proteinG: num, cooked: z.boolean(), sessionId: z.string().nullable(),
  }),
);
export type PlanItem = z.infer<typeof planSchema>[number];

export const cookWriteSchema = z.looseObject({ sessionId: z.string().optional(), planId: z.string().optional(), replayed: z.boolean().optional() });
