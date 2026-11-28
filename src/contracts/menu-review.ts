import { z } from "zod";

/**
 * The founder's batch review of drafted real-menu facts (docs/58). Every fact keeps its source page,
 * the date it was checked and how sure the drafter was. Confirming checks a fact against its source;
 * it never publishes anything and never happens without the founder's explicit choice.
 */
export const FACT_KINDS = [
  "address",
  "operating_status",
  "weekly_hours",
  "menu_item",
  "price",
  "dietary_status",
  "allergen_statement",
  "published_nutrition",
  "serving_size",
  "listed_ingredients",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const factSchema = z.object({
  factId: z.string().uuid(),
  kind: z.enum(FACT_KINDS),
  subject: z.string().nullable(),
  value: z.record(z.string(), z.unknown()).nullable(),
  unknown: z.boolean(),
  unknownReason: z.string().nullable(),
  status: z.enum(["submitted", "verified"]),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  sourceId: z.string().uuid(),
  checkedOn: z.string(),
  access: z.enum(["cleared", "private_pilot", "pending", "prohibited"]),
  /** What confirming does: verify (cleared source), confirm the transcription only (private pilot), or nothing. */
  confirmAs: z.enum(["verify", "transcription"]).nullable(),
  canConfirm: z.boolean(),
  canReject: z.boolean(),
  /** Six separate statuses (owner approval 18 Nov 19:19 UTC). A confirmed transcription sets only the second. */
  statuses: z.object({
    extracted: z.boolean(),
    transcriptionConfirmed: z.boolean(),
    dietaryVerified: z.boolean(),
    nutritionVerified: z.boolean(),
    reuseEligible: z.boolean(),
    publicationApproved: z.boolean(),
  }),
  /**
   * What the private confirmation rested on: the founder's own comparison, or an automatic comparison
   * the founder accepted. Never shown as the founder's comparison when it was not. Null until confirmed.
   */
  confirmationBasis: z.enum(["founder", "automatic_comparison"]).nullable().optional(),
  /** The latest automatic comparison with the saved copy of the source page. It never confirms anything. */
  machineCheck: z
    .object({
      result: z.enum(["found", "not_found", "not_checked"]),
      detail: z.string(),
      pageSavedAt: z.string().nullable(),
      at: z.string(),
    })
    .nullable()
    .optional(),
  /** Owner decision D1 (22 Nov 2026): six states, each from its own record, never interchangeable. */
  ladder: z
    .object({
      extracted: z.boolean(),
      autoCompared: z.enum(["found", "not_found", "not_checked"]),
      independentlyReviewed: z.boolean(),
      founderConfirmed: z.boolean(),
      rightsEligible: z.boolean(),
      published: z.boolean(),
    })
    .optional(),
});
export type MenuFact = z.infer<typeof factSchema>;

/** The six publication states (D1), in order, with the words the founder sees. */
export const LADDER_STEPS = [
  { key: "extracted", words: "Drafted automatically from a named source page" },
  { key: "autoCompared", words: "Found on the saved source page by the automatic comparison" },
  { key: "independentlyReviewed", words: "Reviewed by a second person (not who drafted it)" },
  { key: "founderConfirmed", words: "Confirmed by you" },
  { key: "rightsEligible", words: "Source rights allow reuse" },
  { key: "published", words: "Published" },
] as const;
export type LadderKey = (typeof LADDER_STEPS)[number]["key"];

/** Whether one fact has reached one state. A fact without ladder data has reached none but "extracted". */
export function ladderReached(f: Pick<MenuFact, "ladder">, key: LadderKey): boolean {
  if (key === "extracted") return true;
  const l = f.ladder;
  if (!l) return false;
  return key === "autoCompared" ? l.autoCompared === "found" : l[key];
}

/** How many facts have reached each state. Counts are separate: they are never added together. */
export function ladderCounts(facts: Pick<MenuFact, "ladder">[]): Record<LadderKey, number> {
  const out = Object.fromEntries(LADDER_STEPS.map((s) => [s.key, 0])) as Record<LadderKey, number>;
  for (const f of facts) for (const s of LADDER_STEPS) if (ladderReached(f, s.key)) out[s.key] += 1;
  return out;
}
/** The note saved with a group confirmation, saying what it rested on. The database reads the prefix. */
export const BASIS_NOTES = {
  founder: "Basis: founder compared with the source.",
  automatic_comparison: "Basis: automatic comparison accepted by the founder; not compared by hand.",
} as const;

/** What a dish is (owner direction 18 Nov 19:19 UTC): only complete and build-your-own meals are meals. */
export const DISH_TYPES = [
  "complete_meal",
  "customizable_meal",
  "component",
  "base",
  "protein",
  "topping_sauce",
  "side",
  "beverage",
  "dessert",
] as const;
export type DishType = (typeof DISH_TYPES)[number];
/** A tray or platter for a group (a catering section, "serves 20"): a complete dish, but not one person's meal. */
const GROUP_PLATTER = /\bcater|\b(serves|feeds|cater)\s+\d{2,}\b|\bplatters?\b.*\bpeople\b/i;
export const isGroupPlatter = (d: Pick<MenuDish, "structure">) =>
  GROUP_PLATTER.test(d.structure?.section ?? "") || GROUP_PLATTER.test(d.structure?.portion ?? "");

export const MEAL_TYPES: readonly DishType[] = ["complete_meal", "customizable_meal"];
export const DISH_TYPE_WORDS: Record<DishType, string> = {
  complete_meal: "Complete meal",
  customizable_meal: "Build-your-own meal",
  component: "Part of a meal",
  base: "Base",
  protein: "Protein choice",
  topping_sauce: "Topping or sauce",
  side: "Side",
  beverage: "Drink",
  dessert: "Dessert",
};
const structureSchema = z
  .object({
    type: z.enum(DISH_TYPES),
    parentDishId: z.string().uuid().nullable(),
    section: z.string().nullable(),
    portion: z.string().nullable(),
    basis: z.enum(["source_section", "source_label", "person"]),
    evidence: z.string().nullable(),
  })
  .nullable();
const optionSchema = z.object({
  kind: z.enum(["add", "remove", "swap", "size"]),
  label: z.string(),
  componentDishId: z.string().uuid().nullable(),
  priceDeltaUsd: z.string().nullable(),
  sourceId: z.string().uuid(),
});

/**
 * A USDA-based protein estimate for a complete meal with no protein figure from the restaurant
 * (owner direction 18 Nov 20:56 UTC). It rests on typical amounts written down by research, never on
 * the restaurant's quantities, and stays apart from published nutrition. "unknown" carries the reason.
 * The model behind it is a draft until a second person reviews its assumptions.
 */
const num = z.coerce.number();
const estimateSchema = z
  .discriminatedUnion("state", [
    z.object({ state: z.literal("unknown"), reason: z.string(), at: z.string() }),
    z.object({
      state: z.literal("modelled"),
      modelId: z.string().uuid(),
      evidence: z.enum(["listed_ingredients", "dish_name", "listed_ingredients_and_dish_name"]),
      at: z.string(),
      modelStatus: z.enum(["draft", "published"]),
      assumptions: z.string().nullable(),
      servingBasis: z.string(),
      lines: z
        .array(
          z.object({
            label: z.string(),
            fdcId: z.number().int(),
            usda: z.string(),
            release: z.string(),
            grams: num,
            gramsLow: num,
            gramsHigh: num,
            amountBasis: z.string(),
          }),
        )
        .nullable()
        .transform((l) => l ?? []),
      result: z.object({
        state: z.enum(["calculated", "estimated", "unknown"]),
        central: num.nullable(),
        low: num.nullable(),
        high: num.nullable(),
        confidence: z.enum(["high", "medium", "low"]).nullable(),
        reason: z.string().nullable(),
      }),
    }),
  ])
  .nullable();
export type MenuEstimate = NonNullable<z.infer<typeof estimateSchema>>;

const ESTIMATE_REASON_WORDS: Record<string, string> = {
  range_too_wide: "the likely range is too wide to be useful (more than twice as much at the top as at the bottom)",
  missing_reference_value: "an ingredient has no USDA protein value",
  missing_yield_factor: "an ingredient needs a cooked-to-raw conversion that is not on file",
};
/** The estimate in words, whole grams, always as a range and always labelled. */
export function estimateWords(e: MenuEstimate): string {
  if (e.state === "unknown") return `USDA estimate: unknown. ${e.reason}`;
  const r = e.result;
  if (r.state === "unknown") return `USDA estimate: unknown, because ${ESTIMATE_REASON_WORDS[r.reason ?? ""] ?? "the model is incomplete"}.`;
  if (r.low === null || r.high === null) return "USDA estimate: unknown.";
  const lo = Math.floor(r.low);
  const hi = Math.ceil(r.high);
  return `USDA estimate: about ${lo} to ${hi} g protein (typical amounts, ${r.confidence ?? "low"} confidence; not the restaurant's figure)`;
}
/** The meal has a protein figure from the restaurant itself (any basis), which always wins over an estimate. */
export const hasRestaurantProtein = (d: Pick<MenuDish, "facts">) =>
  d.facts.some((f) => f.kind === "published_nutrition" && f.subject === "protein_g" && !f.unknown && f.value !== null);

export const menuPlaceSchema = z.object({
  placeId: z.string().uuid(),
  label: z.string(),
  area: z.string(),
  city: z.string(),
  sources: z.array(
    z.object({
      sourceId: z.string().uuid(),
      url: z.string(),
      host: z.string(),
      kind: z.string(),
      publisher: z.string(),
      retrievedAt: z.string(),
      access: z.enum(["cleared", "private_pilot", "pending", "prohibited"]),
    }),
  ),
  placeFacts: z.array(factSchema),
  dishes: z.array(
    z.object({
      dishId: z.string().uuid(),
      label: z.string(),
      structure: structureSchema.default(null),
      options: z.array(optionSchema).default([]),
      estimate: estimateSchema.default(null),
      facts: z.array(factSchema),
      corrections: z.array(
        z.object({
          kind: z.string(),
          subject: z.string().nullable(),
          corrected: z.unknown(),
          at: z.string(),
        }),
      ),
    }),
  ),
});
export type MenuPlace = z.infer<typeof menuPlaceSchema>;
export type MenuDish = MenuPlace["dishes"][number];

export const menuPlacesSchema = z.array(
  z.object({
    placeId: z.string().uuid(),
    label: z.string(),
    area: z.string(),
    city: z.string(),
    dishes: z.number().int(),
    ready: z.number().int(),
    held: z.number().int(),
    transcribed: z.number().int(),
    privatePilot: z.boolean().nullable(),
    confirmed: z.number().int(),
    rejected: z.number().int(),
  }),
);
export type MenuPlaceRow = z.infer<typeof menuPlacesSchema>[number];

export const menuDecideResultSchema = z.object({
  verified: z.number().int(),
  rejected: z.number().int(),
  transcribed: z.number().int(),
});

/** A row decision from the form. "later" records nothing. */
export const ROW_CHOICES = ["confirm", "reject", "later"] as const;
export type RowChoice = (typeof ROW_CHOICES)[number];

/**
 * Turn the founder's row choices into one explicit decision per fact. Only facts the founder may
 * decide are included (canConfirm for a confirm, canReject for a reject); a row left on "later"
 * adds nothing. The database checks every decision again.
 */
export function rowDecisions(
  dishes: MenuDish[],
  choices: Record<string, RowChoice | undefined>,
  note?: string,
) {
  const out: {
    factId: string;
    decision: "verify" | "reject" | "confirm_transcription";
    note?: string;
  }[] = [];
  for (const d of dishes) {
    const c = choices[d.dishId];
    if (c === "confirm")
      for (const f of d.facts)
        if (f.canConfirm && f.confirmAs)
          out.push({
            factId: f.factId,
            decision:
              f.confirmAs === "verify" ? "verify" : "confirm_transcription",
            ...(note ? { note } : {}),
          });
    if (c === "reject")
      for (const f of d.facts)
        if (f.canReject)
          out.push({
            factId: f.factId,
            decision: "reject",
            ...(note ? { note } : {}),
          });
  }
  return out;
}

/** Can the founder confirm this whole row? Only when every waiting fact in it can be confirmed. */
const waitingFacts = (d: MenuDish) =>
  d.facts.filter(
    (f) => f.status === "submitted" && !f.statuses.transcriptionConfirmed,
  );
export const rowConfirmable = (d: MenuDish) => {
  const waiting = waitingFacts(d);
  return waiting.length > 0 && waiting.every((f) => f.canConfirm);
};
export const rowWaiting = (d: MenuDish) => waitingFacts(d).length > 0;
/** A private-pilot row: confirming checks the transcription only and can never make it public. */
export const rowPrivatePilot = (d: MenuDish) =>
  d.facts.some((f) => f.access === "private_pilot");

/** The corrected value the founder types, by kind. Returns null when the input does not fit. */
export function correctionValue(
  kind: FactKind,
  subject: string | null,
  input: Record<string, string | undefined>,
): Record<string, unknown> | null {
  const s = (k: string) => (input[k] ?? "").trim();
  switch (kind) {
    case "price":
      return /^[0-9]{1,4}(\.[0-9]{2})?$/.test(s("usd"))
        ? { usd: s("usd") }
        : null;
    case "menu_item":
      return s("listed") === "true" || s("listed") === "false"
        ? { listed: s("listed") === "true" }
        : null;
    case "dietary_status":
      return subject && (s("status") === "yes" || s("status") === "no")
        ? { claim: subject, status: s("status") }
        : null;
    case "published_nutrition":
      return subject &&
        /^[0-9]+(\.[0-9]+)?$/.test(s("amount")) &&
        (s("per") === "serving" || s("per") === "100g")
        ? { nutrient: subject, amount: s("amount"), per: s("per") }
        : null;
    case "serving_size":
      return /^[0-9]+(\.[0-9]+)?$/.test(s("grams")) && Number(s("grams")) > 0
        ? { grams: s("grams") }
        : null;
    case "listed_ingredients": {
      const items = s("items")
        .split(/[,\n]/)
        .map((x) => x.trim())
        .filter(Boolean);
      return items.length >= 1 &&
        items.length <= 40 &&
        items.every((x) => x.length <= 80)
        ? { items }
        : null;
    }
    default:
      return null;
  }
}
export const CORRECTABLE: FactKind[] = [
  "price",
  "menu_item",
  "dietary_status",
  "published_nutrition",
  "serving_size",
  "listed_ingredients",
];

const NUTRIENT_WORDS: Record<string, string> = {
  protein_g: "Protein",
  energy_kcal: "Calories",
  fat_g: "Fat",
  carb_g: "Carbohydrate",
  fiber_g: "Fiber",
  sodium_mg: "Sodium",
};
const UNIT: Record<string, string> = {
  protein_g: "g",
  energy_kcal: "kcal",
  fat_g: "g",
  carb_g: "g",
  fiber_g: "g",
  sodium_mg: "mg",
};

/** One fact in plain words, exactly as drafted. Unknown stays "Not stated". */
export function factWords(
  f: Pick<MenuFact, "kind" | "subject" | "value" | "unknown" | "unknownReason">,
): string {
  if (f.unknown || !f.value)
    return `Not stated${f.unknownReason ? ` (${f.unknownReason})` : ""}`;
  const v = f.value as Record<string, unknown>;
  switch (f.kind) {
    case "price":
      return `$${String(v.usd)}`;
    case "menu_item":
      return String(v.listed) === "true" ? "On the menu" : "Not on the menu";
    case "dietary_status":
      return `${String(v.claim) === "vegan" ? "Vegan" : String(v.claim) === "vegetarian" ? "Vegetarian" : "Egg-free"}: ${String(v.status) === "yes" ? "yes, stated by the restaurant" : "no"}`;
    case "published_nutrition": {
      const name = NUTRIENT_WORDS[String(v.nutrient)] ?? String(v.nutrient);
      const unit = UNIT[String(v.nutrient)] ?? "";
      const per = `per ${String(v.per) === "100g" ? "100 g" : v.portion ? String(v.portion) : "serving"}`;
      if (v.basis === "published_range")
        return `${name} ${String(v.low)} to ${String(v.high)} ${unit} ${per} (published range, not one value)`;
      if (v.basis === "restaurant_estimate")
        return `${name} ${String(v.amount)} ${unit} ${per} (the restaurant's own estimate)`;
      return `${name} ${String(v.amount)} ${unit} ${per} (published)`;
    }
    case "serving_size":
      return `${String(v.grams)} g serving`;
    case "listed_ingredients":
      return Array.isArray(v.items)
        ? (v.items as unknown[]).map(String).join(", ")
        : "";
    case "allergen_statement":
      return `${String(v.statement).replace("_", " ")}: ${Array.isArray(v.allergens) ? (v.allergens as unknown[]).map(String).join(", ") : ""}`;
    case "address":
      return `${String(v.street)} ${String(v.postcode)}`;
    case "operating_status":
      return String(v.status).replace("_", " ");
    default:
      return "See source";
  }
}

export const KIND_WORDS: Record<FactKind, string> = {
  address: "Address",
  operating_status: "Open?",
  weekly_hours: "Hours",
  menu_item: "On menu",
  price: "Price",
  dietary_status: "Diet",
  allergen_statement: "Allergens",
  published_nutrition: "Published nutrition",
  serving_size: "Serving",
  listed_ingredients: "Listed ingredients",
};

const AREA_WORDS: Record<string, string> = {
  central_square: "Central Square",
  harvard_square: "Harvard Square",
  kendall_square: "Kendall Square",
  inman_square: "Inman Square",
  porter_square: "Porter Square",
  west_cambridge: "West Cambridge",
  back_bay: "Back Bay",
  fenway_kenmore: "Fenway / Kenmore",
  longwood: "Longwood",
  mission_hill: "Mission Hill",
  south_end: "South End",
  downtown: "Downtown",
  chinatown: "Chinatown",
  beacon_hill: "Beacon Hill",
  allston_brighton: "Allston-Brighton",
  seaport: "Seaport",
  east_boston: "East Boston",
};
export const areaWords = (a: string) => AREA_WORDS[a] ?? a;

const CLAIM_WORDS: Record<string, string> = {
  vegan: "Vegan",
  vegetarian: "Vegetarian",
  egg_free: "Egg-free",
};
/** The label for one fact: the claim or nutrient it is about, for the kinds that have one. */
export function factLabel(f: Pick<MenuFact, "kind" | "subject">): string {
  if (f.kind === "dietary_status" && f.subject)
    return CLAIM_WORDS[f.subject] ?? f.subject;
  if (f.kind === "published_nutrition" && f.subject)
    return `${NUTRIENT_WORDS[f.subject] ?? f.subject} (published)`;
  return KIND_WORDS[f.kind];
}
