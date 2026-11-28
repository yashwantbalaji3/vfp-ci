import { z } from "zod";

/**
 * Diary and goals contracts (docs/09). Inputs are validated here before anything
 * reaches the database; responses are parsed so a screen never renders a shape it
 * did not expect. A nutrient value is a number or null. Null means "not known".
 */
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];
export const MEAL_LABELS: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

export const CONTEXTS = ["home", "restaurant", "packaged"] as const;
export type EatingContext = (typeof CONTEXTS)[number];
export const CONTEXT_LABELS: Record<EatingContext, string> = {
  home: "Home-cooked",
  restaurant: "Restaurant or takeout",
  packaged: "Packaged food",
};

/** The nutrients the diary shows. Protein leads; the rest are available on request. */
export const DIARY_NUTRIENTS = [
  { code: "protein_g", label: "Protein", unit: "g" },
  { code: "energy_kcal", label: "Calories", unit: "kcal" },
  { code: "carb_g", label: "Carbohydrate", unit: "g" },
  { code: "fat_g", label: "Fat", unit: "g" },
  { code: "fiber_g", label: "Fiber", unit: "g" },
] as const;
export type DiaryNutrientCode = (typeof DIARY_NUTRIENTS)[number]["code"];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Not a valid id");

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-14")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "That date doesn't exist");

const mealSlot = z.enum(MEAL_SLOTS, "Choose a meal");
const context = z.enum(CONTEXTS, "Choose where it came from");
const amount = (max: number, what: string) =>
  z.coerce
    .number(`Enter ${what} as a number`)
    .positive(`${what[0].toUpperCase()}${what.slice(1)} must be more than 0`)
    .max(max, `That's more than we can record (${max} at most)`);

/** Either a defined portion times a quantity, or a weight in grams. Never both. */
export const logEntryInputSchema = z
  .object({
    idempotencyKey: uuid,
    revisionId: uuid,
    portionId: uuid.optional(),
    quantity: amount(100, "the amount").optional(),
    grams: amount(5000, "the weight").optional(),
    context,
    mealSlot,
    date: isoDateSchema,
  })
  .refine((v) => (v.portionId !== undefined && v.quantity !== undefined) !== (v.grams !== undefined), {
    message: "Choose a portion and how many, or enter a weight in grams",
    path: ["quantity"],
  });
export type LogEntryInput = z.infer<typeof logEntryInputSchema>;

const optionalNutrient = (max: number) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.coerce.number("Enter a number, or leave it empty").min(0, "This can't be negative").max(max, "That looks too high").optional(),
  );

/** Only the name is required. Anything left empty is stored as unknown. */
export const customFoodInputSchema = z.object({
  idempotencyKey: uuid,
  name: z.string().trim().min(1, "Give it a name").max(200, "Keep the name under 200 characters"),
  brand: z.string().trim().max(120).optional(),
  servingLabel: z.string().trim().max(80).optional(),
  servingGrams: optionalNutrient(5000),
  quantity: amount(100, "the amount"),
  proteinG: optionalNutrient(1000),
  energyKcal: optionalNutrient(20000),
  carbG: optionalNutrient(2000),
  fatG: optionalNutrient(1000),
  fiberG: optionalNutrient(500),
  context,
  mealSlot,
  date: isoDateSchema,
});
export type CustomFoodInput = z.infer<typeof customFoodInputSchema>;

export const updateEntryInputSchema = z
  .object({
    entryId: uuid,
    expectedVersion: z.coerce.number().int().min(1),
    portionId: uuid.optional(),
    quantity: amount(100, "the amount").optional(),
    grams: amount(5000, "the weight").optional(),
    mealSlot: mealSlot.optional(),
    date: isoDateSchema.optional(),
    /** An entry logged from a cooking session is measured in servings of that cook: only the amount can change. */
    cooked: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.cooked
        ? v.quantity !== undefined && v.portionId === undefined && v.grams === undefined
        : (v.portionId !== undefined && v.quantity !== undefined) !== (v.grams !== undefined),
    {
      message: "Enter how much you had",
      path: ["quantity"],
    },
  );
export type UpdateEntryInput = z.infer<typeof updateEntryInputSchema>;

export const deleteEntryInputSchema = z.object({ entryId: uuid, expectedVersion: z.coerce.number().int().min(1) });
export const repeatEntryInputSchema = z.object({
  idempotencyKey: uuid,
  entryId: uuid,
  date: isoDateSchema,
  mealSlot: mealSlot.optional(),
});
export type RepeatEntryInput = z.infer<typeof repeatEntryInputSchema>;

export const GOAL_METRICS = { proteinPerDay: "protein_g_per_day", homeMealsPerWeek: "cook_sessions_per_week" } as const;
const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);
/** Both goals are optional. An empty field means "no goal". */
export const goalsInputSchema = z.object({
  proteinPerDay: z
    .preprocess(emptyToNull, z.coerce.number("Enter grams as a number").min(1, "Enter at least 1 g").max(400, "Enter 400 g or less").nullable())
    .optional(),
  homeMealsPerWeek: z
    .preprocess(
      emptyToNull,
      z.coerce.number("Enter a whole number").int("Enter a whole number").min(1, "Enter at least 1").max(21, "Enter 21 or fewer").nullable(),
    )
    .optional(),
});
export type GoalsInput = z.infer<typeof goalsInputSchema>;

export const DAY_STATUSES = ["unspecified", "partial", "complete"] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];
export const dayStatusInputSchema = z.object({ date: isoDateSchema, status: z.enum(DAY_STATUSES) });

// ----- responses -----
const num = z.number().nullable();
/** An estimated range also carries its low and high ends (null for an exact or unknown value). */
const nutrientCell = z.object({ value: num, method: z.string().nullable(), lower: num.optional(), upper: num.optional() });
const nutrientMap = z.record(z.string(), nutrientCell).nullish().transform((v) => v ?? {});

const portionSnapshot = z.looseObject({
  kind: z.string(),
  portionId: z.string().nullish(),
  label: z.string().nullish(),
  grams: num.optional(),
  multiplier: z.number().nullish(),
});

/**
 * Where a logged real restaurant meal's figures came from (docs/63): a private, immutable copy made when it was
 * logged. Null for every other entry.
 */
export const mealSourceSchema = z.looseObject({
  kind: z.literal("real_meal"),
  restaurant: z.looseObject({ name: z.string() }),
  dish: z.looseObject({ id: z.string(), name: z.string() }),
  loggedAt: z.string(),
  source: z.looseObject({ url: z.string().nullish(), checkedOn: z.string().nullish() }),
  status: z.enum(["unverified_draft", "transcription_confirmed"]),
  protein: z.looseObject({
    evidence: z.enum(["restaurant_published", "restaurant_estimate", "restaurant_range", "restaurant_per_100g", "usda_estimate", "unknown"]),
    sourceAmount: z.number().nullish(),
    sourceLow: z.number().nullish(),
    sourceHigh: z.number().nullish(),
    logged: z.number().nullish(),
    method: z.string(),
    changedByYou: z.boolean(),
    typedByYou: z.boolean(),
  }),
  energy: z.looseObject({ sourceAmount: z.number().nullish(), logged: z.number().nullish(), changedByYou: z.boolean(), typedByYou: z.boolean() }).optional(),
  servings: z.number(),
});
export type MealSource = z.infer<typeof mealSourceSchema>;

export const diaryEntrySchema = z.object({
  entryId: z.string(),
  version: z.number(),
  context: z.enum(CONTEXTS),
  mealSlot: z.string(),
  foodItemId: z.string().nullable(),
  name: z.string(),
  portion: portionSnapshot,
  quantity: z.number(),
  massG: num,
  revisionNo: z.number(),
  editable: z.boolean(),
  /** Set when the entry was logged from a finished cooking session. */
  cookSessionId: z.string().nullish(),
  nutrients: nutrientMap,
  /** Set when the entry is a real restaurant meal logged with "Log this meal". */
  source: mealSourceSchema.nullish(),
});
export type DiaryEntry = z.infer<typeof diaryEntrySchema>;

export const nutrientTotalSchema = z.object({
  known: num,
  entryCount: z.number(),
  unknownEntries: z.number(),
  estimatedEntries: z.number(),
  /** The total with every estimate at its low (or high) end; exact values as they are. */
  low: num.optional(),
  high: num.optional(),
});
export type NutrientTotal = z.infer<typeof nutrientTotalSchema>;

export const diaryDaySchema = z.object({
  date: z.string(),
  status: z.enum(DAY_STATUSES),
  proteinTarget: num,
  entries: z.array(diaryEntrySchema),
  totals: z.record(z.string(), nutrientTotalSchema),
});
export type DiaryDay = z.infer<typeof diaryDaySchema>;

export const weekDaySchema = z.object({
  date: z.string(),
  status: z.enum(DAY_STATUSES),
  entryCount: z.number(),
  proteinKnown: num,
  /** Known protein with every estimate at its low end. */
  proteinLow: num.optional(),
  proteinUnknownEntries: z.number(),
  proteinEstimatedEntries: z.number(),
  energyKnown: num,
  energyUnknownEntries: z.number(),
  /** Home-cooked meals for the weekly goal: finished cook sessions plus home-cooked diary meals, the same meal never twice. */
  homeMeals: z.number(),
  homeMealsFromDiary: z.number(),
  cookSessions: z.number(),
  plannedCount: z.number(),
  proteinTarget: num,
});
export type WeekDay = z.infer<typeof weekDaySchema>;
export const diaryWeekSchema = z.object({ start: z.string(), homeMealsTarget: num, days: z.array(weekDaySchema).length(7) });
export type DiaryWeek = z.infer<typeof diaryWeekSchema>;

const goal = z.object({ target: z.number(), effectiveFrom: z.string() }).nullable();
export const goalsSchema = z.object({ proteinPerDay: goal, homeMealsPerWeek: goal });
export type Goals = z.infer<typeof goalsSchema>;

export const loggableFoodSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  kind: z.string(),
  isOwn: z.boolean(),
  isDemo: z.boolean(),
  name: z.string(),
  brand: z.string().nullable(),
  venueName: z.string().nullable(),
  basis: z.object({ kind: z.string(), amount: z.number(), unit: z.string() }),
  gramsSupported: z.boolean(),
  /** Set only for the member's own copy of a USDA FoodData Central food. */
  usda: z
    .object({ fdcId: z.number().int(), dataType: z.enum(["foundation", "sr_legacy"]), releaseLabel: z.string(), category: z.string().nullable() })
    .nullable()
    .default(null),
  portions: z.array(
    z.object({ id: z.string(), label: z.string(), amount: z.number(), unit: z.string(), grams: num, nutrients: nutrientMap }),
  ),
});
export type LoggableFood = z.infer<typeof loggableFoodSchema>;

export const recentFoodsSchema = z.array(
  z.object({
    entryId: z.string(),
    foodItemId: z.string().nullable(),
    name: z.string(),
    portion: portionSnapshot,
    quantity: z.number(),
    context: z.enum(CONTEXTS),
    mealSlot: z.string(),
    lastDate: z.string(),
    proteinG: num,
    proteinMethod: z.string().nullish(),
    proteinLow: num.optional(),
    proteinHigh: num.optional(),
  }),
);
export type RecentFood = z.infer<typeof recentFoodsSchema>[number];

/** One USDA FoodData Central food in search results. Values are USDA's own, per 100 g; null = not given. */
export const usdaSearchSchema = z.array(
  z.object({
    releaseId: z.string(),
    fdcId: z.number().int(),
    dataType: z.enum(["foundation", "sr_legacy"]),
    releaseLabel: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    proteinPer100g: num,
    energyPer100g: num,
    portionCount: z.number().int(),
  }),
);
export type UsdaFood = z.infer<typeof usdaSearchSchema>[number];

/** Form input for "Choose" on a USDA result. */
export const usdaChooseInputSchema = z.object({
  releaseId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  fdcId: z.coerce.number().int().positive().max(2147483647),
});

export const customFoodsSchema = z.array(
  z.object({
    foodItemId: z.string(),
    revisionId: z.string(),
    name: z.string(),
    brand: z.string().nullable(),
    proteinG: num,
    energyKcal: num,
    createdAt: z.string(),
  }),
);
export type CustomFood = z.infer<typeof customFoodsSchema>[number];

export const writeResultSchema = z.looseObject({
  entryId: z.string(),
  version: z.number().optional(),
  replayed: z.boolean().optional(),
  basis: z.enum(["current", "updated", "copied"]).optional(),
  foodItemId: z.string().nullish(),
});
export type WriteResult = z.infer<typeof writeResultSchema>;

/** One food of the member's own, as the change form shows it (docs/56). */
export const ownFoodSchema = z.object({
  foodItemId: z.string(),
  revisionId: z.string(),
  revisionNo: z.number(),
  name: z.string(),
  brand: z.string().nullable(),
  /** Only foods written down in the app (one serving as the basis) can be changed here. */
  editable: z.boolean(),
  serving: z.object({ label: z.string(), grams: num }).nullable(),
  nutrients: z.record(z.string(), num).nullable(),
  timesLogged: z.number(),
  createdAt: z.string(),
});
export type OwnFood = z.infer<typeof ownFoodSchema>;

/** A change to a food of one's own. Empty boxes are saved as "not known", never as zero. */
export const ownFoodUpdateInputSchema = z.object({
  foodItemId: uuid,
  expectedRevisionId: uuid,
  name: z.string().trim().min(1, "Give it a name").max(200, "Keep the name under 200 characters"),
  brand: z.string().trim().max(120, "Keep the brand under 120 characters").optional(),
  servingLabel: z.string().trim().max(80, "Keep this under 80 characters").optional(),
  servingGrams: optionalNutrient(5000),
  proteinG: optionalNutrient(1000),
  energyKcal: optionalNutrient(20000),
  carbG: optionalNutrient(2000),
  fatG: optionalNutrient(1000),
  fiberG: optionalNutrient(500),
});
export type OwnFoodUpdateInput = z.infer<typeof ownFoodUpdateInputSchema>;
export const ownFoodRemoveInputSchema = z.object({ foodItemId: uuid, remove: z.enum(["true", "false"]).transform((v) => v === "true") });
