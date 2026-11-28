import { z } from "zod";
import { targetSchema } from "@/contracts/social";

/**
 * Shapes of the editor and moderator read models (R2, docs/11 "R2 as built").
 * These pages are for staff only; the database decides who may read them.
 */
const uuid = z.string().uuid();
const when = z.string();

export const FAMILIES = ["egg", "dairy", "honey", "gelatin", "animal_stock", "fish_sauce", "animal_rennet"] as const;
export const FAMILY_LABELS: Record<string, string> = {
  egg: "Egg", dairy: "Dairy", honey: "Honey", gelatin: "Gelatin", animal_stock: "Meat or fish stock", fish_sauce: "Fish sauce", animal_rennet: "Animal rennet",
};
export const NUTRIENTS = ["energy_kcal", "protein_g", "carb_g", "fat_g", "fiber_g", "sodium_mg"] as const;
export const NUTRIENT_LABELS: Record<string, string> = {
  energy_kcal: "Calories (kcal)", protein_g: "Protein (g)", carb_g: "Carbohydrate (g)", fat_g: "Fat (g)", fiber_g: "Fiber (g)", sodium_mg: "Sodium (mg)",
};
export const SOURCE_TYPES = ["operator_statement", "menu", "product_label", "curator_assessment", "original_recipe", "government_dataset"] as const;
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  operator_statement: "The place told us (staff, owner, email)",
  menu: "The place's own menu",
  product_label: "Product label",
  curator_assessment: "An editor's own assessment",
  original_recipe: "Our own original recipe",
  government_dataset: "Government food data",
  synthetic_fixture: "Invented test data",
  community_report: "A member's report",
  user_entered: "Entered by a member",
};
export const OUTCOME_LABELS: Record<string, string> = {
  compatible: "Suitable", incompatible: "Not suitable", conditional: "Only with a change", unknown: "Not known",
};
export const PRESENCE_LABELS: Record<string, string> = { present: "Contains", absent_by_statement: "Stated absent", unknown: "Not known" };
export const STATE_LABELS: Record<string, string> = {
  draft: "Draft", submitted: "Waiting for a second person", published: "Published", rejected: "Sent back", withdrawn: "Withdrawn",
};
export const GATE_LABELS: Record<string, string> = {
  rights_not_cleared: "A source used here has not been cleared for display.",
  dietary_claim_not_publishable: "A dietary statement is disputed or has no review date. Restate it from this change's source.",
  impossible_nutrient_value: "A nutrition value is larger than the amount of food it describes.",
  recipe_not_reviewed: "The recipe has no recorded trial cook.",
  claim_contradicts_ingredients: "A statement says “suitable” while an ingredient statement says it contains something that diet excludes.",
  recipe_incomplete: "The recipe needs at least one ingredient and one step.",
};

const dietary = z.object({ diet: z.string(), outcome: z.string(), evidenceTier: z.string(), modifications: z.string().nullish(), conflictState: z.string().nullish() });
const family = z.object({ family: z.string(), presence: z.string(), detail: z.string().nullish() });
const allergen = z.object({ allergen: z.string(), presence: z.string(), crossContact: z.string().nullish() });
const nutrient = z.object({ code: z.string(), value: z.number().nullable(), method: z.string(), missingReason: z.string().nullish() });
export const evidenceSchema = z.object({
  revisionId: uuid.nullish(),
  revisionNo: z.number().int().nullish(),
  name: z.string(),
  description: z.string().nullable(),
  publishedAt: when.nullish(),
  dietary: z.array(dietary),
  families: z.array(family),
  allergens: z.array(allergen).nullish().transform((v) => v ?? []),
  nutrients: z.array(nutrient),
  recipe: z
    .object({
      yieldServings: z.number(),
      prepMinutes: z.number().nullable(),
      cookMinutes: z.number().nullable(),
      trialCookedAt: when.nullable(),
      ingredients: z.array(z.object({ foodItemId: uuid, name: z.string(), quantity: z.number(), unit: z.string(), grams: z.number().nullable() })),
      steps: z.array(z.object({ instruction: z.string() })),
    })
    .nullable(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const changeSummarySchema = z.object({
  changeId: uuid,
  kind: z.enum(["food", "venue"]),
  isNew: z.boolean(),
  state: z.string(),
  summary: z.string().nullable(),
  target: z.object({ foodItemId: uuid.nullable(), venueId: uuid.nullable(), name: z.string().nullable(), kind: z.string().nullable(), venueName: z.string().nullish() }),
  author: z.string().nullable(),
  authorIsMe: z.boolean(),
  reviewer: z.string().nullable(),
  createdAt: when,
  submittedAt: when.nullable(),
  reviewedAt: when.nullable(),
  reviewNote: z.string().nullable(),
  touchesEvidence: z.boolean().nullable(),
  fromCorrection: z.boolean(),
  canEdit: z.boolean(),
  canReview: z.boolean(),
});
export type ChangeSummary = z.infer<typeof changeSummarySchema>;

const venuePayload = z
  .object({
    name: z.string().nullish(), neighborhood: z.string().nullish(), street: z.string().nullish(), locality: z.string().nullish(), region: z.string().nullish(),
    postalCode: z.string().nullish(), venueType: z.string().nullish(), status: z.string().nullish(), lat: z.number().nullish(), lon: z.number().nullish(),
    hours: z.string().nullish(), statusNote: z.string().nullish(),
    dish: z.object({ menuSection: z.string().nullish(), priceCents: z.number().nullish(), servingDescription: z.string().nullish() }).nullish(),
  })
  .passthrough();
export const changeSchema = changeSummarySchema.extend({
  correction: z.object({ correctionId: uuid, field: z.string(), proposedValue: z.string(), evidenceNote: z.string().nullable(), decisionNote: z.string().nullable() }).nullable(),
  source: z.object({ publisher: z.string(), sourceType: z.string(), url: z.string().nullable(), observedAt: when, summary: z.string().nullable(), rightsStatus: z.string() }).nullable(),
  base: evidenceSchema.nullable(),
  draft: evidenceSchema.nullable(),
  payload: venuePayload,
  currentVenue: z.record(z.string(), z.unknown()).nullable(),
  gate: z.array(z.string()),
  isDemo: z.boolean().nullable(),
  history: z.array(z.object({ action: z.string(), at: when, by: z.string().nullable(), note: z.string().nullable() })),
});
export type Change = z.infer<typeof changeSchema>;

/** NIE-A: a restaurant's own protein figure that differs from our calculation by more than the threshold. */
export const nutritionChecksSchema = z.array(
  z.object({
    checkId: uuid,
    foodItemId: uuid,
    name: z.string(),
    published: z.number(),
    calculated: z.number().nullable(),
    relativeGap: z.number().nullable(),
    threshold: z.number(),
    checkedAt: when,
  }),
);
export type NutritionChecks = z.infer<typeof nutritionChecksSchema>;

const target = targetSchema.nullable();
export const deskSchema = z.object({
  practiceMode: z.boolean(),
  canPublish: z.boolean(),
  myDrafts: z.array(changeSummarySchema),
  awaitingCheck: z.array(changeSummarySchema),
  recent: z.array(changeSummarySchema),
  acceptedCorrections: z.array(
    z.object({ correctionId: uuid, field: z.string(), proposedValue: z.string(), decidedAt: when.nullable(), foodItemId: uuid.nullable(), venueId: uuid.nullable(), target, openChangeId: uuid.nullable() }),
  ),
  flags: z.array(z.object({ flagId: uuid, foodItemId: uuid, name: z.string(), reason: z.string(), raisedAt: when, raisedBy: z.string().nullable(), openChangeId: uuid.nullable() })),
  outOfDate: z.array(z.object({ kind: z.string(), foodItemId: uuid.optional(), venueId: uuid.optional(), name: z.string(), checkedAt: when.nullable(), state: z.string() })),
});
export type Desk = z.infer<typeof deskSchema>;

export const itemsSchema = z.object({
  foods: z.array(
    z.object({ foodItemId: uuid, kind: z.string(), name: z.string(), isDemo: z.boolean(), venueName: z.string().nullable(), revisionNo: z.number().int(), publishedAt: when.nullable(), flagged: z.boolean(), openChangeId: uuid.nullable() }),
  ),
  venues: z.array(z.object({ venueId: uuid, name: z.string(), neighborhood: z.string().nullable(), status: z.string(), isDemo: z.boolean(), reviewedAt: when.nullable(), openChangeId: uuid.nullable() })),
  ingredients: z.array(z.object({ foodItemId: uuid, name: z.string() })),
});
export type EditorItems = z.infer<typeof itemsSchema>;

export const alertsSchema = z.object({
  isModerator: z.boolean(),
  isEditor: z.boolean(),
  canPublish: z.boolean(),
  pendingPosts: z.number().int().optional(),
  openReports: z.number().int().optional(),
  repeatedReports: z.number().int().optional(),
  suspendedMembers: z.number().int().optional(),
  openCorrections: z.number().int().optional(),
  acceptedNotApplied: z.number().int().optional(),
  awaitingCheck: z.number().int().optional(),
  myDrafts: z.number().int().optional(),
  needsReview: z.number().int().optional(),
});
export type StaffAlerts = z.infer<typeof alertsSchema>;

export const memberHistorySchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  isDemo: z.boolean(),
  isStaff: z.boolean(),
  suspendedAt: when.nullable(),
  suspendedReason: z.string().nullable(),
  profileHiddenAt: when.nullable(),
  firstPublicApprovedAt: when.nullable(),
  counts: z.record(z.string(), z.number().int()),
  events: z.array(z.object({ action: z.string(), type: z.string(), reason: z.string().nullable(), at: when, by: z.string().nullable() })),
});
export type MemberHistory = z.infer<typeof memberHistorySchema>;

export { freshnessMarksSchema as marksSchema, type FreshnessMark, type FreshnessMarks } from "./catalog";

export const myCorrectionsSchema = z.array(
  z.object({ correctionId: uuid, field: z.string(), proposedValue: z.string(), state: z.string(), sentAt: when, decidedAt: when.nullable(), applied: z.boolean(), target }),
);
export type MyCorrections = z.infer<typeof myCorrectionsSchema>;

/** A place's values as kept in its history (R2 fix-up). Missing means not recorded. */
const placeValues = z
  .object({
    name: z.string().nullish(), neighborhood: z.string().nullish(), street: z.string().nullish(), locality: z.string().nullish(),
    region: z.string().nullish(), postalCode: z.string().nullish(), venueType: z.string().nullish(), status: z.string().nullish(),
    lat: z.number().nullish(), lon: z.number().nullish(), hours: z.string().nullish(), statusNote: z.string().nullish(), reviewedAt: z.string().nullish(),
  })
  .passthrough();
export type PlaceValues = z.infer<typeof placeValues>;
export const venueHistorySchema = z.object({
  current: placeValues,
  revisions: z.array(
    z.object({
      revisionId: uuid, revisionNo: z.number().int(), changeId: uuid, before: placeValues.nullable(), after: placeValues,
      source: z.object({ publisher: z.string(), sourceType: z.string(), url: z.string().nullable(), observedAt: z.string(), summary: z.string().nullable(), rightsStatus: z.string() }).partial().passthrough(),
      author: z.string().nullable(), reviewer: z.string().nullable(), submittedAt: when.nullable(), publishedAt: when,
    }),
  ),
});
export type VenueHistory = z.infer<typeof venueHistorySchema>;
