import { z } from "zod";

/**
 * Community evidence (owner directive 24 Nov 2026 14:59 UTC, priority 2B; migration 20261124000300). A suggestion is a
 * lead for research, never a fact: nothing here sets a diet, price, nutrition figure or publication state.
 */
export const KINDS = [
  { v: "missing_dish", label: "A vegetarian or vegan dish we're missing", short: "Missing dish", needsPlace: true },
  { v: "diet_info", label: "What the restaurant says about a dish's diet", short: "Diet information", needsPlace: true },
  { v: "ingredients", label: "A dish's ingredients", short: "Ingredients", needsPlace: true },
  { v: "menu_correction", label: "Something on the menu is wrong", short: "Menu correction", needsPlace: true },
  { v: "price", label: "A price that has changed", short: "Price", needsPlace: true },
  { v: "nutrition_source", label: "Where the restaurant publishes nutrition", short: "Nutrition source", needsPlace: true },
  { v: "stale_menu", label: "The menu we show is out of date", short: "Out-of-date menu", needsPlace: true },
  { v: "branch_correction", label: "This branch's details are wrong (address, closed, moved)", short: "Branch correction", needsPlace: true },
  { v: "duplicate_restaurant", label: "This restaurant is listed twice", short: "Listed twice", needsPlace: true },
  { v: "missing_restaurant", label: "A restaurant we're missing", short: "Missing restaurant", needsPlace: false },
] as const;
export type Kind = (typeof KINDS)[number]["v"];
export const kindLabel = (k: string) => KINDS.find((x) => x.v === k)?.short ?? "Suggestion";

export const SOURCES = [
  { v: "restaurant_website", label: "The restaurant's own website" },
  { v: "printed_menu", label: "The printed menu or menu board" },
  { v: "asked_staff", label: "I asked the staff" },
  { v: "restaurant_social", label: "The restaurant's own social media" },
  { v: "packaging", label: "The packaging or label" },
  { v: "other", label: "Somewhere else (say where in the note)" },
] as const;
export const sourceLabel = (s: string | undefined) => SOURCES.find((x) => x.v === s)?.label ?? "Not given";

export const DIET_CLAIMS = [
  { v: "vegan", label: "Says it is vegan" },
  { v: "vegetarian", label: "Says it is vegetarian" },
  { v: "egg_free", label: "Says it has no egg" },
  { v: "dairy_free", label: "Says it has no dairy" },
  { v: "contains_egg", label: "Says it contains egg" },
  { v: "contains_dairy", label: "Says it contains dairy" },
  { v: "contains_meat_or_fish", label: "Says it contains meat or fish" },
] as const;

export const FIELDS = [
  { v: "name", label: "The dish name" },
  { v: "description", label: "The description" },
  { v: "section", label: "The menu section" },
  { v: "available", label: "It's no longer served" },
  { v: "other", label: "Something else" },
] as const;

export const BRANCH_FIELDS = [
  { v: "address", label: "The address is wrong" },
  { v: "closed", label: "It has closed" },
  { v: "moved", label: "It has moved" },
  { v: "other", label: "Something else" },
] as const;

export const TERMS_VERSION = "community-evidence-v1";

const short = (max: number) => z.string().trim().max(max);
const optional = (s: z.ZodString) => s.optional().transform((v) => (v ? v : undefined));
const url = z.string().trim().regex(/^https?:\/\/\S{3,500}$/, "Enter a web address starting with http:// or https://");
const today = () => new Date().toISOString().slice(0, 10);

/** One schema per kind, matching public.community_submission_valid. Empty fields are dropped. */
export const detailsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing_restaurant"), name: short(120).min(2), street: optional(short(160)), area: optional(short(80)), website: url.optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("missing_dish"), dish: short(200).min(2), diet: z.enum(["vegan", "vegetarian", "not_stated"]), quote: optional(short(300)), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), url: url.optional().or(z.literal("").transform(() => undefined)), seenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today()).optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("diet_info"), dish: optional(short(200)), diet: z.enum(DIET_CLAIMS.map((d) => d.v) as [string, ...string[]]), quote: short(300).min(3), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), url: url.optional().or(z.literal("").transform(() => undefined)), seenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today()).optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("ingredients"), dish: optional(short(200)), ingredients: short(1000).min(3), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), url: url.optional().or(z.literal("").transform(() => undefined)), seenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today()).optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("menu_correction"), dish: optional(short(200)), field: z.enum(FIELDS.map((f) => f.v) as [string, ...string[]]), wrong: optional(short(300)), right: short(300).min(1), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), url: url.optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("price"), dish: optional(short(200)), price: z.string().trim().regex(/^\d{1,4}(\.\d{2})?$/, "Enter a price like 12.50"), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), seenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today()).optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("stale_menu"), note: short(500).min(3), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), url: url.optional().or(z.literal("").transform(() => undefined)), seenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today()).optional().or(z.literal("").transform(() => undefined)) }),
  z.object({ kind: z.literal("branch_correction"), field: z.enum(BRANCH_FIELDS.map((f) => f.v) as [string, ...string[]]), wrong: optional(short(300)), right: short(300).min(2), source: z.enum(SOURCES.map((s) => s.v) as [string, ...string[]]), url: url.optional().or(z.literal("").transform(() => undefined)), seenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => d <= today()).optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("duplicate_restaurant"), right: short(200).min(2), url: url.optional().or(z.literal("").transform(() => undefined)), note: optional(short(500)) }),
  z.object({ kind: z.literal("nutrition_source"), dish: optional(short(200)), url, protein: z.string().trim().regex(/^\d{1,3}(\.\d)?$/).optional().or(z.literal("").transform(() => undefined)), unit: z.enum(["per_serving", "per_100g"]).optional(), note: optional(short(500)) }),
]);
export type Details = z.infer<typeof detailsSchema>;

/** The JSON stored for one suggestion: the kind is a column, not a detail, and empty fields are left out. */
export function detailsJson(d: Details): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (k !== "kind" && typeof v === "string" && v !== "") out[k] = v;
  if (d.kind === "nutrition_source" && !out.protein) delete out.unit;
  return out;
}

export const submissionSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  status: z.enum(["submitted", "useful_lead", "needs_more", "not_used", "withdrawn"]),
  details: z.record(z.string(), z.string()),
  listingId: z.string().uuid().nullable(),
  dishId: z.string().uuid().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.string(),
});
export type Submission = z.infer<typeof submissionSchema>;

export const queueItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  status: z.string(),
  details: z.record(z.string(), z.string()),
  contributor: z.string(),
  listing: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), street: z.string(), area: z.string().nullable() }).nullable(),
  dish: z.object({ id: z.string().uuid(), label: z.string() }).nullable(),
  samePlace: z.number(),
  /** Other open suggestions about the same thing, from anyone (migration 20261124000600). */
  duplicates: z.number().default(0),
  /** For a suggestion about a dish: what our drafted facts say now (migration 20261125000200). */
  current: z.object({ diet: z.record(z.string(), z.string()), price: z.string().nullable(), ingredientsListed: z.boolean() }).nullable().default(null),
  /** Where the suggestion disagrees with those facts, as codes (see CONFLICT_WORDS). */
  conflicts: z.array(z.string()).default([]),
  /** Always false: a suggestion is a lead, never published or turned into a fact by itself. */
  publicationEligible: z.literal(false).default(false),
  history: z.array(z.object({ from: z.string().nullable(), to: z.string(), note: z.string().nullable(), by: z.enum(["contributor", "founder"]), at: z.string() })).default([]),
  /** For a missing restaurant: listings with the same name already in the directory. */
  alreadyListed: z.array(z.object({ slug: z.string(), name: z.string(), street: z.string().nullable(), market: z.string().nullable() })).nullable().default(null),
  reviewNote: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const STATUS_WORDS: Record<string, string> = {
  submitted: "Waiting for review",
  useful_lead: "Useful lead: we'll check it at the source",
  needs_more: "Needs more detail",
  not_used: "Not used",
  withdrawn: "Withdrawn",
};

export const CONFLICT_WORDS: Record<string, string> = {
  says_vegan_menu_says_no: "Says vegan, but our draft of the menu says not vegan",
  says_vegetarian_menu_says_no: "Says vegetarian, but our draft of the menu says not vegetarian",
  says_contains_egg_menu_says_vegan: "Says it contains egg, but our draft says vegan",
  says_contains_dairy_menu_says_vegan: "Says it contains dairy, but our draft says vegan",
  says_meat_or_fish_menu_says_suitable: "Says it contains meat or fish, but our draft says vegetarian or vegan",
  price_differs: "A different price from our draft",
};
