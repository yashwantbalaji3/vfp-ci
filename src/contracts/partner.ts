import { z } from "zod";

/**
 * Restaurant submissions (docs/48). A claim's state comes from the latest ownership check a moderator
 * recorded; nothing a restaurant submits is public, and a verified dish is still not published.
 */
export const CLAIM_STATES = ["pending", "verified", "failed", "revoked", "withdrawn"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];
export const CLAIM_STATE_WORDS: Record<ClaimState, string> = {
  pending: "Waiting for an ownership check",
  verified: "Ownership checked",
  failed: "Ownership check failed",
  revoked: "Ownership withdrawn by a moderator",
  withdrawn: "Withdrawn by the restaurant",
};
export const CHECK_METHODS = ["email_at_restaurant_domain", "postal_code", "phone_public_number", "in_person"] as const;
export const CHECK_METHOD_WORDS: Record<(typeof CHECK_METHODS)[number], string> = {
  email_at_restaurant_domain: "Email reply from an address at the restaurant's own website domain",
  postal_code: "Code sent by post to the restaurant's address",
  phone_public_number: "Call to the restaurant's public phone number",
  in_person: "In person at the restaurant",
};
export const FLAG_WORDS: Record<string, string> = {
  vegan_statement_with_animal_ingredient_word: "Says vegan, but the ingredients or description name an animal product",
  vegetarian_statement_with_meat_or_fish_word: "Says vegetarian, but the ingredients or description name meat or fish",
  protein_energy_exceeds_calories: "Protein would supply more energy than the stated calories",
  nutrition_per_serving_without_serving_size: "Nutrition is per serving, but no serving size is given",
  no_allergen_statement: "No allergen statement",
};
export const NUTRIENT_WORDS: Record<string, string> = {
  energy_kcal: "Calories", protein_g: "Protein", carb_g: "Carbohydrate", fat_g: "Fat", fiber_g: "Fibre", sodium_mg: "Sodium", sugar_g: "Sugar",
};

const state = z.enum(CLAIM_STATES);
export const claimTargetSchema = z.object({ candidateId: z.string().uuid(), name: z.string(), street: z.string().nullable(), postcode: z.string().nullable(), myClaim: z.string().uuid().nullable() });
export const myClaimsSchema = z.array(z.object({
  claimId: z.string().uuid(), placeName: z.string(), placeStreet: z.string().nullable(), roleTitle: z.string(), contactEmail: z.string(), state, createdAt: z.string(),
  submissions: z.number().int(), dishes: z.number().int(), verified: z.number().int(), rejected: z.number().int(),
}));
export const licenceSchema = z.object({ version: z.string(), text: z.string() });
export const idSchema = z.object({ id: z.string().uuid() });
export const submitResultSchema = z.object({ id: z.string().uuid(), dishes: z.number().int(), flagged: z.number().int() });
export const stateResultSchema = z.object({ state });
export const decisionResultSchema = z.object({ decision: z.enum(["verified", "rejected"]) });
const check = z.object({ method: z.enum(CHECK_METHODS), outcome: z.enum(["passed", "failed", "revoked"]), evidence: z.string(), checkedAt: z.string() });
export const claimsOverviewSchema = z.array(z.object({
  claimId: z.string().uuid(), placeName: z.string(), placeStreet: z.string().nullable(), roleTitle: z.string(), contactEmail: z.string(), state, createdAt: z.string(),
  own: z.boolean(), latestCheck: check.nullable(),
}));
const amount = z.object({ amount: z.number(), unit: z.string(), per: z.string().optional() });
export const queueSchema = z.array(z.object({
  itemId: z.string().uuid(), placeName: z.string(), placeStreet: z.string().nullable(), claimantEmail: z.string(),
  ownership: z.object({ method: z.enum(CHECK_METHODS), evidence: z.string(), checkedAt: z.string() }).nullable(),
  licenceVersion: z.string(), fileName: z.string().nullable(), fileSha256: z.string(), documentDate: z.string().nullable(), submittedAt: z.string(),
  name: z.string(), section: z.string().nullable(), priceUsd: z.number().nullable(), serving: z.string().nullable(), servingGrams: z.number().nullable(),
  ingredients: z.string().nullable(), allergens: z.string().nullable(), crossContact: z.string().nullable(),
  dietary: z.array(z.object({ claim: z.enum(["vegan", "vegetarian"]), words: z.string() })), nutrition: z.record(z.string(), amount), flags: z.array(z.string()),
}));
export type MyClaim = z.infer<typeof myClaimsSchema>[number];
export type ClaimOverview = z.infer<typeof claimsOverviewSchema>[number];
export type QueueItem = z.infer<typeof queueSchema>[number];

const uuid = z.string().uuid();
export const claimInputSchema = z.object({
  candidateId: uuid,
  roleTitle: z.string().trim().min(2, "ROLE_REQUIRED").max(100),
  email: z.string().trim().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "EMAIL_REQUIRED"),
  confirmed: z.literal(true, { message: "CONFIRM_REQUIRED" }),
});
export const checkInputSchema = z.object({
  claimId: uuid,
  method: z.enum(CHECK_METHODS),
  outcome: z.enum(["passed", "failed", "revoked"]),
  evidence: z.string().trim().min(5, "EVIDENCE_REQUIRED").max(1000),
});
export const reviewInputSchema = z.object({ itemId: uuid, decision: z.enum(["verified", "rejected"]), note: z.string().trim().max(500).optional() });
export const MAX_FILE_BYTES = 512 * 1024;
